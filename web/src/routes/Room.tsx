import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monacoModule from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

loader.config({ monaco: monacoModule });

self.MonacoEnvironment = {
  getWorker() {
    return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" });
  },
};
import { Session, type LadderPhase } from "../session";
import {
  deriveRoomKeys,
  parseFragment,
  passphraseMaterial,
} from "../keys-session";
import { Api } from "../api";
import { renderMarkdown, isExternalHref } from "../render/pipeline";
import { type TemperState } from "../ui/temper";
import { QuorumDial, useAccent } from "../ui/dial";
import { ShredModal, THRESHOLD_K } from "../ui/ShredModal";
import type { Policy } from "../shred/machine";
import type { ShredRequest } from "../shred/machine";
import { MissingKey } from "./MissingKey";
import { exportPdf } from "../export/paged";
import { TOOLBAR_ACTIONS, applyTool } from "../ui/toolbar";
import { useLineSync } from "../ui/linesync";

const api = new Api("");

export interface RoomProps {
  roomIdHex?: string;
  name?: string;
  fragment?: string;
}

type Phase =
  | { kind: "passphrase" }
  | { kind: "connecting" }
  | { kind: "missing-key" }
  | { kind: "auth-failed" }
  | { kind: "insecure-origin" }
  | { kind: "live"; session: Session; peerCount: number }
  | { kind: "purged" }
  | { kind: "unavailable" };

let extNoticeShown = false;
let externalConfirmed = false;

export function Room(props: RoomProps) {
  if (props.roomIdHex && props.fragment === undefined) {
    return <MissingKey />;
  }
  return <JoinableRoom {...props} />;
}

function JoinableRoom(props: RoomProps) {
  const [phase, setPhase] = useState<Phase>({ kind: props.name ? "passphrase" : "connecting" });
  const sessionRef = useRef<Session | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [html, setHtml] = useState("");
  const [peerCount, setPeerCount] = useState(0);
  const [temper, setTemper] = useState<TemperState>("COLD");
  const [shredOpen, setShredOpen] = useState(false);
  const [shredPrompt, setShredPrompt] = useState<ShredRequest | null>(null);
  const [shredLabel, setShredLabel] = useState("IDLE");
  const [shredPolicy, setShredPolicy] = useState<Policy>("UNANIMOUS");
  const [fingerprint, setFingerprint] = useState<string>("");
  const [mode, setMode] = useState<"split" | "editor" | "preview">("split");
  const [ladder, setLadder] = useState<LadderPhase>({ kind: "normal", remainingMs: 0 });
  const [ttlMismatch, setTtlMismatch] = useState(false);
  const [tally, setTally] = useState<{ approved: number; total: number; waitingOn?: string } | null>(null);
  const [diverged, setDiverged] = useState(false);
  const [showExtNotice, setShowExtNotice] = useState(() => !extNoticeShown);
  const [degraded, setDegraded] = useState(false);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const editorAdapterRef = useRef<{
    scrollTop(line: number): void;
    getTopVisibleLine(): number;
    lineHeightPx: number;
    onScroll(fn: () => void): () => void;
  } | null>(null);
  const previewPaneRef = useRef<HTMLDivElement | null>(null);
  const [steady, setSteady] = useState(false);

  useAccent(temper);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      if (props.name) return;
      try {
        const keys = parseFragment(props.fragment ?? "");
        if (!keys || !props.roomIdHex) {
          if (!cancelled) setPhase({ kind: "missing-key" });
          return;
        }
        await startSession({
          roomIdHex: props.roomIdHex,
          passMaterial: null,
          linkSecret: keys.linkSecret,
          roomSalt: keys.roomSalt,
        });
      } catch (e) {
        if (cancelled) return;
        // The browser refuses ws:// from a non-loopback page, so an operator
        // who has not put TLS in front gets a hard failure here. Saying
        // "wrong passphrase" sends them looking in entirely the wrong place.
        setPhase(
          e instanceof Error && e.message === "INSECURE_ORIGIN"
            ? { kind: "insecure-origin" }
            : { kind: "auth-failed" },
        );
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  const startSession = useCallback(
    async (args: {
      roomIdHex: string;
      passMaterial: Uint8Array | null;
      linkSecret: Uint8Array | null;
      roomSalt: Uint8Array;
    }) => {
      setPhase({ kind: "connecting" });
      const { authKey, contentKey } = await deriveRoomKeys(
        args.passMaterial,
        args.linkSecret,
        args.roomSalt,
      );
      const wsInfo = websocketUrl(args.roomIdHex);
      const session = await Session.create(
        {
          url: wsInfo.url,
          roomIdHex: args.roomIdHex,
          authKey,
          contentKey,
          insecureAllowed: isLoopbackOrigin() && window.location.protocol === "http:",
        },
        {
          onJoinAck: (_ack) => {
            setPhase((p) => (p.kind === "live" ? p : { kind: "live", session, peerCount }));
            void (async () => {
              try {
                const { fingerprintWords } = await import("../crypto/fingerprint");
                const { hkdfBits, INFO_FP } = await import("../crypto/keys");
                if (args.roomSalt && args.passMaterial) {
                  const seed = await hkdfBits(args.passMaterial, args.roomSalt, INFO_FP, 32);
                  setFingerprint(fingerprintWords(seed).join("-").toUpperCase());
                } else if (args.linkSecret && args.roomSalt) {
                  const seed = await hkdfBits(args.linkSecret, args.roomSalt, INFO_FP, 32);
                  setFingerprint(fingerprintWords(seed).join("-").toUpperCase());
                }
              } catch { void 0; }
            })();
          },
          onPeersChanged: (n) => setPeerCount(n),
          onTemper: (t) => setTemper(t),
          onShredPrompt: (req) => {
            setShredPrompt(req);
            setShredOpen(true);
            setTemper("ARMED");
          },
          onShredState: (s) => {
            setShredLabel(s);
            const ses = sessionRef.current;
            if (ses) setTally(ses.tallySummary());
          },
          onCountdown: (phase) => {
            setLadder(phase);
            if (phase.kind === "burn") {
              editorRef.current?.updateOptions({ readOnly: true });
              setTemper("BURN");
            } else if (phase.kind === "armed") {
              setTemper("ARMED");
            } else if (phase.kind === "watch") {
              setTemper("WATCH");
            }
          },
          onTtlMismatch: () => setTtlMismatch(true),
          onDivergence: () => setDiverged(true),
          onPurge: () => setPhase({ kind: "purged" }),
          onRoomUnavailable: () => setPhase({ kind: "unavailable" }),
        },
      );
      sessionRef.current = session;
      // Was previously called on `sessionRef.current` before it was assigned,
      // so the plain-ws warning could never fire.
      session.setInsecure(wsInfo.insecure);
    },
    [],
  );

  useEffect(() => {
    return () => {
      sessionRef.current?.destroySession();
    };
  }, []);

  useEffect(() => {
    if (!markdown) {
      setHtml("");
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      void renderMarkdown(markdown).then(({ html }) => {
        if (!cancelled) setHtml(html);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [markdown]);

  const onEditorMount = useCallback(
    async (editor: MonacoEditor.IStandaloneCodeEditor) => {
      const model = editor.getModel();
      if (!model || !sessionRef.current) return;
      editorRef.current = editor;
      const monacoMod = await import("monaco-editor");
      sessionRef.current.setWipeContext({
        editor,
        model,
        previewEl: previewPaneRef.current,
      });
      editorAdapterRef.current = {
        scrollTop: (line) => editor.setScrollTop(Math.max(0, (line - 1) * editor.getOption(monacoMod.editor.EditorOption.lineHeight))),
        getTopVisibleLine: () => {
          const range = editor.getVisibleRanges()[0];
          return range ? range.startLineNumber : 1;
        },
        lineHeightPx: editor.getOption(monacoMod.editor.EditorOption.lineHeight),
        onScroll: (fn) => {
          const d = editor.onDidScrollChange(fn);
          return () => d.dispose();
        },
      };
      await sessionRef.current.attachEditor(monacoMod, editor);
      // getValue() copies the whole buffer; doing it per keystroke made
      // typing cost O(document). One read per idle pause is enough for a
      // preview that is itself debounced.
      let readTimer: ReturnType<typeof setTimeout> | null = null;
      model.onDidChangeContent(() => {
        if (readTimer) return;
        readTimer = setTimeout(() => {
          readTimer = null;
          setMarkdown(model.getValue());
        }, 90);
      });
    },
    [],
  );

  const startShred = useCallback(() => {
    setShredOpen(true);
    setTemper("ARMED");
    void sessionRef.current
      ?.requestShred(shredPolicy, shredPolicy === "THRESHOLD" ? THRESHOLD_K : null)
      .catch(() => {});
  }, [shredPolicy]);

  const cycleMode = useCallback(() => {
    setMode((m) => (m === "split" ? "editor" : m === "editor" ? "preview" : "split"));
  }, []);

  useLineSync(editorAdapterRef, previewPaneRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        cycleMode();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleMode]);

  const copyLink = useCallback(() => {
    void navigator.clipboard.writeText(window.location.href);
    announce("Copied. The part after the # is the key. Send the whole thing.");
  }, []);

  if (phase.kind === "missing-key") return <MissingKey />;

  if (phase.kind === "passphrase") {
    return (
      <>
        {degraded && (
          <div className="banner" role="alert">
            <span className="error-text mono">Argon2 unavailable. Using a weaker key derivation.</span>
          </div>
        )}
        <PassphraseGate
        name={props.name!}
        onSubmit={async (passphrase) => {
          const resolved = await api.resolveName(props.name!).catch(() => null);
          if (!resolved?.found || !resolved.kdf || !resolved.room_id) {
            setPhase({ kind: "auth-failed" });
            return;
          }
          const roomSalt = b64ToBytes(resolved.kdf.salt);
          const derived = await passphraseMaterial(passphrase, roomSalt);
          setDegraded(derived.degraded);
          if (!derived.material) return;
          const material = derived.material;
          await startSession({
            roomIdHex: resolved.room_id,
            passMaterial: material,
            linkSecret: null,
            roomSalt,
          });
        }}
        />
      </>
    );
  }

  if (phase.kind === "insecure-origin") {
    return (
      <main className="landing">
        <h1 className="mono">RÚNA</h1>
        <p className="micro-label tag">THIS PAGE IS NOT ON HTTPS</p>
        <div className="panel">
          <p>
            RÚNA will not open an unencrypted WebSocket from a page served over
            plain HTTP, so the editor cannot connect. This is a deployment
            problem, not a problem with your link.
          </p>
          <p style={{ marginBottom: 0 }}>
            Whoever runs this server needs to put HTTPS in front of it — see
            <code className="mono"> Deploying to the internet </code> in the
            README. <code className="mono">localhost</code> is exempt.
          </p>
        </div>
      </main>
    );
  }

  if (phase.kind === "unavailable") {
    return (
      <main className="landing">
        <h1 className="mono">RÚNA</h1>
        <p className="micro-label tag">THIS ROOM IS GONE</p>
        <div className="panel">
          <p>
            It was shredded, it expired, or the server restarted. Rooms live
            only in memory — there is no copy to recover, which is the point.
          </p>
          <p style={{ marginBottom: 0 }}>
            <a href="/">← New room</a>
          </p>
        </div>
      </main>
    );
  }

  if (phase.kind === "auth-failed") {
    return (
      <main className="landing">
        <h1 className="mono">RÚNA</h1>
        <div className="panel">
          <p>Wrong passphrase, or this room no longer exists.</p>
          <a href="/">← Back</a>
        </div>
      </main>
    );
  }

  if (phase.kind === "purged") {
    return <Purged />;
  }

  if (phase.kind !== "live") {
    return (
      <main className="landing">
        <p className="micro-label">{phase.kind === "connecting" ? "CONNECTING…" : ""}</p>
      </main>
    );
  }

  const panesClass = mode === "split" ? "panes" : mode === "editor" ? "panes editor-only" : "panes preview-only";

  const showLadderBanner = ladder.kind === "watch" || ladder.kind === "armed" || ladder.kind === "burn";

  return (
    <div className="room-shell">
      {showLadderBanner && (
        <div className="banner" role="status">
          <span className="mono">
            {ladder.kind === "burn"
              ? `This room is being destroyed in ${formatCountdown(ladder.remainingMs)}.`
              : ladder.kind === "armed"
                ? `This room expires in ${Math.ceil(ladder.remainingMs / 1000)} seconds.`
                : `This room expires in ${formatCountdown(ladder.remainingMs)}.`}
          </span>
          {ladder.kind !== "burn" && (
            <>
              <button onClick={() => sessionRef.current?.extendExpiry(1800)}>Extend +30m</button>
              <button onClick={() => void exportPdf()}>Export</button>
              <button className="danger" onClick={startShred}>
                Shred now
              </button>
            </>
          )}
        </div>
      )}
      {diverged && (
        <div className="banner" role="alert">
          <span>Your copy differs from other peers.</span>
          <button onClick={() => setDiverged(false)}>Dismiss</button>
        </div>
      )}
      {ttlMismatch && (
        <div className="banner" role="alert">
          <span>The server reports a different expiry than this room was created with.</span>
          <button onClick={() => setTtlMismatch(false)}>Dismiss</button>
        </div>
      )}
      <div className="statusbar">
        <span className="accent-dot" aria-hidden="true" />
        <span className="micro-label" style={{ color: "var(--accent)" }}>
          {props.name ?? "ROOM"}
        </span>
        {fingerprint && (
          <>
            <span className="sep micro-label" aria-hidden="true" />
            <span className="micro-label mono" style={{ letterSpacing: "0.08em" }} title="Room fingerprint — compare out of band">
              {fingerprint}
            </span>
          </>
        )}
        <span className="sep micro-label" aria-hidden="true" />
        <span className="micro-label" style={{ color: "var(--accent)" }}>{TEMBER_LABEL[temper]}</span>
        <span className="sep micro-label" aria-hidden="true" />
        <span className="sep micro-label" aria-hidden="true" />
        <span className="micro-label mono">{peerCount} PEERS</span>
        <span style={{ flex: 1 }} />
        {ladder.kind !== "normal" && ladder.kind !== "none" && (
          <span className="micro-label mono" style={{ color: "var(--accent)" }}>
            {formatCountdown(ladder.remainingMs)}
          </span>
        )}
        <QuorumDial peers={[]} />
        <button onClick={copyLink}>Copy link</button>
        <button onClick={cycleMode} title="Ctrl+\">Layout</button>
        <button
          aria-pressed={steady}
          title="Constant-rate transmission: closes the typing-cadence channel at a bandwidth cost"
          onClick={() => {
            const next = !steady;
            setSteady(next);
            sessionRef.current?.setSteadyTraffic(next);
          }}
        >
          Steady{steady ? " ·" : ""}
        </button>
        <button onClick={() => void exportPdf()}>Export</button>
        <button className="danger" onClick={startShred}>
          Shred
        </button>
      </div>

      {showExtNotice && (
        <div className="banner" role="note">
          <span>Extensions can read this page. Use a clean profile for anything that matters.</span>
          <button
            onClick={() => {
              extNoticeShown = true;
              setShowExtNotice(false);
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      <div className={panesClass}>
        <div className="pane-editor">
          <div className="row" style={{ padding: "4px 8px", borderBottom: "1px solid var(--hairline)", flexWrap: "wrap" }}>
            {TOOLBAR_ACTIONS.map((a) => (
              <button
                key={a.title}
                title={a.title}
                className="mono"
                style={{ padding: "2px 8px", fontSize: 12 }}
                onClick={() => editorRef.current && applyTool(editorRef.current, a)}
              >
                {a.label}
              </button>
            ))}
          </div>
          <div
            spellCheck={false}
            autoCorrect="off"
            translate="no"
            data-gramm="false"
            style={{ height: "100%", display: "flex", flexDirection: "column" }}
          >
            <Editor
              defaultLanguage="markdown"
              options={MONACO_OPTIONS}
              onMount={(editor) => void onEditorMount(editor)}
              theme="vs-dark"
            />
          </div>
        </div>
        <div
          className="pane-preview"
          ref={previewPaneRef}
          onClickCapture={(e) => {
            const anchor = (e.target as HTMLElement).closest("a");
            if (!anchor) return;
            const href = anchor.getAttribute("href") ?? "";
            if (!isExternalHref(href)) return;
            if (externalConfirmed) return;
            e.preventDefault();
            if (window.confirm("This leaves RÚNA and tells that site you were here.")) {
              externalConfirmed = true;
              window.open(href, "_blank", "noopener,noreferrer");
            }
          }}
        >
          <div
            className="preview-body"
            // Sanitised output only — pipeline.ts runs rehype-sanitize LAST.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>

      <ShredModal
        open={shredOpen}
        policy={shredPolicy}
        onPolicyChange={(p) => setShredPolicy(p)}
        peers={
          tally
            ? Array.from({ length: tally.total }, (_, i) => ({
                peerIdB64: String(i),
                approved: i < tally.approved,
                unreachable: !!tally.waitingOn && i === tally.total - 1 && shredLabel === "STALLED",
              }))
            : []
        }
        state={shredLabel}
        onCancel={() => {
          setShredOpen(false);
          sessionRef.current?.cancelShred();
          setTemper("SECURE");
        }}
        onConfirm={() => {
          setShredLabel("VOTING");
        }}
      />
      {shredPrompt && (
        <ShredVotePrompt
          onDecide={(choice) => {
            const req = shredPrompt;
            setShredPrompt(null);
            setShredOpen(false);
            void sessionRef.current?.respondToShred(req, choice);
          }}
        />
      )}
      <ToastRegion />
    </div>
  );
}

const TEMBER_LABEL: Partial<Record<TemperState, string>> = {
  COLD: "COLD",
  SECURE: "SECURE",
  WATCH: "WATCH",
  ARMED: "ARMED",
  BURN: "BURN",
};

function Purged() {
  useEffect(() => {
    window.location.replace("/gone.html");
  }, []);
  return null;
}

function ShredVotePrompt({ onDecide }: { onDecide(choice: "APPROVE" | "REJECT"): void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="vote-title">
        <h2 id="vote-title" className="micro-label">SHRED REQUESTED BY A PEER</h2>
        <p>{LIMIT_COPY}</p>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={() => onDecide("REJECT")}>Reject</button>
          <button className="danger" onClick={() => onDecide("APPROVE")}>Approve</button>
        </div>
      </div>
    </div>
  );
}

const LIMIT_COPY =
  "This destroys the shared copy and the keys. It cannot reach copies other people already made.";

function PassphraseGate({ name, onSubmit }: { name: string; onSubmit(p: string): Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="landing">
      <h1 className="mono">RÚNA</h1>
      <p className="micro-label tag">NAMED ROOM · {name.toUpperCase()}</p>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          // Without the reset the button stays stuck on "Deriving keys…" for
          // any path that returns without replacing this component.
          void onSubmit(value).finally(() => setBusy(false));
        }}
      >
        <div className="field">
          <label className="micro-label" htmlFor="pp">PASSPHRASE</label>
          {/* Not a real autocomplete token: browsers fall back to "on" and
              may offer to remember a passphrase for an ephemeral room. */}
          <input id="pp" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <button disabled={busy}>{busy ? "Deriving keys…" : "Enter room"}</button>
      </form>
    </main>
  );
}

let announcer: ((msg: string) => void) | null = null;
export function announce(msg: string): void {
  announcer?.(msg);
}

function ToastRegion() {
  const [toasts, setToasts] = useState<string[]>([]);
  useEffect(() => {
    announcer = (msg) => setToasts((t) => [...t, msg]);
    return () => {
      announcer = null;
    };
  }, []);
  useEffect(() => {
    if (!toasts.length) return;
    const id = setTimeout(() => setToasts((t) => t.slice(1)), 3500);
    return () => clearTimeout(id);
  }, [toasts]);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toasts.map((t, i) => (
        <div key={i} className="toast">{t}</div>
      ))}
    </div>
  );
}

export const MONACO_OPTIONS = {
  language: "markdown",
  wordWrap: "on",
  tabSize: 2,
  insertSpaces: true,
  renderWhitespace: "selection",
  minimap: { enabled: false },
  // Without this Monaco never observes container resizes, so its cached
  // dimensions go stale and pointer coordinates map to the wrong glyph —
  // drag-selection and touch-selection silently stop working while
  // keyboard selection (ctrl/cmd+A) still behaves.
  automaticLayout: true,
  contextmenu: true,
  quickSuggestions: false,
  wordBasedSuggestions: "off",
  "semanticHighlighting.enabled": false,
  accessibilitySupport: "auto",
  spellcheck: false,
} as const;

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isLoopbackOrigin(): boolean {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
}

function websocketUrl(roomIdHex: string): { url: string; insecure: boolean } {
  const proto = window.location.protocol === "https:" ? "wss://" : "ws://";
  if (proto === "ws://" && !isLoopbackOrigin()) {
    throw new Error("INSECURE_ORIGIN");
  }
  return { url: `${proto}${window.location.host}/socket/${roomIdHex}`, insecure: proto === "ws://" };
}

function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
