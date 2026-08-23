import { useEffect, useRef } from "react";
import { TEMPER, type TemperState } from "./temper";

export interface DialPeer {
  peerIdB64: string;
  approved: boolean;
  unreachable: boolean;
}

export function QuorumDial({ peers }: { peers: DialPeer[] }) {
  return (
    <span className="quorum-dial" aria-hidden="true">
      {peers.map((p, i) => (
        <span key={`${p.peerIdB64}-${i}`}>{p.unreachable ? "◑" : p.approved ? "●" : "◯"}</span>
      ))}
      {" "}
    </span>
  );
}

export function QuorumLiveRegion({ peers, waitingOnHandle }: { peers: DialPeer[]; waitingOnHandle?: string }) {
  const approved = peers.filter((p) => p.approved).length;
  const text =
    peers.length === 0
      ? "No vote open."
      : waitingOnHandle
        ? `${approved} of ${peers.length} peers approved. Waiting on peer ${waitingOnHandle}.`
        : `${approved} of ${peers.length} peers approved.`;
  return (
    <span role="status" aria-live="polite" className="micro-label">
      {text}
    </span>
  );
}

export function useAccent(state: TemperState): void {
  useTemperEffect(state);
}

export function useTemperEffect(state: TemperState): void {
  const prev = useRef<TemperState>("COLD");
  useEffect(() => {
    const order: TemperState[] = ["COLD", "SECURE", "WATCH", "ARMED", "BURN"];
    if (order.indexOf(state) < order.indexOf(prev.current)) return;
    prev.current = state;
    document.documentElement.style.setProperty("--accent", TEMPER[state].hex);
  }, [state]);
}
