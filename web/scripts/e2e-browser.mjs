import { spawn } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";
import { createHash } from "node:crypto";
import { chromium, firefox, webkit } from "playwright";

/// Which engine this run drives. Chromium by default so a bare `npm run smoke`
/// behaves as it always did; CI runs all three.
///
/// Two of the faults that reached real users could not have been caught here
/// on one engine. The line-ending corruption needed a client whose Monaco
/// model used CRLF, which no headless Chromium on macOS produces, so peers
/// agreed in CI and diverged in the field. The <select> overflow in #13 is
/// documented as unreproducible in Chromium at all, headless or emulated.
const ENGINES = { chromium, firefox, webkit };
const ENGINE_NAME = process.env.RUNA_E2E_BROWSER ?? "chromium";
const ENGINE = ENGINES[ENGINE_NAME];
if (!ENGINE) {
  throw new Error(`unknown RUNA_E2E_BROWSER "${ENGINE_NAME}"; expected one of ${Object.keys(ENGINES).join(", ")}`);
}

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

  const browser = await ENGINE.launch();

  /// Pages whose network has been taken away. Consulted by the route
  /// installed in makePage, so a sever survives the reconnects that follow.
  const severed = new WeakSet();

  async function makePage(label) {
    const page = await browser.newPage();
    // Keep a handle on every WebSocket the page opens, so a test can sever one.
    // See severNetwork() for why the tests do not use setOffline for this.
    await page.addInitScript(() => {
      const Original = WebSocket;
      const opened = [];
      window.__runaSockets = opened;
      const Patched = function (...args) {
        const ws = new Original(...args);
        opened.push(ws);
        return ws;
      };
      Patched.prototype = Original.prototype;
      Object.assign(Patched, Original);
      window.WebSocket = Patched;
    });
    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "error") errors.push(`[${label}] console.error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => errors.push(`[${label}] pageerror: ${err.message}`));
    // Route every WebSocket through here from the very start, because the
    // route is installed into the page as an init script and applying it
    // later does nothing at all. A page that is not severed is passed
    // straight through to the real server.
    await page.routeWebSocket(/.*/, (ws) => {
      if (severed.has(page)) {
        ws.close();
        return;
      }
      ws.connectToServer();
    });
    return page;
  }

  /// Take one page's network away, the same way on every engine.
  ///
  /// `context.setOffline` is not that. Running the suite on three engines was
  /// what showed how far apart they are: all three refuse new *HTTP* requests
  /// while offline, but only Chromium tears down an established WebSocket —
  /// Gecko leaves it up, and WebKit will happily open a brand new one while
  /// `navigator.onLine` is false. The offline peer there reconnected inside
  /// the same tick, stayed in sync, and the split-brain test then failed its
  /// own precondition rather than passing on a setup that never happened.
  ///
  /// So do neither engine's version of offline. Close the socket that is up,
  /// from inside the page, and have the route installed in makePage refuse
  /// every new one — Playwright implements that itself, so it behaves
  /// identically in all three. The client sees a close it did not ask for and
  /// retries on its backoff, which is what a lost network actually looks
  /// like.
  async function severNetwork(page) {
    severed.add(page);
    await page.evaluate(() => {
      for (const ws of window.__runaSockets ?? []) {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
    });
    await page.waitForTimeout(300);
  }

  /// Give it back. The next backoff attempt connects for real.
  async function restoreNetwork(page) {
    severed.delete(page);
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

  // A 24-hour room must not accuse its own server of tampering. For an
  // absolute TTL the server reports the time *remaining*, which is necessarily
  // less than the duration the config blob records, and the client compared
  // the two directly — so every such room raised the mismatch banner within a
  // minute of being created. A security warning that is always on is worse
  // than none.
  //
  // Created through the landing page rather than by POSTing to the API,
  // because the comparison only runs when a config blob is present and the API
  // does not make one. A version of this check that created the room directly
  // could not fail, and did not: it passed against the unfixed client.
  {
    const ttlPage = await makePage("absolute-ttl");
    await ttlPage.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await ttlPage.waitForSelector("#expiry", { timeout: 10_000 });
    await ttlPage.selectOption("#expiry", JSON.stringify({ kind: "absolute", secs: 86400 }));
    await ttlPage.click('button:has-text("Create private room")');
    await ttlPage.waitForSelector(".statusbar", { timeout: 30_000 });

    // The comparison runs once, on JOIN_ACK. Joining the instant the room is
    // made leaves elapsed at zero, where even the broken comparison is quiet —
    // which is why a version of this check that only created and looked passed
    // against the unfixed client. The fault appears on a *later* join, which
    // is exactly how it was reported: a long session, a reconnect, then the
    // banner. Reloading rejoins from the fragment and re-evaluates it.
    await ttlPage.waitForTimeout(5000);
    await ttlPage.reload({ waitUntil: "domcontentloaded" });
    await ttlPage.waitForSelector(".statusbar", { timeout: 30_000 });
    await ttlPage.waitForTimeout(1500);
    const accused = await ttlPage.evaluate(() =>
      document.body.textContent.includes("reports a different expiry"),
    );
    if (accused) {
      throw new Error("[ttl] a 24-hour room reported its own server as contradicting its config");
    }
    await ttlPage.close();
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

  // The convergence check above compares the *rendered preview*, which
  // normalises whitespace: two sources whose blank lines sit in different
  // places render to identical text. A real divergence report showed exactly
  // that shape — the same words, differently placed — so the preview could
  // never have caught it. Compare the editor's own lines instead.
  const editorText = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll(".view-lines .view-line")]
        .map((el) => ({ t: parseInt(el.style.top || "0", 10), x: el.textContent.replace(/\u00a0/g, " ") }))
        .sort((x, y) => x.t - y.t)
        .map((l) => l.x)
        .join("\n"),
    );

  // Type into both at once, at the same place, which is the case that was
  // reported as broken.
  await alice.click(".monaco-editor .view-lines");
  await bob.click(".monaco-editor .view-lines");
  await Promise.all([
    alice.keyboard.type("\nAAAA AAAA AAAA\nAAAA AAAA\n", { delay: 10 }),
    bob.keyboard.type("\nBBBB BBBB BBBB\nBBBB BBBB\n", { delay: 10 }),
  ]);

  let srcA = "";
  let srcB = "";
  for (let i = 0; i < 60; i++) {
    await alice.waitForTimeout(500);
    srcA = await editorText(alice);
    srcB = await editorText(bob);
    if (srcA === srcB && srcA.includes("AAAA") && srcA.includes("BBBB")) break;
  }
  if (srcA !== srcB) {
    throw new Error(
      `[sync] editors did not converge after concurrent typing\n  alice: ${JSON.stringify(srcA)}\n  bob:   ${JSON.stringify(srcB)}`,
    );
  }

  // And the divergence warning must not be crying wolf. It compared the local
  // hash at that instant against hashes peers had broadcast up to a heartbeat
  // earlier, on every update, and latched forever on the first mismatch — so
  // two byte-identical documents both showed it. Waited past the quiet window
  // and a heartbeat so a false positive has every chance to appear.
  await alice.waitForTimeout(13_000);
  for (const [label, page] of [["alice", alice], ["bob", bob]]) {
    const warned = await page.evaluate(() =>
      document.body.textContent.includes("Your copy differs from other peers"),
    );
    if (warned) {
      throw new Error(`[sync] ${label} reports divergence while both editors hold identical text`);
    }
  }

  // Split brain: a peer edits while disconnected, the other edits meanwhile,
  // and both must reconverge on reconnect. This is the highest-risk path in
  // the whole design — it exercises the resync request, the server's log
  // replay and Yjs's merge at once — and it is the shape a real report will
  // most often have, since a phone that locks or a laptop that sleeps looks
  // exactly like this.
  await severNetwork(bob);
  await bob.click(".monaco-editor .view-lines");
  await Promise.all([
    alice.keyboard.type("\nwritten-while-bob-was-away\n", { delay: 8 }),
    bob.keyboard.type("\nwritten-by-bob-offline\n", { delay: 8 }),
  ]);
  await alice.waitForTimeout(2000);
  const splitA = await editorText(alice);
  const splitB = await editorText(bob);
  if (splitA === splitB) {
    throw new Error("[sync] peers did not actually diverge while one was offline — the test proves nothing");
  }
  await restoreNetwork(bob);
  let reA = "";
  let reB = "";
  let reconverged = false;
  for (let i = 0; i < 60; i++) {
    await alice.waitForTimeout(1000);
    reA = await editorText(alice);
    reB = await editorText(bob);
    if (reA === reB) {
      reconverged = true;
      break;
    }
  }
  if (!reconverged) {
    throw new Error(
      `[sync] peers never reconverged after a disconnect\n  alice: ${JSON.stringify(reA)}\n  bob:   ${JSON.stringify(reB)}`,
    );
  }
  if (!reA.includes("written-while-bob-was-away") || !reA.includes("written-by-bob-offline")) {
    throw new Error(`[sync] reconnect lost an edit instead of merging it: ${JSON.stringify(reA)}`);
  }

  // The status bar counts who is actually here, not who the roster still
  // lists. A roster is a join-time snapshot patched with the events a client
  // happened to receive, so a missed PEER_LEAVE over-counts for the rest of
  // the session — four devices in one room reported 5, 3, 3 and 3 people at
  // the same moment. Presence expires on its own, so the count has to come
  // back down by itself with no event to prompt it, and come back up when the
  // peer returns. Asserted as a round trip because a count that only ever
  // falls is as broken as one that only ever rises.
  const shownPeople = (page) =>
    page.evaluate(() => {
      const m = document.body.textContent.match(/(\d+)\s+(PERSON|PEOPLE)/);
      return m ? Number(m[1]) : null;
    });
  if ((await shownPeople(alice)) !== 2) {
    throw new Error(`[presence] expected 2 people before the drop, saw ${await shownPeople(alice)}`);
  }
  await severNetwork(bob);
  let dropped = false;
  for (let i = 0; i < 50; i++) {
    await alice.waitForTimeout(1000);
    if ((await shownPeople(alice)) === 1) {
      dropped = true;
      break;
    }
  }
  if (!dropped) {
    throw new Error(
      `[presence] a silent peer never expired from the count; still showing ${await shownPeople(alice)}`,
    );
  }
  await restoreNetwork(bob);
  let returned = false;
  for (let i = 0; i < 50; i++) {
    await alice.waitForTimeout(1000);
    if ((await shownPeople(alice)) === 2) {
      returned = true;
      break;
    }
  }
  if (!returned) {
    throw new Error(
      `[presence] the peer came back but the count did not; showing ${await shownPeople(alice)}`,
    );
  }

  // Maths must render as maths, not as flattened text. $E = mc^2$ came out
  // reading "E=mc2" on a real screen while the unit test asserting /katex/i
  // passed the whole time — the wrapper class survives sanitising whether or
  // not anything inside it renders. Structure alone is still not proof, so
  // this measures the rendered geometry: an exponent has to sit higher than
  // its base and be drawn smaller. That is the property that was broken, and
  // it is only observable in a browser.
  await alice.keyboard.type("\n\n$$\nE = mc^2\n$$\n");
  let mathBox = null;
  for (let i = 0; i < 40 && !mathBox; i++) {
    mathBox = await alice.evaluate(() => {
      const base = document.querySelector(".preview-body math mi");
      const exp = document.querySelector(".preview-body math msup mn");
      if (!base || !exp) return null;
      const b = base.getBoundingClientRect();
      const e = exp.getBoundingClientRect();
      if (b.height === 0 || e.height === 0) return null;
      return { baseTop: b.top, baseH: b.height, expTop: e.top, expH: e.height };
    });
    if (!mathBox) await alice.waitForTimeout(150);
  }
  if (!mathBox) throw new Error("[alice] display math never produced MathML in the preview");
  if (!(mathBox.expTop < mathBox.baseTop)) {
    throw new Error(
      `[alice] exponent is not raised above its base (exp top ${Math.round(mathBox.expTop)} vs base ${Math.round(mathBox.baseTop)}) — math is rendering flat`,
    );
  }
  if (!(mathBox.expH < mathBox.baseH)) {
    throw new Error(
      `[alice] exponent is not drawn smaller than its base (${Math.round(mathBox.expH)}px vs ${Math.round(mathBox.baseH)}px)`,
    );
  }
  // Layout used to be one button cycling split → editor → preview, so closing
  // the preview and opening it again cost two presses, and nothing said which
  // mode was current. Each mode is now one press, and the active one is
  // marked. Asserted as a round trip because that is what was reported.
  await alice.setViewportSize({ width: 1280, height: 900 });
  await alice.waitForTimeout(150);
  const previewVisible = () =>
    alice.evaluate(() => {
      const pv = document.querySelector(".pane-preview");
      return !!(pv && getComputedStyle(pv).display !== "none");
    });
  const activeTab = () =>
    alice.evaluate(() => {
      const on = document.querySelector('.mode-tab[aria-pressed="true"]');
      return on ? on.textContent.trim() : null;
    });
  if (!(await previewVisible())) throw new Error("[alice] preview not visible in the default split mode");
  if ((await activeTab()) !== "Split") throw new Error(`[alice] active tab should be Split, got ${await activeTab()}`);

  await alice.click('.mode-tab:has-text("Editor")');
  await alice.waitForTimeout(150);
  if (await previewVisible()) throw new Error("[alice] one press on Editor did not close the preview");
  if ((await activeTab()) !== "Editor") throw new Error("[alice] Editor tab is not marked active after pressing it");

  await alice.click('.mode-tab:has-text("Split")');
  await alice.waitForTimeout(150);
  if (!(await previewVisible())) throw new Error("[alice] one press on Split did not bring the preview back");

  // The pressed tab must be outlined on all four sides in every position.
  // Collapsing the shared borders by deleting each tab's right border left
  // Split and Editor outlined on three sides with a gap on the fourth, while
  // Preview looked correct because it is :last-child and kept its own right
  // border — so eyeballing the control in its default state showed nothing
  // wrong. Measured rather than looked at, in all three positions.
  for (const mode of ["Split", "Editor", "Preview"]) {
    await alice.click(`.mode-tab:has-text("${mode}")`);
    await alice.waitForTimeout(150);
    const edge = await alice.evaluate(() => {
      const el = document.querySelector('.mode-tab[aria-pressed="true"]');
      if (!el) return null;
      const cs = getComputedStyle(el);
      const sides = ["Top", "Right", "Bottom", "Left"];
      return {
        label: el.textContent.trim(),
        widths: sides.map((x) => cs[`border${x}Width`]),
        colors: sides.map((x) => cs[`border${x}Color`]),
      };
    });
    if (!edge) throw new Error(`[tabs] no pressed tab after selecting ${mode}`);
    if (new Set(edge.widths).size !== 1) {
      throw new Error(`[tabs] ${edge.label} is outlined unevenly: ${edge.widths.join(", ")}`);
    }
    if (new Set(edge.colors).size !== 1) {
      throw new Error(`[tabs] ${edge.label} has mismatched border colours: ${edge.colors.join(" | ")}`);
    }
  }
  // And the group must not resize as the selection moves, or the whole bar
  // twitches every time somebody switches pane.
  const groupWidths = [];
  for (const mode of ["Split", "Editor", "Preview"]) {
    await alice.click(`.mode-tab:has-text("${mode}")`);
    await alice.waitForTimeout(120);
    groupWidths.push(
      await alice.evaluate(() => Math.round(document.querySelector(".mode-tabs").getBoundingClientRect().width)),
    );
  }
  if (new Set(groupWidths).size !== 1) {
    throw new Error(`[tabs] the control resizes with the selection: ${groupWidths.join(", ")}`);
  }
  await alice.click('.mode-tab:has-text("Split")');
  await alice.waitForTimeout(150);

  // Split is not offered where it renders identically to editor-only.
  await alice.setViewportSize({ width: 384, height: 780 });
  await alice.waitForTimeout(200);
  await alice.click(".tool-menu-toggle");
  await alice.waitForTimeout(200);
  const narrowTabs = await alice.evaluate(() =>
    [...document.querySelectorAll(".mode-tab")].map((b) => b.textContent.trim()),
  );
  if (narrowTabs.includes("Split")) {
    throw new Error(`[alice] Split offered below the panes breakpoint: ${narrowTabs.join(", ")}`);
  }
  if (!narrowTabs.includes("Editor") || !narrowTabs.includes("Preview")) {
    throw new Error(`[alice] narrow layout tabs missing: ${narrowTabs.join(", ")}`);
  }
  await alice.keyboard.press("Escape");
  await alice.setViewportSize({ width: 1280, height: 900 });
  await alice.waitForTimeout(150);

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
  // The room must fit the window exactly. It did not: the editor pane was a
  // plain block holding the markdown ribbon and an editor sized at height:100%
  // of that same block, so the two came to a ribbon's height more than the
  // window. The document scrolled as a whole — a second scrollbar beside the
  // editor's own, and the status bar and ribbon sliding off the top, which
  // looked like rows pinning themselves under the toolbar.
  //
  // The guard beside this one checks the *horizontal* axis only, which is why
  // 30px of vertical overflow sat there unnoticed across three engines.
  for (const [w, h] of [[1400, 800], [1280, 720], [1024, 900]]) {
    await alice.setViewportSize({ width: w, height: h });
    await alice.waitForTimeout(400);
    const fit = await alice.evaluate(() => {
      const de = document.documentElement;
      window.scrollTo(0, 0);
      return { over: de.scrollHeight - de.clientHeight, root: document.querySelector("#root")?.getBoundingClientRect().height };
    });
    if (fit.over > 1) {
      throw new Error(`[room] the page scrolls at ${w}x${h}: ${fit.over}px past the window (#root ${Math.round(fit.root)})`);
    }
    // And nothing may drag the chrome off the top.
    await alice.evaluate(() => window.scrollTo(0, 500));
    await alice.waitForTimeout(200);
    const barTop = await alice.evaluate(() => Math.round(document.querySelector(".statusbar").getBoundingClientRect().top));
    if (barTop < -1) {
      throw new Error(`[room] the status bar scrolled off the top at ${w}x${h} (top ${barTop})`);
    }
  }
  await alice.setViewportSize({ width: 1280, height: 900 });
  await alice.waitForTimeout(300);

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

  // Ctrl/Cmd+B and Ctrl/Cmd+I do nothing in a standalone Monaco — bold and
  // italic are commands VS Code supplies for markdown — so in a markdown
  // editor they failed silently, which reads as broken rather than absent.
  // Checked through the keyboard rather than by asking whether the action is
  // registered: a registered action with the wrong keybinding would satisfy
  // the second and still leave the shortcut dead.
  await alice.click(".monaco-editor .view-lines");
  await alice.keyboard.press("ControlOrMeta+End");
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("emphasise-me");
  for (let i = 0; i < "emphasise-me".length; i++) await alice.keyboard.press("Shift+ArrowLeft");
  await alice.keyboard.press("ControlOrMeta+b");
  await alice.waitForTimeout(400);
  let line = await alice.evaluate(() => {
    const rows = [...document.querySelectorAll(".view-lines .view-line")]
      .map((el) => ({ t: parseInt(el.style.top || "0", 10), x: el.textContent.replace(/\u00a0/g, " ") }))
      .sort((a, b) => a.t - b.t);
    return rows.map((r) => r.x).find((x) => x.includes("emphasise-me")) ?? "";
  });
  if (!line.includes("**emphasise-me**")) {
    throw new Error(`[shortcuts] Ctrl/Cmd+B did not bold the selection: ${JSON.stringify(line)}`);
  }
  for (let i = 0; i < "**emphasise-me**".length; i++) await alice.keyboard.press("Shift+ArrowLeft");
  await alice.keyboard.press("ControlOrMeta+i");
  await alice.waitForTimeout(400);
  line = await alice.evaluate(() => {
    const rows = [...document.querySelectorAll(".view-lines .view-line")]
      .map((el) => ({ t: parseInt(el.style.top || "0", 10), x: el.textContent.replace(/\u00a0/g, " ") }))
      .sort((a, b) => a.t - b.t);
    return rows.map((r) => r.x).find((x) => x.includes("emphasise-me")) ?? "";
  });
  if (!line.includes("***emphasise-me***")) {
    throw new Error(`[shortcuts] Ctrl/Cmd+I did not italicise the selection: ${JSON.stringify(line)}`);
  }

  // Sticky scroll stays off. Monaco turns it on by default and pins the
  // enclosing foldable block's header to the top of the editor; with no
  // folding provider for markdown it folds by indentation, so it pinned rows
  // of dashes and ordinary sentences that happened to precede indented text,
  // and cost up to 90px of editor height.
  //
  // The content below matters: three earlier attempts to measure this used
  // flat documents, which produce no folding ranges at all, so the widget was
  // zero-height whether the feature was on or off and every one of them
  // reported it inert. Indentation is what makes this able to fail.
  await alice.click(".monaco-editor .view-lines");
  await alice.keyboard.press("ControlOrMeta+End");
  await alice.keyboard.type("\nblock header\n");
  // Longer than the viewport on purpose: a block that fits on screen keeps its
  // header visible, so there is nothing to pin and the check passes whatever
  // the setting is. That was the first version of this.
  for (let i = 0; i < 45; i++) await alice.keyboard.type(`    indented body ${i}\n`);
  await alice.waitForTimeout(600);
  await alice.mouse.move(600, 400);
  for (let i = 0; i < 6; i++) {
    await alice.mouse.wheel(0, 200);
    await alice.waitForTimeout(150);
  }
  await alice.waitForTimeout(400);
  const sticky = await alice.evaluate(() => {
    const w = document.querySelector(".sticky-widget");
    const r = w?.getBoundingClientRect();
    return { h: r ? Math.round(r.height) : -1, text: (w?.textContent ?? "").trim().slice(0, 40) };
  });
  if (sticky.h > 0) {
    throw new Error(`[sticky] the editor is pinning a block header again: ${sticky.h}px "${sticky.text}"`);
  }

  // The editor must have a context menu at all. Turning Monaco's off to stop
  // a doubling left right-click useless — the platform menu on rendered glyphs
  // is a generic page menu with no Cut or Copy — so this guards the regression
  // that caused, not the doubling, which is not understood well enough to
  // guard. It flips with the option: contextmenu:false gives defaultPrevented
  // false and fails here. Gecko and WebKit showed the
  // platform menu alongside it, so a right-click gave two overlapping menus
  // with two Paste entries. Turning Monaco's off removed the doubling and
  // removed the useful menu with it — on Monaco's rendered text the platform
  // menu is a generic page menu, since the glyphs are divs and the real input
  // is hidden — so the platform one is suppressed explicitly instead.
  //
  // Asserted on preventDefault rather than on a menu element. Monaco keeps
  // context-view containers in the DOM permanently and renders no menu under a
  // synthetic right-click headlessly, so counting elements passes whichever
  // way the option is set; that version was written first and proved nothing.
  await alice.evaluate(() => {
    window.__ctxPrevented = null;
    window.addEventListener(
      "contextmenu",
      // Capture, because Monaco calls stopPropagation and the event never
      // bubbles this far. The read is deferred so defaultPrevented is sampled
      // after the whole dispatch, including handlers deeper than this one.
      (e) => setTimeout(() => { window.__ctxPrevented = e.defaultPrevented; }, 0),
      true,
    );
  });
  await alice.click(".monaco-editor .view-lines", { button: "right" });
  await alice.waitForTimeout(600);
  const ctx = await alice.evaluate(() => window.__ctxPrevented);
  if (ctx === null) throw new Error("[contextmenu] no contextmenu event reached the page");
  if (ctx !== true) {
    throw new Error("[contextmenu] the editor has no context menu of its own — right-click falls back to a generic page menu with no Cut or Copy");
  }
  await alice.keyboard.press("Escape");


  // A shred request must survive a reconnect. Reported from two machines: a
  // laptop that had switched tabs a couple of times proposed a shred, showed
  // the right occupant count, and the other machine — online the entire time —
  // never saw the prompt at all. Only a full page reload restored it.
  //
  // The cause was that JOIN_ACK's authoritative roster was merged into the
  // existing map rather than replacing it, so each reconnect left the previous
  // connection's peer id behind. The roster is the consensus denominator AND
  // its hash travels inside the request, so an inflated roster asked three of
  // four to approve and hashed differently from everyone else's, and every
  // receiver dropped the request as `roster-mismatch`. Silently, because the
  // guard hook was an empty function.
  await severNetwork(bob);
  await bob.waitForTimeout(1500);
  await restoreNetwork(bob);
  let backTogether = false;
  for (let i = 0; i < 60; i++) {
    await alice.waitForTimeout(1000);
    const n = await alice.evaluate(() => {
      const m = document.body.textContent.match(/(\d+)\s+(PERSON|PEOPLE)/);
      return m ? Number(m[1]) : null;
    });
    if (n === 2) {
      backTogether = true;
      break;
    }
  }
  if (!backTogether) throw new Error("[shred] peers never re-established before the shred check");

  // Scope: this now does reproduce the roster merge that caused the reported
  // failure, which it could not before. The previous note here said so
  // honestly — a brief setOffline blip never produced a real socket close, so
  // there was no second JOIN_ACK to merge a stale peer id out of, and the test
  // stayed green with the fix reverted. severNetwork() does produce one.
  // Rechecked the only way worth trusting: drop the `target.clear()` from
  // replaceRoster and this fails with a denominator of 5 for two people.
  //
  // So the path is covered end to end — a shred proposed after a real
  // interruption reaches the other side, and the bar it asks for describes the
  // people actually in the room. session.roster.test.ts still asserts the
  // merge directly; this is the same bug seen from the outside. Bob proposes
  // because bob is the one that dropped.
  await bob.click('button:has-text("Shred")');
  await bob.waitForSelector('[role="alertdialog"]', { timeout: 5000 });

  // The denominator has to describe the people who are here. A reconnect used
  // to inflate it, so this asked three of four with two people in the room.
  await bob.selectOption('[role="alertdialog"] #shred-policy', "THRESHOLD");
  await bob.waitForTimeout(200);
  const policyCopy = await bob.textContent('[role="alertdialog"]');
  const denom = policyCopy.match(/of\s+(?:the\s+)?(\d+)/);
  if (!denom || Number(denom[1]) !== 2) {
    throw new Error(`[shred] consensus denominator is ${denom ? denom[1] : "unreadable"} with two people present`);
  }
  await bob.selectOption('[role="alertdialog"] #shred-policy', "UNANIMOUS");
  await bob.waitForTimeout(200);
  await bob.click('[role="alertdialog"] button:has-text("Shred")');

  // And the other side must actually be asked.
  try {
    await alice.waitForSelector('text=SHRED REQUESTED BY A PEER', { timeout: 15000 });
  } catch {
    throw new Error("[shred] the peer was never prompted — the request was dropped in silence");
  }
  await alice.click('[role="alertdialog"] button:has-text("Reject")');
  await bob.waitForTimeout(500);

  // Export offered PDF at one fixed size and nothing else: a long document
  // became sixty-odd pages with no way to change it, and there was no way to
  // get the source back out at all. The dialog now offers both, and this
  // checks the markdown path end to end — a download that never arrives is
  // indistinguishable from a button that does nothing.
  alice.on("dialog", (d) => void d.accept());
  await alice.click('button:has-text("Export")');
  await alice.waitForSelector('[role="dialog"]', { timeout: 5000 });
  const offered = await alice.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] button')].map((b) => b.textContent.trim()),
  );
  for (const want of ["Markdown (.md)", "Compact", "Normal", "Large"]) {
    if (!offered.includes(want)) {
      throw new Error(`[export] the dialog does not offer "${want}": ${offered.join(", ")}`);
    }
  }
  const download = alice.waitForEvent("download", { timeout: 15_000 });
  await alice.click('[role="dialog"] button:has-text("Markdown (.md)")');
  const file = await download;
  if (!/^runa-\d{8}-\d{4}\.md$/.test(file.suggestedFilename())) {
    throw new Error(`[export] unexpected filename: ${file.suggestedFilename()}`);
  }
  // A file that outlives the room must not carry the room's address into a
  // downloads folder, a backup, and whatever syncs them.
  if (file.suggestedFilename().includes(roomIdHex.slice(0, 8))) {
    throw new Error("[export] the filename leaks the room id");
  }
  const saved = await file.path();
  const contents = saved ? await (await import("node:fs/promises")).readFile(saved, "utf8") : "";
  if (!contents.includes("Hello from Alice")) {
    throw new Error(`[export] the markdown does not contain the document: ${JSON.stringify(contents.slice(0, 120))}`);
  }

  // Tombstone reachable and header-clean
  const gone = await fetch(`${BASE}/gone.html`);
  if (!gone.headers.get("clear-site-data")) throw new Error("gone.html missing Clear-Site-Data");
  // Comments stripped first: the file explains the old placeholder in a
  // comment, and a check that trips on its own documentation is a bad check.
  const goneBody = (await gone.text()).replace(/<!--[\s\S]*?-->/g, "");
  // It used to read "ROOM —— · SHREDDED —— UTC", with the dashes standing in
  // for values no script ever supplied — the element was referenced nowhere —
  // so every reader saw the placeholders themselves.
  if (/——/.test(goneBody)) {
    throw new Error("gone.html still shows unfilled placeholders");
  }
  // And it must stay anonymous: this page is served with Clear-Site-Data, so
  // naming the room here would write that address into a history just wiped
  // for exactly that reason.
  if (/room[_-]?id|\bUTC\b/i.test(goneBody)) {
    throw new Error("gone.html leaks room or timing detail");
  }

  const cspViolations = errors.filter((e) => /Content Security Policy|trustedTypes|Refused to/i.test(e));
  if (cspViolations.length > 0) {
    console.error("CSP/TT VIOLATIONS:");
    for (const e of cspViolations.slice(0, 10)) console.error(" ", e);
    throw new Error(`${cspViolations.length} CSP/Trusted-Types violations`);
  }

  // iOS Safari zooms the page when focus lands on a control computing under
  // 16px, and never undoes it — so tapping a line to type left the reader
  // zoomed in, and the shred dialog (position:fixed, laid out against the
  // layout viewport) then rendered cropped at both edges. Monaco's hidden
  // input was 12px and is written inline by Monaco, so no stylesheet rule
  // reached it; the fix is the editor option, keyed on pointer type.
  //
  // Checked under real touch emulation, because that is what the fix keys on:
  // with pointer:fine the desktop sizes are correct and prove nothing.
  const touchCtx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    hasTouch: true,
    isMobile: true,
  });
  const touch = await touchCtx.newPage();
  await touch.goto(roomUrl, { waitUntil: "domcontentloaded" });
  await touch.waitForSelector(".pane-editor", { timeout: 10000 });
  await touch.waitForTimeout(1500);
  const zoomers = await touch.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("input, select, textarea")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const fs = parseFloat(cs.fontSize);
      if (fs < 16) out.push(`${el.tagName.toLowerCase()}.${String(el.className || "").split(" ")[0]}=${fs}px`);
    }
    return out;
  });
  await touchCtx.close();
  if (zoomers.length > 0) {
    throw new Error(
      `[touch] controls under the 16px iOS zoom threshold: ${zoomers.join(", ")}`,
    );
  }

  await browser.close();
  server.kill();
  await waitForProcessExit(server);

  console.log(`BROWSER E2E OK (${ENGINE_NAME})`);
  console.log(`  two headless peers joined ${roomIdHex.slice(0, 8)}…`);
  console.log(`  typed concurrently; Alice's preview converged to include Bob's text`);
  console.log(`  status bars showed a 2-person count on both sides`);
  console.log(`  editors converged char-for-char after concurrent typing; no false divergence`);
  console.log(`  offline edits on both sides reconverged on reconnect, nothing lost`);
  console.log(`  presence count falls when a peer goes quiet and returns when it comes back`);
  console.log(`  a shred proposed after a reconnect reaches the peer, and counts only who is here`);
  console.log(`  export offers markdown and three PDF sizes; the .md lands with the source in it`);
  console.log(`  shred modal: three safe policies, selection sticks, cancel works`);
  console.log(`  landing and room hold 320 / 375 / 414 px; dialog buttons reachable`);
  console.log(`  a 24-hour room does not accuse its server of changing the expiry`);
  console.log(`  named-room form strands nothing above the scroll origin on four phones`);
  console.log(`  room stays one pane to 1000px; Copy link and Shred stay on the bar`);
  console.log(`  the room fits the window exactly; the chrome cannot scroll away`);
  console.log(`  ctrl/cmd+B and +I emphasise through the keyboard; one context menu only`);
  console.log(`  no block header pins itself to the top of an indented document`);
  console.log(`  no control under the 16px iOS zoom threshold on a touch device`);
  console.log(`  display math renders with the exponent raised and smaller`);
  console.log(`  layout tabs: one press per mode, active marked, no Split on a phone`);
  console.log(`  pressed tab outlined evenly on all four sides; control does not resize`);
  console.log(`  gone.html served with Clear-Site-Data, anonymous, no placeholder text`);
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
