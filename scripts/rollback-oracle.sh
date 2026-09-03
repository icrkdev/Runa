#!/usr/bin/env bash
#
# Back out RÚNA. Stops one service, removes one unit, deletes one vhost
# block. Nothing else on the host is touched.
#
#   ./scripts/rollback-oracle.sh            # stop RUNA, leave Caddy alone
#   ./scripts/rollback-oracle.sh --full     # also remove the Caddy vhost
#
set -euo pipefail

# ── Target. No defaults for the host: guessing wrong deploys onto the wrong
# machine, and the obvious guess is whatever box you set up first.
HOST=${RUNA_HOST:?set RUNA_HOST, e.g. runa.example.com}
BOX_IP=${RUNA_BOX_IP:?set RUNA_BOX_IP, the instance public IP}
SSH_USER=${RUNA_SSH_USER:-ubuntu}
SSH_KEY=${RUNA_SSH_KEY:-$HOME/.ssh/id_ed25519}
FULL=0
[ "${1:-}" = "--full" ] && FULL=1

SSH="ssh -i $SSH_KEY ${SSH_USER}@${BOX_IP}"

echo "Stopping runa…"
$SSH "sudo systemctl disable --now runa 2>/dev/null || true
      sudo rm -f /etc/systemd/system/runa.service
      sudo systemctl daemon-reload
      echo '  service stopped and unit removed'"

if [ "$FULL" = "1" ]; then
  echo "Removing the Caddy vhost…"
  $SSH "RUNA_HOST=$HOST bash -euo pipefail -s" <<'REMOTE'
    CADDYFILE=/etc/caddy/Caddyfile
    BACKUP="${CADDYFILE}.bak.$(date +%s)"
    sudo cp "$CADDYFILE" "$BACKUP"
    # Delete from the vhost's opening line to its closing brace, nothing else.
    sudo awk -v host="$RUNA_HOST" '
      $0 ~ "^" host "[[:space:]]*\\{" { skip=1; depth=0 }
      skip { depth += gsub(/\{/,"{") - gsub(/\}/,"}"); if (depth<=0) { skip=0 }; next }
      { print }
    ' "$BACKUP" | sudo tee "$CADDYFILE" >/dev/null

    if ! sudo caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
      echo "  validation failed — restoring $BACKUP" >&2
      sudo cp "$BACKUP" "$CADDYFILE"
      exit 1
    fi
    sudo systemctl reload caddy
    echo "  vhost removed, Caddy reloaded (backup at $BACKUP)"
REMOTE
fi

echo "Neighbour check…"
if [ -n "${RUNA_NEIGHBOUR_URL:-}" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$RUNA_NEIGHBOUR_URL" || true)"
  echo "  $RUNA_NEIGHBOUR_URL -> $CODE"
fi
echo
echo "Done. Assets remain at /opt/runa and the binary at /usr/local/bin/runa-server;"
echo "remove them by hand if you want the box clean. DNS record is untouched."
