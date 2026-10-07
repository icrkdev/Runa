import { parseFragment } from "../keys-session";
import { nameProblem } from "./name-rules";
import { cleartextIsSafe, isPlainHostname } from "./navigate";

/// What someone typed or pasted into "Join a room", and where it leads.
export type JoinTarget =
  /// A private room with its key: ready to open. `roomIdHex` and `fragment`
  /// let a room on this server open with the key handed over in memory,
  /// never written into the address bar.
  | { kind: "private"; href: string; elsewhere: string | null; roomIdHex: string; fragment: string }
  /// A private room's id without the key, or with a key too damaged to use.
  /// Opening it can only show "this link is missing its key".
  | { kind: "private-no-key"; href: string; damaged: boolean }
  /// A shared room by name. Its page asks for the passphrase.
  | { kind: "named"; href: string; name: string; elsewhere: string | null }
  | { kind: "nothing" }
  | { kind: "unrecognised"; reason: string };

const ROOM_ID = /^[0-9a-f]{32}$/;

/// Read what people actually paste: a whole link, a link with its `https://`
/// lost, a path, a bare room id with or without its `#k=…` key, or a room's
/// name. Private links keep their fragment — the key. Nothing here sends it
/// anywhere, and a room on this server opens without it reaching the address
/// bar at all (see `keyhandoff.ts`).
///
/// `origin` is this page's. A link from another RÚNA server stays pointed at
/// that server, since a room exists only where it was made.
export function readJoinTarget(raw: string, origin: string): JoinTarget {
  const input = raw.trim();
  if (!input) return { kind: "nothing" };

  const url = asUrl(input, origin);
  if (url) {
    const elsewhere = url.origin === origin ? null : url.host;
    // Turned away before anything else is read from the link. A RÚNA link
    // never carries a user name: `https://runa.example@evil.example/…`
    // opens evil.example, whatever it looks like at a glance.
    if (url.username || url.password) {
      return { kind: "unrecognised", reason: `That link really leads to ${url.host} — everything before the “@” is a disguise. RÚNA links never contain an “@”.` };
    }
    if (!isPlainHostname(url.hostname)) {
      return { kind: "unrecognised", reason: "That link is not a RÚNA room." };
    }
    // A room's key handed to a page served in the clear is a key anyone on
    // the network can read. This server's own address is already open, so
    // only a room elsewhere is held to it.
    if (elsewhere && url.protocol === "http:" && !cleartextIsSafe(url.hostname)) {
      return { kind: "unrecognised", reason: `That link uses plain http, so anyone on the network between you and ${url.host} could read the room’s key. Ask for its https link.` };
    }
    const base = elsewhere ? url.origin : "";
    const path = url.pathname.replace(/\/+$/, "");
    const priv = path.match(/^\/r\/([0-9a-fA-F]{32})$/);
    if (priv) return privateTarget(base, priv[1].toLowerCase(), url.hash, elsewhere);
    const named = path.match(/^\/(?:n\/)?([A-Za-z0-9-]+)$/);
    if (named) {
      const name = named[1].toLowerCase();
      const problem = nameProblem(name);
      if (!problem) return { kind: "named", href: `${base}/${name}`, name, elsewhere };
    }
    return { kind: "unrecognised", reason: "That link is not a RÚNA room." };
  }

  const [head, hash = ""] = splitHash(input);
  const id = head.replace(/^\/?r\//i, "").toLowerCase();
  if (ROOM_ID.test(id)) return privateTarget("", id, hash ? `#${hash}` : "", null);

  const name = head.replace(/^\/?(?:n\/)?/i, "").toLowerCase();
  const problem = nameProblem(name);
  if (!problem) return { kind: "named", href: `/${name}`, name, elsewhere: null };
  return {
    kind: "unrecognised",
    reason: /\s/.test(name)
      ? "Room names have no spaces — paste the room's link, or type its name with hyphens."
      : "Not a room link or a room name. Paste the whole link someone shared, or type a shared room's name.",
  };
}

function privateTarget(base: string, roomIdHex: string, hash: string, elsewhere: string | null): JoinTarget {
  const href = `${base}/r/${roomIdHex}`;
  if (!hash || hash === "#") return { kind: "private-no-key", href, damaged: false };
  if (!parseFragment(hash)) return { kind: "private-no-key", href, damaged: true };
  return { kind: "private", href: `${href}${hash}`, elsewhere, roomIdHex, fragment: hash };
}

function splitHash(s: string): [string, string?] {
  const i = s.indexOf("#");
  return i < 0 ? [s] : [s.slice(0, i), s.slice(i + 1)];
}

/// A pasted link, whether or not it kept its scheme. Anything that is not
/// plainly one — a bare name, a bare id, a path — is not treated as a URL.
function asUrl(input: string, origin: string): URL | null {
  const withScheme = /^https?:\/\//i.test(input)
    ? input
    : /^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?\//i.test(input) || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(input)
      ? `${schemeFor(input, origin)}//${input}`
      : null;
  if (!withScheme) return null;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/// The scheme a link pasted without one most likely had: this page's own, if
/// it names this server; plain http for an onion or this machine, which is
/// how those are served; https for everything else, never a guess at http.
function schemeFor(input: string, origin: string): string {
  const here = new URL(origin);
  const host = input.slice(0, input.indexOf("/")).toLowerCase();
  if (host === here.host) return here.protocol;
  return cleartextIsSafe(host.replace(/:\d+$/, "")) ? "http:" : "https:";
}
