/// The last check before Join or Create moves the page.
///
/// `readJoinTarget` and `nameProblem` already refuse everything hostile, so
/// this should never say no. It sits at the sink anyway: whatever a later
/// change to the parsing lets through, the page only ever goes to a path on
/// this server or to an http(s) link — a room on another RÚNA server, which
/// is the one place a pasted link is meant to lead elsewhere. Never to
/// `javascript:`, `data:`, or a protocol-relative `//host` dressed as a path.
///
/// A yes/no on the very string that gets opened, rather than a cleaned-up
/// copy, so the check and the navigation cannot disagree about where it goes.
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
  try {
    const { protocol } = new URL(href);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/// `location.assign`, but only to somewhere `isSafeDestination` allows.
export function navigateTo(href: string): void {
  if (isSafeDestination(href)) window.location.assign(href);
}
