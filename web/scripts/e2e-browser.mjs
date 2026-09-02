import { spawn } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3001";
const errors = [];
let alicePage = null;
const enc = new TextEncoder();
const INFO_AUTH = enc.encode("runa/v1/auth");
const INFO_CONTENT = enc.encode("runa/v1/content");

const b64 = (b) => Buffer.from(b).toString("base64");

async function hkdf(ikm, salt, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

function waitForProcessExit(proc) {
  return new Promise((resolve) => proc.once("exit", resolve));
}

async function main() {
  const server = spawn(`${process.cwd()}/../target/release/runa-server`, [], {
    env: { ...process.env, RUNA_DIST: "dist", RUNA_BIND: "127.0.0.1:3001" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  server.stdout.on("data", (d) => serverLog.push(d.toString()));
  server.stderr.on("data", (d) => serverLog.push(d.toString()));
  const killServer = () => { try { server.kill(); } catch {} };
  process.on("exit", killServer);
  process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); killServer(); process.exit(1); });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 5000);
    const poll = setInterval(async () => {
      try { await fetch(`${BASE}/version`); clearInterval(poll); clearTimeout(t); resolve(); } catch {}
    }, 150);
  });

  // Create an unlisted room with keys the pages will receive via fragment.
  const linkSecret = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const authKey = await hkdf(linkSecret, salt, INFO_AUTH, 32);
  const verifier = createHash("sha256").update(authKey).digest().toString("base64");
  const createRes = await fetch(`${BASE}/api/rooms/unlisted`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      verifier,
      kdf: { m_kib: 65536, t: 3, p: 1, salt: b64(salt) },
      ttl: { kind: "idle-peers", secs: 3600 },
    }),
  });
  if (createRes.status !== 201) throw new Error(`create failed ${createRes.status}`);
  // The server assigns the id.
  const roomIdHex = (await createRes.json()).room_id;

  const b64url = (b) => Buffer.from(b).toString("base64url");
  const roomUrl = `${BASE}/r/${roomIdHex}#k=${b64url(linkSecret)}&s=${b64url(salt)}`;

  const browser = await chromium.launch();

  async function makePage(label) {
    const page = await browser.newPage();
    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "error") errors.push(`[${label}] console.error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => errors.push(`[${label}] pageerror: ${err.message}`));
    return page;
  }

  const alice = await makePage("alice");
  alicePage = alice;
  await alice.goto(roomUrl, { waitUntil: "domcontentloaded" });

  // Wait for editor to mount (proves CSP + Trusted Types + WASM all survived)
  await alice.waitForSelector(".monaco-editor", { timeout: 60_000 });
  await alice.waitForSelector("textarea.inputarea", { timeout: 15_000 });
  await alice.click(".monaco-editor .view-lines");
  await alice.keyboard.type("Hello from Alice. ");

  const bob = await makePage("bob");
  await bob.goto(roomUrl, { waitUntil: "domcontentloaded" });
  await bob.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await bob.click(".monaco-editor .view-lines");
  await bob.keyboard.type("And Bob agrees.");

  // Convergence: Alice's editor must eventually contain Bob's sentence.
  let converged = false;
  for (let i = 0; i < 40 && !converged; i++) {
    const text = await alice.evaluate(() => document.querySelector(".pane-preview .preview-body")?.textContent ?? "");
    if (text.includes("Bob agrees")) converged = true;
    else await new Promise((r) => setTimeout(r, 250));
  }
  if (!converged) {
    const text = await alice.evaluate(() => document.querySelector(".pane-preview .preview-body")?.textContent ?? "");
    throw new Error(`convergence failed; preview shows: "${text.slice(0, 200)}"`);
  }

  // Status bar should show 2 peers on both pages
  for (const [label, page] of [["alice", alice], ["bob", bob]]) {
    const peers = await page.evaluate(() =>
      [...document.querySelectorAll(".statusbar .micro-label")].map((e) => e.textContent).join("|"),
    );
    if (!peers.includes("2 PEOPLE")) throw new Error(`[${label}] expected a 2-person count in status bar, got: ${peers}`);
  }

  // Shred modal opens and shows the honest limitation copy
  await alice.click('button:has-text("Shred")');
  await alice.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
  const modalText = await alice.textContent('[role="alertdialog"]');
  if (!modalText.includes("It cannot reach copies other people already made")) {
    throw new Error("shred modal missing §2.5 limitation copy");
  }
  await alice.click('[role="alertdialog"] button:has-text("Cancel")');

  // Tombstone reachable and header-clean
  const gone = await fetch(`${BASE}/gone.html`);
  if (!gone.headers.get("clear-site-data")) throw new Error("gone.html missing Clear-Site-Data");

  const cspViolations = errors.filter((e) => /Content Security Policy|trustedTypes|Refused to/i.test(e));
  if (cspViolations.length > 0) {
    console.error("CSP/TT VIOLATIONS:");
    for (const e of cspViolations.slice(0, 10)) console.error(" ", e);
    throw new Error(`${cspViolations.length} CSP/Trusted-Types violations`);
  }

  await browser.close();
  server.kill();
  await waitForProcessExit(server);

  console.log("BROWSER E2E OK");
  console.log(`  two headless peers joined ${roomIdHex.slice(0, 8)}…`);
  console.log(`  typed concurrently; Alice's preview converged to include Bob's text`);
  console.log(`  status bars showed a 2-person count on both sides`);
  console.log(`  shred modal showed the honest-limitation copy; cancel works`);
  console.log(`  gone.html served with Clear-Site-Data`);
  console.log(`  zero CSP / Trusted-Types violations across both sessions`);
  process.exit(0);
}

main().catch(async (e) => {
  console.error("BROWSER E2E FAILED:", e.message);
  if (alicePage && !alicePage.isClosed()) {
    try {
      const body = await alicePage.evaluate(() =>
        document.body.innerHTML.replace(/\s+/g, " ").slice(0, 400),
      );
      console.error("ALICE BODY:", body);
      console.error("ALICE URL:", alicePage.url());
    } catch {}
  }
  for (const err of errors.slice(0, 8)) console.error(" captured:", err);
  process.exit(1);
});
