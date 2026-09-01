#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "── server ──"
cargo test -p runa-server --locked
cargo clippy -p runa-server --all-targets --locked -- -D warnings
cargo check --target x86_64-unknown-linux-gnu -p runa-server --locked

echo "── release binary (needed by the end-to-end checks) ──"
cargo build --release -p runa-server --locked

echo "── web ──"
(cd web && npx tsc -b && npx eslint src && npx vitest run && npm run build && node scripts/check-origins.mjs)

echo "── end to end ──"
# The unit suites cannot see CSP, Trusted Types, or the real wire format.
# These two can, and they are the only things that would have caught the
# Monaco policy allow-list.
(
  cd web
  ../target/release/runa-server >/tmp/runa-verify.log 2>&1 &
  server=$!
  trap 'kill $server 2>/dev/null || true' EXIT
  for _ in $(seq 1 40); do
    curl -sf http://127.0.0.1:3000/version >/dev/null && break
    sleep 0.25
  done
  node scripts/e2e-smoke.mjs
  kill $server 2>/dev/null || true
  wait $server 2>/dev/null || true
  node scripts/e2e-browser.mjs
)

echo "── repo hygiene ──"
! git ls-files --error-unmatch web/tsconfig.tsbuildinfo 2>/dev/null || {
  echo "FAIL: tsbuildinfo is tracked"
  exit 1
}

echo ""
echo "VERIFIED"
