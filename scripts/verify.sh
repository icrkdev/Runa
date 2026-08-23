#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "── server ──"
cargo test -p runa-server --locked
cargo clippy -p runa-server --all-targets --locked -- -D warnings
cargo check --target x86_64-unknown-linux-gnu -p runa-server --locked

echo "── web ──"
(cd web && npx tsc -b && npx eslint src && npx vitest run && npm run build && node scripts/check-origins.mjs)

echo "── repo hygiene ──"
! git ls-files --error-unmatch web/tsconfig.tsbuildinfo 2>/dev/null || {
  echo "FAIL: tsbuildinfo is tracked"
  exit 1
}

echo ""
echo "VERIFIED"
