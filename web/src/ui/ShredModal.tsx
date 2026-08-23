import { useEffect, useRef } from "react";
import type { DialPeer } from "./dial";

export type Policy = "UNANIMOUS" | "MAJORITY" | "THRESHOLD" | "INITIATOR";

/// The k in THRESHOLD(k). Exported so the option label and the request that
/// the label describes can never disagree.
export const THRESHOLD_K = 2;

export interface ShredModalProps {
  open: boolean;
  policy: Policy;
  onPolicyChange(policy: Policy): void;
  peers: DialPeer[];
  waitingOnHandle?: string;
  state: string;
  onConfirm(policy: Policy): void;
  onCancel(): void;
}

const LIMIT_COPY =
  "This destroys the shared copy and the keys. It cannot reach copies other people already made.";

export function ShredModal(props: ShredModalProps) {
  const { open } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onCancel();
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll("button");
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, [open, props]);

  if (!open) return null;

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="shred-title"
        aria-describedby="shred-desc"
        ref={dialogRef}
      >
        <h2 id="shred-title" className="micro-label">SHRED · {props.policy}</h2>
        <p id="shred-desc">{LIMIT_COPY}</p>
        {props.policy === "UNANIMOUS" && (
          <p className="hint">
            A single peer can block this. That is what unanimous means.
            {props.waitingOnHandle ? ` Waiting on ${props.waitingOnHandle}.` : ""}
          </p>
        )}
        {props.state === "IDLE" && (
          <div style={{ margin: "14px 0" }}>
            <label className="micro-label" htmlFor="shred-policy">
              CONSENSUS POLICY
            </label>
            <select
              id="shred-policy"
              value={props.policy}
              onChange={(e) => props.onPolicyChange(e.target.value as Policy)}
              style={{
                background: "var(--surface-raised)",
                border: "1px solid var(--hairline)",
                color: "var(--text)",
                padding: "8px",
                width: "100%",
                marginTop: 6,
              }}
            >
              <option value="UNANIMOUS">Unanimous — every peer must agree</option>
              <option value="MAJORITY">Majority — more than half</option>
              <option value="THRESHOLD">Threshold — at least {THRESHOLD_K} peers</option>
              <option value="INITIATOR">Initiator — you alone decide</option>
            </select>
            {props.policy === "UNANIMOUS" && (
              <p className="hint">
                A single peer can block this. That is what unanimous means.
              </p>
            )}
            {props.policy === "MAJORITY" && (
              <p className="hint">More than half of the connected peers.</p>
            )}
            {props.policy === "THRESHOLD" && (
              <p className="hint">At least {THRESHOLD_K} of the connected peers.</p>
            )}
            {props.policy === "INITIATOR" && (
              <p className="hint">You can destroy the room without asking anyone.</p>
            )}
          </div>
        )}
        <div style={{ margin: "14px 0" }}>
          <QuorumInline peers={props.peers} />
          <p className="mono micro-label">{props.state}</p>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button ref={cancelRef} onClick={props.onCancel}>Cancel</button>
          <button className="danger" onClick={() => props.onConfirm(props.policy)}>Shred</button>
        </div>
      </div>
    </div>
  );
}

function QuorumInline({ peers }: { peers: DialPeer[] }) {
  if (peers.length === 0) return null;
  return (
    <span className="quorum-dial">
      {peers.map((p, i) => (
        <span key={i}>{p.unreachable ? "◑" : p.approved ? "●" : "◯"}</span>
      ))}
    </span>
  );
}
