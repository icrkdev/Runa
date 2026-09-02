#!/usr/bin/env bash
#
# Deploy RÚNA to a shared VM as an isolated Docker container.
#
#   ./scripts/deploy-docker.sh
#
# The box builds the image itself, so the only prerequisite on your Mac is
# ssh. Nothing about this touches any other service on the box: RÚNA gets its
# own image, its own container, its own filesystem, and a published port bound
# to loopback so the proxy is the only route in.
#
# Idempotent — re-run it to ship an update.

set -euo pipefail

# ── Target. No defaults for the host: guessing wrong deploys onto the wrong
# machine, and the obvious guess is whatever box you set up first.
HOST=${RUNA_HOST:?set RUNA_HOST, e.g. runa.example.com}
BOX_IP=${RUNA_BOX_IP:?set RUNA_BOX_IP, the instance public IP}
SSH_USER=${RUNA_SSH_USER:-ubuntu}
SSH_KEY=${RUNA_SSH_KEY:-$HOME/.ssh/runa_oracle}

# Sizing. Container memory and the RUNA_* ceilings must move together:
#   peak ~= 25 MB + 1.4 x LOG_MB + (CONNECTIONS x QUEUE_KB) + ~32 MB
MEM=${RUNA_MEM:-2g}
LOG_MB=${RUNA_LOG_MB:-700}
MAX_ROOMS=${RUNA_ROOMS:-512}
MAX_PEERS=${RUNA_PEERS:-32}
MAX_CONNS=${RUNA_CONNS:-512}
QUEUE_KB=${RUNA_QUEUE_KB:-1024}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
die()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*" >&2; exit 1; }

SSH="ssh -i $SSH_KEY -o ConnectTimeout=10 ${SSH_USER}@${BOX_IP}"

# ── 1. Preflight ─────────────────────────────────────────────────────────
bold "1/6  Preflight"

[ -f "$SSH_KEY" ] || die "ssh key not found: $SSH_KEY  (set RUNA_SSH_KEY)"
ok "ssh key present"

if [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty. git archive ships the COMMITTED tree, so
        uncommitted work would be silently left behind. Commit or stash first."
fi
COMMIT="$(git rev-parse HEAD)"
ok "shipping ${COMMIT:0:12} from $(git rev-parse --abbrev-ref HEAD)"

RESOLVED="$(dig +short "$HOST" A | head -1)"
if [ "$RESOLVED" != "$BOX_IP" ]; then
  [ -z "$RESOLVED" ] && die "$HOST does not resolve. Add an A record -> $BOX_IP, DNS only."
  die "$HOST resolves to $RESOLVED, not $BOX_IP.
        A 172.67.* or 104.21.* answer means the Cloudflare record is still
        proxied (orange cloud). Switch it to DNS only before deploying."
fi
ok "$HOST -> $BOX_IP, unproxied"

$SSH true 2>/dev/null || die "cannot ssh to $BOX_IP. Try: ssh-add $SSH_KEY"
$SSH "command -v docker >/dev/null" \
  || die "docker is not installed on the box. Install it first:
        ssh -i $SSH_KEY ${SSH_USER}@${BOX_IP}
        curl -fsSL https://get.docker.com | sudo sh
        sudo usermod -aG docker \$USER   # then log out and back in"
ok "docker present on the box"

# ── 2. Ship the source ───────────────────────────────────────────────────
bold "2/6  Ship"
git archive --format=tar.gz -o /tmp/runa-src.tar.gz HEAD
scp -q -i "$SSH_KEY" /tmp/runa-src.tar.gz deploy/Caddyfile.runa \
  "${SSH_USER}@${BOX_IP}:/tmp/"
ok "source uploaded"

# ── 3. Build the image on the box ────────────────────────────────────────
bold "3/6  Build image (10-15 min the first time; layer-cached after)"
$SSH "COMMIT=$COMMIT bash -euo pipefail -s" <<'REMOTE'
  rm -rf ~/runa-build && mkdir -p ~/runa-build
  tar -xzf /tmp/runa-src.tar.gz -C ~/runa-build
  cd ~/runa-build
  docker build \
    --build-arg "RUNA_COMMIT=$COMMIT" \
    -t "runa:$COMMIT" -t runa:latest .
REMOTE
ok "image built and tagged runa:latest"

# ── 4. Run it ────────────────────────────────────────────────────────────
bold "4/6  Start container"
$SSH "MEM=$MEM LOG_MB=$LOG_MB MAX_ROOMS=$MAX_ROOMS MAX_PEERS=$MAX_PEERS \
      MAX_CONNS=$MAX_CONNS QUEUE_KB=$QUEUE_KB bash -euo pipefail -s" <<'REMOTE'
  docker rm -f runa >/dev/null 2>&1 || true
  docker run -d \
    --name runa \
    --restart unless-stopped \
    -p 127.0.0.1:3000:3000 \
    --memory="$MEM" --memory-swap="$MEM" \
    --pids-limit=256 \
    --read-only \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    -e RUNA_BIND=0.0.0.0:3000 \
    -e RUNA_TRUSTED_PROXY=1 \
    -e RUNA_MAX_TOTAL_LOG_MB="$LOG_MB" \
    -e RUNA_MAX_ROOMS="$MAX_ROOMS" \
    -e RUNA_MAX_PEERS="$MAX_PEERS" \
    -e RUNA_MAX_CONNECTIONS="$MAX_CONNS" \
    -e RUNA_MAX_QUEUE_KB="$QUEUE_KB" \
    -e RUST_LOG=runa_server=info \
    runa:latest
  # Prove it stayed up. --read-only and --cap-drop=ALL are each capable of
  # stopping it from starting, and `docker run -d` returns 0 regardless.
  sleep 5
  if [ "$(docker inspect -f '{{.State.Running}}' runa 2>/dev/null)" != "true" ]; then
    echo "container is not running:" >&2
    docker logs runa 2>&1 | tail -20 >&2
    exit 1
  fi
  docker ps --filter name=runa --format '  {{.Names}}  {{.Status}}'
REMOTE
ok "container running, published to 127.0.0.1:3000 only"

# ── 5. Caddy ─────────────────────────────────────────────────────────────
bold "5/6  Caddy vhost"
$SSH "RUNA_HOST=$HOST bash -euo pipefail -s" <<'REMOTE'
  CADDYFILE=/etc/caddy/Caddyfile
  if sudo grep -q "^${RUNA_HOST}[[:space:]]*{" "$CADDYFILE"; then
    echo "  vhost already present; leaving it alone"
    exit 0
  fi
  # A broken Caddyfile drops TLS for every site on this box, so: back up,
  # append, validate, restore the backup if validation fails.
  BACKUP="${CADDYFILE}.bak.$(date +%s)"
  sudo cp "$CADDYFILE" "$BACKUP"
  printf '\n' | sudo tee -a "$CADDYFILE" >/dev/null
  sudo tee -a "$CADDYFILE" < /tmp/Caddyfile.runa >/dev/null
  if ! sudo caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    echo "  Caddyfile failed validation — restoring $BACKUP, Caddy untouched" >&2
    sudo cp "$BACKUP" "$CADDYFILE"
    exit 1
  fi
  sudo systemctl reload caddy
  echo "  vhost appended, validated, Caddy reloaded (backup: $BACKUP)"
REMOTE
ok "Caddy configured"

# ── 6. Prove it ──────────────────────────────────────────────────────────
bold "6/6  Verify"

$SSH "sudo ss -ltnp 2>/dev/null | grep -q '127.0.0.1:3000'" \
  && ok "published to loopback only" \
  || die "not bound to 127.0.0.1:3000"

$SSH "docker logs runa 2>&1 | grep -o 'max_total_log_mib=[0-9]*' | tail -1" \
  | sed 's/^/  ceiling: /' || true

echo "  waiting for certificate issuance…"
CODE=""
for i in $(seq 1 30); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$HOST/" || true)"
  [ "$CODE" = "200" ] && break
  sleep 2
done
[ "$CODE" = "200" ] || die "https://$HOST/ returned ${CODE:-no response} after 60s.
        Check: sudo journalctl -u caddy --since '5 min ago' | tail -30"
ok "https://$HOST/ serves 200"

curl -s --max-time 5 "https://$HOST/version" | grep -q "$COMMIT" \
  && ok "/version reports the deployed commit" \
  || warn "/version does not report $COMMIT"

if [ -n "${RUNA_NEIGHBOUR_URL:-}" ]; then
  N="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$RUNA_NEIGHBOUR_URL" || true)"
  [ "$N" = "200" ] \
    && ok "$RUNA_NEIGHBOUR_URL still healthy" \
    || warn "$RUNA_NEIGHBOUR_URL returned $N — check before walking away"
fi

bold "DEPLOYED  https://$HOST/"
echo "  Logs:    ssh … 'docker logs -f runa'"
echo "  Restart: ssh … 'docker restart runa'   (destroys every live room)"
echo "  Remove:  ./scripts/rollback-docker.sh"
