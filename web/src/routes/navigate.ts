/// The last check before Join or Create moves the page.
///
/// `readJoinTarget` and `nameProblem` already refuse everything hostile, so
/// this should never say no. It sits at the sink anyway: whatever a later
/// change to the parsing lets through, the page only ever goes to a path on
/// this server or to a room on another RÚNA server — the one place a pasted
/// link is meant to lead elsewhere. Never to `javascript:`, `data:`, or a
/// protocol-relative `//host` dressed as a path; never to a link that hides
/// its real host behind an `@`; and never over plain http where the network
/// could read the key, except to an onion or to this machine.
///
/// A yes/no on the very string that gets opened, rather than a cleaned-up
/// copy, so the check and the navigation cannot disagree about the destination.
export function isSafeDestination(href: string, origin: string = window.location.origin): boolean {
  if (/^\/(?![/\\])/.test(href)) {
    // Parse rather than trust the prefix: the URL parser drops tabs and
    // newlines and reads `\` as `/`, so only the resolved origin says where
    // a path really goes.
    try {
      return new URL(href, origin).origin === origin;
    } catch {
      return false;
    }
  }
  if (!/^https?:\/\//i.test(href)) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.username || url.password || !isPlainHostname(url.hostname)) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && cleartextIsSafe(url.hostname);
}

/// `location.assign`, but only to somewhere `isSafeDestination` allows.
export function navigateTo(href: string): void {
  if (isSafeDestination(href)) window.location.assign(href);
}

/// Whether a room on `hostname` may be opened over plain http. A key in a
/// page served in the clear is a key anyone on the path can read, by
/// injecting a script into that page. An onion address is the server's own
/// public key, so Tor authenticates and encrypts the whole way; loopback
/// never leaves the machine. Nothing else qualifies — and WebCrypto refuses
/// to run on any other http page, so nothing else could host a room anyway.
export function cleartextIsSafe(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return (
    h.endsWith(".onion") ||
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(h)
  );
}

/// A DNS name, an IPv4 address or a bracketed IPv6 address — what a server
/// can be called. The URL parser lets through `"`, `'`, `&` and `=` in a
/// host; none of those reach a real server.
export function isPlainHostname(hostname: string): boolean {
  return /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?)$/i.test(hostname);
}
