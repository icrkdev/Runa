#!/usr/bin/env bash
#
# One command, run from the Mac. Idempotent: re-run it to ship an update.
#
#   ./scripts/deploy-oracle.sh
#
# What it does, in order: refuses to run on a dirty tree, builds the web
# bundle, records the bundle digest the same way the release workflow does,
# ships the committed source and the bundle, builds on the box, installs the
# binary/assets/unit, wires the Caddy vhost behind a validate-and-rollback
# guard, and then proves the deployment from outside.
#
# Nothing here touches any other site's config. The Caddy step backs the file
# up, validates, and restores the backup if validation fails.

set -euo pipefail

# ── Target. No defaults for the host: guessing wrong deploys onto the wrong
# machine, and the obvious guess is whatever box you set up first.
HOST=${RUNA_HOST:?set RUNA_HOST, e.g. runa.example.com}
BOX_IP=${RUNA_BOX_IP:?set RUNA_BOX_IP, the instance public IP}
SSH_USER=${RUNA_SSH_USER:-ubuntu}
SSH_KEY=${RUNA_SSH_KEY:-$HOME/.ssh/runa_oracle}
SKIP_WEB_BUILD=${RUNA_SKIP_WEB_BUILD:-0}

# Sizing. The cgroup cap and the RUNA_* ceilings must move together, or the
# kernel kills the process and every live document dies with it:
#   peak ~= 25 MB + 1.4 x LOG_MB + (CONNECTIONS x QUEUE_KB) + ~32 MB
# Defaults suit a host with ~4 GB to spare. Override for a bigger one.
MEM_MAX=${RUNA_MEM_MAX:-2G}
MEM_HIGH=${RUNA_MEM_HIGH:-1700M}
LOG_MB=${RUNA_LOG_MB:-700}
MAX_ROOMS=${RUNA_ROOMS:-512}
MAX_PEERS=${RUNA_PEERS:-32}
MAX_CONNS=${RUNA_CONNS:-512}
QUEUE_KB=${RUNA_QUEUE_KB:-1024}

# A neighbouring service to health-check at the end. Empty = skip. Set it
# when this host runs something else you would hate to have disturbed.
NEIGHBOUR=${RUNA_NEIGHBOUR_URL:-}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
die()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*" >&2; exit 1; }

SSH="ssh -i $SSH_KEY -o ConnectTimeout=10 ${SSH_USER}@${BOX_IP}"

# ── 1. Local preflight ───────────────────────────────────────────────────
bold "1/8  Preflight"

[ -f "$SSH_KEY" ] || die "ssh key not found: $SSH_KEY  (set RUNA_SSH_KEY)"
ok "ssh key present"

if [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty. git archive ships the COMMITTED tree, so
        uncommitted work would be silently left behind. Commit or stash first."
fi
ok "working tree clean"

COMMIT="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
ok "shipping ${COMMIT:0:12} from $BRANCH"

# Grey cloud, not orange. A proxied record would put Cloudflare in the
# position of seeing every room path.
RESOLVED="$(dig +short "$HOST" A | head -1)"
if [ "$RESOLVED" != "$BOX_IP" ]; then
  if [ -z "$RESOLVED" ]; then
    die "$HOST does not resolve. Add an A record -> $BOX_IP, DNS only."
  fi
  die "$HOST resolves to $RESOLVED, not $BOX_IP.
        A 172.67.* or 104.21.* answer means the Cloudflare record is still
        proxied (orange cloud). Switch it to DNS only before deploying."
fi
ok "$HOST -> $BOX_IP, unproxied"

$SSH true 2>/dev/null || die "cannot ssh to $BOX_IP. Try: ssh-add $SSH_KEY"
ok "ssh reachable"

# Both of these fail at the *end* of a build that takes 10-20 minutes on a
# small instance, which is a miserable way to find out. Check them in one
# second instead.
$SSH "test -f \$HOME/.cargo/env || command -v cargo >/dev/null" \
  || die "cargo not found on the box. Install it:
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
ok "cargo present"

$SSH "command -v cc >/dev/null" \
  || die "no C toolchain on the box — rustc uses 'cc' as its linker driver, so
        the build will run for many minutes and then fail at the link step.
        Ubuntu Minimal images ship without it. Install it:
        sudo apt update && sudo apt install -y build-essential"
ok "C toolchain present"

# ── 2. Build the web bundle ──────────────────────────────────────────────
bold "2/8  Web bundle"
if [ "$SKIP_WEB_BUILD" = "1" ]; then
  warn "skipped (RUNA_SKIP_WEB_BUILD=1); reusing web/dist"
  [ -f web/dist/index.html ] || die "web/dist/index.html missing — cannot skip"
else
  (cd web && npm ci --silent && npm run build >/dev/null) || die "web build failed"
fi
ok "web/dist built"

# The release workflow hashes from inside dist. Doing it from the repo root
# yields a different digest for identical bytes, so /version would never
# match a released bundle.
BUNDLE_SHA="$(cd web/dist && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"
ok "bundle sha256 ${BUNDLE_SHA:0:16}…"

# ── 3. Package ───────────────────────────────────────────────────────────
bold "3/8  Package"
git archive --format=tar.gz -o /tmp/runa-src.tar.gz HEAD
tar -czf /tmp/runa-dist.tar.gz -C web dist
ok "source + bundle packaged"

# ── 4. Ship ──────────────────────────────────────────────────────────────
bold "4/8  Ship"
scp -q -i "$SSH_KEY" \
  /tmp/runa-src.tar.gz /tmp/runa-dist.tar.gz \
  deploy/runa.service deploy/runa.env deploy/Caddyfile.runa \
  "${SSH_USER}@${BOX_IP}:/tmp/"
ok "uploaded to /tmp on the box"

# ── 5. Build on the box ──────────────────────────────────────────────────
bold "5/8  Build on the box (several minutes on 2 OCPU; niced)"
$SSH "COMMIT=$COMMIT BUNDLE_SHA=$BUNDLE_SHA bash -euo pipefail -s" <<'REMOTE'
  if [ -f "$HOME/.cargo/env" ]; then source "$HOME/.cargo/env"; fi
  command -v cargo >/dev/null || { echo "cargo not found on the box"; exit 1; }

  rm -rf ~/runa && mkdir -p ~/runa
  tar -xzf /tmp/runa-src.tar.gz -C ~/runa
  cd ~/runa

  # --locked so the box resolves the exact dependency versions CI tested.
  RUNA_COMMIT="$COMMIT" RUNA_BUNDLE_SHA256="$BUNDLE_SHA" \
    nice -n 10 cargo build --release --locked -p runa-server
REMOTE
ok "runa-server built"

# ── 6. Install ───────────────────────────────────────────────────────────
bold "6/8  Install"
$SSH "MEM_MAX=$MEM_MAX MEM_HIGH=$MEM_HIGH LOG_MB=$LOG_MB MAX_ROOMS=$MAX_ROOMS \
      MAX_PEERS=$MAX_PEERS MAX_CONNS=$MAX_CONNS QUEUE_KB=$QUEUE_KB \
      bash -euo pipefail -s" <<'REMOTE'
  sudo install -m 755 ~/runa/target/release/runa-server /usr/local/bin/runa-server

  # Stage the bundle beside the live one and swap, so a half-extracted
  # archive is never served.
  sudo rm -rf /opt/runa.staged
  sudo mkdir -p /opt/runa.staged
  sudo tar -xzf /tmp/runa-dist.tar.gz -C /opt/runa.staged
  # DynamicUser=yes means an unpredictable UID that needs world-readable assets.
  sudo chmod -R a+rX /opt/runa.staged
  sudo rm -rf /opt/runa.previous
  if [ -d /opt/runa ]; then sudo mv /opt/runa /opt/runa.previous; fi
  sudo mv /opt/runa.staged /opt/runa

  sudo mkdir -p /etc/runa
  # Never clobber operator-tuned limits on a redeploy.
  if [ ! -f /etc/runa/runa.env ]; then
    sudo install -m 644 /tmp/runa.env /etc/runa/runa.env
    # Apply the sizing this deploy was invoked with.
    sudo sed -i \
      -e "s/^RUNA_MAX_TOTAL_LOG_MB=.*/RUNA_MAX_TOTAL_LOG_MB=$LOG_MB/" \
      -e "s/^RUNA_MAX_ROOMS=.*/RUNA_MAX_ROOMS=$MAX_ROOMS/" \
      -e "s/^RUNA_MAX_PEERS=.*/RUNA_MAX_PEERS=$MAX_PEERS/" \
      -e "s/^RUNA_MAX_CONNECTIONS=.*/RUNA_MAX_CONNECTIONS=$MAX_CONNS/" \
      -e "s/^RUNA_MAX_QUEUE_KB=.*/RUNA_MAX_QUEUE_KB=$QUEUE_KB/" \
      /etc/runa/runa.env
    echo "installed /etc/runa/runa.env (log=${LOG_MB}MB conns=$MAX_CONNS)"
  else
    echo "kept existing /etc/runa/runa.env — edit it by hand to resize"
  fi
  # The cgroup caps live in the unit, which is always rewritten, so they
  # follow the sizing the deploy was invoked with.
  sed -e "s/^MemoryMax=.*/MemoryMax=$MEM_MAX/" \
      -e "s/^MemoryHigh=.*/MemoryHigh=$MEM_HIGH/" \
      /tmp/runa.service | sudo tee /etc/systemd/system/runa.service >/dev/null
  sudo chmod 644 /etc/systemd/system/runa.service

  sudo systemctl daemon-reload
  sudo systemctl enable runa >/dev/null 2>&1 || true
  sudo systemctl restart runa
REMOTE
ok "binary, assets, unit installed and service restarted"

# ── 7. Caddy ─────────────────────────────────────────────────────────────
bold "7/8  Caddy vhost"
$SSH "RUNA_HOST=$HOST bash -euo pipefail -s" <<'REMOTE'
  CADDYFILE=/etc/caddy/Caddyfile

  # Whether the vhost is in the *running* config, which is not the same
  # question as whether it is in the file. Caddy's reload goes through its
  # admin API and can no-op silently, leaving the packaged default loaded:
  # port 80 answers, 443 does not, and no ACME attempt is ever made — which
  # looks exactly like a certificate problem and is not one.
  vhost_is_live() {
    curl -sf --max-time 3 http://127.0.0.1:2019/config/ 2>/dev/null \
      | grep -q "$RUNA_HOST"
  }

  if sudo grep -q "^${RUNA_HOST}[[:space:]]*{" "$CADDYFILE"; then
    if vhost_is_live; then
      echo "  vhost present and live; leaving it alone"
      exit 0
    fi
    echo "  vhost is in the file but NOT in the running config — restarting Caddy"
    sudo caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 \
      || { echo "  Caddyfile does not validate; refusing to restart" >&2; exit 1; }
    sudo systemctl restart caddy
    sleep 3
    vhost_is_live && echo "  vhost now live" \
      || echo "  WARNING: still not in the running config; check 'systemctl status caddy'" >&2
    exit 0
  fi

  # A broken Caddyfile takes every site on this box down, so: back up,
  # append, validate, and restore the backup if validation fails.
  BACKUP="${CADDYFILE}.bak.$(date +%s)"
  sudo cp "$CADDYFILE" "$BACKUP"
  printf '\n' | sudo tee -a "$CADDYFILE" >/dev/null
  sudo tee -a "$CADDYFILE" < /tmp/Caddyfile.runa >/dev/null

  if ! sudo caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    echo "Caddyfile failed validation — restoring $BACKUP and leaving Caddy untouched" >&2
    sudo cp "$BACKUP" "$CADDYFILE"
    exit 1
  fi
  sudo systemctl reload caddy
  echo "vhost appended, validated, Caddy reloaded (backup at $BACKUP)"
REMOTE
ok "Caddy configured"

# ── 8. Prove it ──────────────────────────────────────────────────────────
bold "8/8  Verify"

$SSH "sudo ss -ltnp 2>/dev/null | grep -q '127.0.0.1:3000'" \
  && ok "listening on loopback only" \
  || die "not bound to 127.0.0.1:3000 — check: sudo ss -ltnp | grep 3000"

$SSH "sudo journalctl -u runa --since '2 min ago' --no-pager | grep -o 'max_total_log_mib=[0-9]*' | tail -1" \
  | sed 's/^/  ceiling: /' || true

echo "  waiting for certificate issuance…"
for i in $(seq 1 30); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$HOST/" || true)"
  [ "$CODE" = "200" ] && break
  sleep 2
done
[ "${CODE:-}" = "200" ] || die "https://$HOST/ returned ${CODE:-no response} after 60s.
        Check: sudo journalctl -u caddy --since '5 min ago' | tail -30"
ok "https://$HOST/ serves 200"

VERSION="$(curl -s --max-time 5 "https://$HOST/version")"
echo "$VERSION" | grep -q "\"commit\":\"$COMMIT\"" \
  && ok "/version reports the deployed commit" \
  || warn "/version commit mismatch: $VERSION"
echo "$VERSION" | grep -q "\"bundle_sha256\":\"$BUNDLE_SHA\"" \
  && ok "/version reports the built bundle digest" \
  || warn "/version bundle mismatch: $VERSION"

LEAKED="$($SSH "curl -s -o /dev/null http://127.0.0.1:3000/ ; sudo journalctl -u caddy --since '60 sec ago' --no-pager | grep 'http.log.access' | grep -c remote_ip" || echo 0)"
[ "$LEAKED" = "0" ] \
  && ok "no client addresses in Caddy's logs" \
  || warn "$LEAKED access-log lines carried remote_ip — check the log directives"

if [ -n "$NEIGHBOUR" ]; then
  N="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$NEIGHBOUR" || true)"
  [ "$N" = "200" ] \
    && ok "$NEIGHBOUR still healthy" \
    || warn "$NEIGHBOUR returned $N — check before walking away"
fi

echo
bold "DEPLOYED  https://$HOST/"
echo "  Open it in two windows, create a room, and confirm both edit live and"
echo "  the peer count reads 2 PEERS on each — the WebSocket path is the part"
echo "  curl does not exercise."
