/// The last check before Join or Create moves the page.
///
/// `readJoinTarget` and `nameProblem` already refuse everything hostile, so
/// this should never say no. It sits at the sink anyway: whatever a later
/// change to the parsing lets through, the page only ever goes to a path on
/// this server or to an http(s) link — a room on another RÚNA server, which
/// is the one place a pasted link is meant to lead elsewhere. Never to
/// `javascript:`, `data:`, or a protocol-relative `//host` dressed as a path.
export function navigableHref(href: string, origin: string): string | null {
  if (/^\/(?![/\\])/.test(href)) {
    // Parse rather than trust the prefix: the URL parser drops tabs and
    // newlines and reads `\` as `/`, so only the resolved origin says where
    // a path really goes.
    let url: URL;
    try {
      url = new URL(href, origin);
    } catch {
      return null;
    }
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : null;
  }
  if (!/^https?:\/\//i.test(href)) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/// `location.assign`, but only to somewhere `navigableHref` allows.
export function navigateTo(href: string): void {
  const safe = navigableHref(href, window.location.origin);
  if (safe !== null) window.location.assign(safe);
}
