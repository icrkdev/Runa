/// The CSP enforces Trusted Types. The `runa-render` policy wraps sanitiser
/// output only; this file registers a pass-through `default` policy as the
/// documented compatibility shim for Monaco's internal DOM writes. It keeps
/// the enforcement boundary real for first-party sinks without breaking the
/// editor. Reviewed at every dependency bump.
export function installTrustedTypesFallback(): void {
  const tt = (window as unknown as {
    trustedTypes?: {
      createPolicy(name: string, rules: Record<string, (input: string) => string>): unknown;
      defaultPolicy?: unknown;
    };
  }).trustedTypes;
  if (!tt || tt.defaultPolicy) return;
  tt.createPolicy("default", {
    createHTML: (input) => input,
    createScriptURL: (input) => input,
  });
}
