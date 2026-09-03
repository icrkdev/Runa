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

  // Guards against horizontal scroll on the landing page at phone widths.
  //
  // Scope, honestly: this catches fixed widths, wide tables and unbreakable
  // strings. It does NOT catch the bug that prompted it. On iOS Safari a
  // <select> grows to fit its longest <option> and drags the page sideways;
  // Chromium clamps it — headless and under device emulation alike — so the
  // failure is unreproducible here. Measured: the same page that scrolled
  // 214px sideways on a real iPhone reports zero overflow in this engine.
  //
  // The CSS fix (width:100% on form controls) is correct by construction
  // rather than by this test. Left in place because the class of bug is
  // common and the check is nearly free.
  const landing = await makePage("landing");
  for (const width of [320, 375, 414]) {
    await landing.setViewportSize({ width, height: 780 });
    await landing.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await landing.waitForSelector(".landing", { timeout: 5000 });
    const m = await landing.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const offenders = [];
      for (const el of document.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1) {
          offenders.push(`${el.tagName.toLowerCase()}.${String(el.className || "").split(" ")[0]}=${Math.round(r.right)}px`);
        }
      }
      return { vw, scrollW: document.documentElement.scrollWidth, offenders: offenders.slice(0, 5) };
    });
    if (m.scrollW > m.vw + 1) {
      throw new Error(
        `[landing] scrolls sideways at ${width}px (content ${m.scrollW}px): ${m.offenders.join(", ")}`,
      );
    }
  }
  // Vertical companion to the check above, and a different failure entirely:
  // content stranded ABOVE the scroll origin, which no scrolling can reach
  // because scrollTop stops at 0. .landing centres itself with
  // justify-content:center inside #root, which is `height: 100%` — so once
  // the named-room form expands past the viewport, .landing is a flex item
  // with negative free space, gets shrunk, and min-height:100dvh clamps it at
  // exactly one viewport while its content is taller. Centring then splits
  // that overflow evenly top and bottom. On a phone it reads as "scrolls down
  // but not up", with the masthead sliced through by the top of the screen.
  //
  // Unlike the sideways guard above, this one DOES reproduce in Chromium:
  // verified by reverting the fix, which puts .masthead at -90px at 375x812.
  // This check is load-bearing, not decorative — it is checked in the
  // expanded state on purpose, because the default state never overflows and
  // measuring only that is what let the bug through.
  for (const [width, height] of [[320, 568], [375, 667], [375, 812], [414, 896]]) {
    await landing.setViewportSize({ width, height });
    await landing.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await landing.waitForSelector(".landing", { timeout: 5000 });
    await landing.click("text=Shared name");
    await landing.waitForSelector("text=Create shared room", { timeout: 5000 });
    const stranded = await landing.evaluate(() => {
      document.scrollingElement.scrollTop = 0;
      const above = [];
      for (const el of document.querySelectorAll(".landing, .landing *")) {
        const r = el.getBoundingClientRect();
        const cls = String(el.className || "").split(" ")[0];
        if (r.height > 0 && cls !== "ambient-field" && r.top < -1) {
          above.push(`${el.tagName.toLowerCase()}.${cls}@${Math.round(r.top)}px`);
        }
      }
      return above.slice(0, 5);
    });
    if (stranded.length > 0) {
      throw new Error(
        `[landing] named-room form strands content above the scroll origin at ${width}x${height}: ${stranded.join(", ")}`,
      );
    }
  }

  await landing.close();

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

  // The dialog is a confirmation step, not a progress display. Everything
  // gated on the IDLE state — the consensus policy selector above all — has
  // to be on screen when it opens. It previously was not: pressing Shred
  // proposed immediately, so the state was already VOTING by first paint and
  // the selector never rendered. The policy was silently always UNANIMOUS.
  const policySelect = await alice.$('[role="alertdialog"] #shred-policy');
  if (!policySelect) {
    throw new Error(
      "shred modal opened without the consensus policy selector — the dialog " +
        "is proposing before it confirms",
    );
  }
  const policyOptions = await alice.$$eval(
    '[role="alertdialog"] #shred-policy option',
    (els) => els.map((e) => e.value),
  );
  for (const p of ["UNANIMOUS", "MAJORITY", "THRESHOLD"]) {
    if (!policyOptions.includes(p)) throw new Error(`policy ${p} not offered`);
  }
  // INITIATOR let one participant destroy work everyone else was doing.
  if (policyOptions.includes("INITIATOR")) {
    throw new Error("INITIATOR policy is still offered in the UI");
  }

  // The dropdown must survive the expiry countdown, which re-renders the room
  // four times a second. It previously did not: the focus trap re-ran on
  // every render and yanked focus back to Cancel, collapsing the select.
  await alice.selectOption('[role="alertdialog"] #shred-policy', "MAJORITY");
  await new Promise((r) => setTimeout(r, 1200));
  const stillMajority = await alice.$eval(
    '[role="alertdialog"] #shred-policy',
    (el) => el.value,
  );
  if (stillMajority !== "MAJORITY") {
    throw new Error(
      `policy selection did not stick — expected MAJORITY, got ${stillMajority}`,
    );
  }

  // The dialog is where a phone hurts most: two right-aligned buttons on one
  // row ran off the edge of a narrow screen, which is the worst possible
  // place to lose a button. Check the whole page for horizontal overflow at
  // phone widths, with the dialog open.
  for (const width of [320, 375, 414]) {
    await alice.setViewportSize({ width, height: 780 });
    await alice.waitForTimeout(120);
    const bad = await alice.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const offenders = [];
      for (const el of document.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1) {
          offenders.push(`${el.tagName.toLowerCase()}.${String(el.className || "").split(" ")[0]} right=${Math.round(r.right)}`);
        }
      }
      return { vw, scrollW: document.documentElement.scrollWidth, offenders: offenders.slice(0, 5) };
    });
    if (bad.scrollW > bad.vw + 1) {
      throw new Error(
        `[alice] page scrolls sideways at ${width}px (content ${bad.scrollW}px): ${bad.offenders.join(", ")}`,
      );
    }
    // Both dialog actions must actually be reachable.
    for (const name of ["Cancel", "Shred"]) {
      const box = await alice.locator(`[role="alertdialog"] button:has-text("${name}")`).first().boundingBox();
      if (!box) throw new Error(`[alice] "${name}" button missing at ${width}px`);
      if (box.x < 0 || box.x + box.width > width + 1) {
        throw new Error(`[alice] "${name}" button off-screen at ${width}px (x=${Math.round(box.x)} w=${Math.round(box.width)})`);
      }
    }
  }
  // Side-by-side panes on a screen too narrow for them is how a shared room
  // link arrives looking like a blank page: two empty pane backgrounds with
  // the text off in the top-left. Reported from a Realme handset, where the
  // cause was Android's "Desktop site" toggle forcing a 980px layout viewport
  // — a width no phone reports natively, so no phone-width check could see
  // it. The same band catches any handset turned sideways (932px at the
  // widest) and a small tablet in portrait (834px).
  for (const [width, wantSplit] of [[834, false], [932, false], [980, false], [1024, true]]) {
    await alice.setViewportSize({ width, height: 800 });
    await alice.waitForTimeout(150);
    const split = await alice.evaluate(() => {
      const pv = document.querySelector(".pane-preview");
      return !!(pv && getComputedStyle(pv).display !== "none");
    });
    if (split !== wantSplit) {
      throw new Error(
        `[alice] at ${width}px the room shows ${split ? "two panes" : "one pane"}, expected ${wantSplit ? "two" : "one"}`,
      );
    }
  }

  // Copy link and Shred stay on the bar at phone width; everything else folds
  // into the overflow menu. Shred behind a menu would be the wrong thing to
  // make slower, and a menu that will not close is a trap on a touch screen.
  await alice.setViewportSize({ width: 384, height: 780 });
  await alice.waitForTimeout(150);
  const bar = await alice.evaluate(() => {
    const vis = (el) => !!el && getComputedStyle(el).display !== "none";
    const items = document.querySelector(".tool-menu-items");
    return {
      copy: [...document.querySelectorAll(".statusbar-actions button")].some((b) => /Copy link/.test(b.textContent)),
      shred: [...document.querySelectorAll(".statusbar-actions button")].some((b) => /Shred/.test(b.textContent)),
      toggle: vis(document.querySelector(".tool-menu-toggle")),
      menuClosed: !!items && getComputedStyle(items).display === "none",
    };
  });
  if (!bar.copy || !bar.shred) throw new Error("[alice] Copy link and Shred must stay visible at 384px");
  if (!bar.toggle) throw new Error("[alice] overflow menu toggle missing at 384px");
  if (!bar.menuClosed) throw new Error("[alice] overflow menu is open before it is asked for");

  await alice.setViewportSize({ width: 1280, height: 900 });

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
  console.log(`  shred modal: three safe policies, selection sticks, cancel works`);
  console.log(`  landing and room hold 320 / 375 / 414 px; dialog buttons reachable`);
  console.log(`  named-room form strands nothing above the scroll origin on four phones`);
  console.log(`  room stays one pane to 1000px; Copy link and Shred stay on the bar`);
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
