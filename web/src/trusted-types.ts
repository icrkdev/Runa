/// The CSP enforces Trusted Types. Monaco writes to DOM sinks internally and
/// does not create a policy of its own, so a `default` policy has to exist or
/// the editor will not run at all.
///
/// What that policy must NOT be is `(input) => input` for both callbacks. A
/// pass-through `createScriptURL` turns `require-trusted-types-for 'script'`
/// into decoration: any string reaching a script-URL sink is waved through,
/// and the header stops meaning anything. Script URLs are checked here
/// against the one thing Monaco actually needs — same-origin module and blob
/// worker URLs — so the enforcement boundary survives.
///
/// `createHTML` stays permissive and that is a real, known limit: it is a
/// compatibility shim for Monaco's own DOM writes, not a sanitiser. RÚNA's
/// only untrusted-HTML sink is the markdown preview, which is guarded by
/// rehype-sanitize in `render/pipeline.ts` — that is the control that matters
/// for document content. Reviewed at every dependency bump.
interface TrustedTypesShim {
  createPolicy(name: string, rules: Record<string, (input: string) => string>): unknown;
  defaultPolicy?: unknown;
}

/// Same-origin `blob:`/`http(s):` URLs only. Anything else throws, which is
/// what a Trusted Types violation should do.
export function assertSameOriginScriptUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input, window.location.href);
  } catch {
    throw new TypeError(`blocked script URL: ${input}`);
  }
  if (url.protocol === "blob:") {
    // blob: URLs carry their creating origin as the path.
    // A real blob URL is `blob:<origin>/<uuid>`. Match on the origin plus its
    // separator, or `https://runa.example.evil.com/…` would slip through on a
    // bare prefix test.
    const inner = url.pathname;
    if (inner.startsWith(`${window.location.origin}/`)) return input;
    throw new TypeError(`blocked cross-origin blob script URL: ${input}`);
  }
  if (url.origin !== window.location.origin) {
    throw new TypeError(`blocked cross-origin script URL: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`blocked script URL scheme: ${url.protocol}`);
  }
  return input;
}

export function installTrustedTypesFallback(): void {
  const tt = (window as unknown as { trustedTypes?: TrustedTypesShim }).trustedTypes;
  if (!tt || tt.defaultPolicy) return;
  tt.createPolicy("default", {
    createHTML: (input) => input,
    createScriptURL: assertSameOriginScriptUrl,
  });
}
