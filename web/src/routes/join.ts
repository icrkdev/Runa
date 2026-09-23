import { parseFragment } from "../keys-session";
import { nameProblem } from "./name-rules";

/// What someone typed or pasted into "Join a room", and where it leads.
export type JoinTarget =
  /// A private room with its key: ready to open.
  | { kind: "private"; href: string; elsewhere: string | null }
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
/// name. Private links keep their fragment — the key — and it goes no further
/// than the address bar: nothing here sends it anywhere.
///
/// `origin` is this page's. A link from another RÚNA server stays pointed at
/// that server, since a room exists only where it was made.
export function readJoinTarget(raw: string, origin: string): JoinTarget {
  const input = raw.trim();
  if (!input) return { kind: "nothing" };

  const url = asUrl(input, origin);
  if (url) {
    const elsewhere = url.origin === origin ? null : url.host;
    const base = elsewhere ? url.origin : "";
    const path = url.pathname.replace(/\/+$/, "");
    const priv = path.match(/^\/r\/([0-9a-fA-F]{32})$/);
    if (priv) return privateTarget(`${base}/r/${priv[1].toLowerCase()}`, url.hash, elsewhere);
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
  if (ROOM_ID.test(id)) return privateTarget(`/r/${id}`, hash ? `#${hash}` : "", null);

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

function privateTarget(href: string, hash: string, elsewhere: string | null): JoinTarget {
  if (!hash || hash === "#") return { kind: "private-no-key", href, damaged: false };
  if (!parseFragment(hash)) return { kind: "private-no-key", href, damaged: true };
  return { kind: "private", href: `${href}${hash}`, elsewhere };
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
      ? `${new URL(origin).protocol}//${input}`
      : null;
  if (!withScheme) return null;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
