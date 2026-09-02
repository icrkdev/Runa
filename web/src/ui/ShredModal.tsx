import { useEffect, useRef } from "react";
import type { DialPeer } from "./dial";
import { supermajorityFor, type Policy } from "../shred/machine";

export type { Policy };

export interface ShredModalProps {
  open: boolean;
  /// How many people are in the room, so the dialog can state the actual bar
  /// rather than a constant that stopped being true as people joined.
  peerCount: number;
  /// Handles of people who were in the room within the last few minutes and
  /// are not connected now — a locked phone looks exactly like a closed tab.
  awayNames?: string[];
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

  // Kept in a ref so the effect below can depend on `open` alone. Depending
  // on `props` re-ran it on every render — and the expiry countdown ticks
  // four times a second — so focus was yanked back to Cancel continuously,
  // which collapses an open dropdown before anyone can pick anything.
  const onCancelRef = useRef(props.onCancel);
  onCancelRef.current = props.onCancel;

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelRef.current();
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
  }, [open]);

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
        {props.state === "IDLE" && (props.awayNames?.length ?? 0) > 0 && (
          <p className="error-text" role="alert">
            <strong>{formatNames(props.awayNames ?? [])}</strong>{" "}
            {props.awayNames?.length === 1 ? "was" : "were"} here a moment ago
            and {props.awayNames?.length === 1 ? "is" : "are"} not connected
            now — a locked phone looks the same as a closed tab.{" "}
            {props.awayNames?.length === 1 ? "They cannot" : "They cannot"} vote
            while away, so shredding now decides without{" "}
            {props.awayNames?.length === 1 ? "them" : "them"}.
          </p>
        )}
        {props.policy === "UNANIMOUS" && (
          <p className="hint">
            Any one person can block this. That is what unanimous means.
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
              <option value="UNANIMOUS">Everyone here must agree</option>
              <option value="MAJORITY">More than half must agree</option>
              <option value="THRESHOLD">
                Two-thirds must agree ({supermajorityFor(props.peerCount)} of {props.peerCount})
              </option>
            </select>
            {props.policy === "UNANIMOUS" && (
              <p className="hint">
                Any one person can block this — including someone who is away.
              </p>
            )}
            {props.policy === "MAJORITY" && (
              <p className="hint">
                {Math.floor(props.peerCount / 2) + 1} of the {props.peerCount} people
                connected right now.
              </p>
            )}
            {props.policy === "THRESHOLD" && (
              <p className="hint">
                {supermajorityFor(props.peerCount)} of the {props.peerCount} people
                connected right now — stricter than a majority, but one person
                cannot block it.
              </p>
            )}
          </div>
        )}
        <div style={{ margin: "14px 0" }}>
          <QuorumInline peers={props.peers} />
          {humanState(props.state) && (
            <p className="micro-label">{humanState(props.state)}</p>
          )}
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button ref={cancelRef} onClick={props.onCancel}>Cancel</button>
          <button className="danger" onClick={() => props.onConfirm(props.policy)}>Shred</button>
        </div>
      </div>
    </div>
  );
}

/// The machine's state names are for the machine. Anything unrecognised is
/// passed through, because the session also routes human messages (an
/// extension notice, say) down this same channel.
/// "COPPER-LANTERN", "COPPER-LANTERN and TIN-HARBOUR", "A, B and C".
function formatNames(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function humanState(state: string): string {
  switch (state) {
    case "IDLE":
      return "";
    case "VOTING":
      return "Waiting for everyone to decide…";
    case "STALLED":
      return "Waiting on someone who is away";
    case "APPROVED":
      return "Everyone agreed — destroying the room";
    case "REJECTED":
      return "Someone declined. The room stays.";
    case "EXPIRED":
      return "Nobody answered in time. The room stays.";
    case "PURGING":
    case "GONE":
      return "Destroying the room";
    default:
      return state;
  }
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
