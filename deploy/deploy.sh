#!/usr/bin/env bash
#
# Build locally, ship to the server, switch over, verify.
#
#   deploy/deploy.sh root@<ip>            # everything
#   deploy/deploy.sh root@<ip> --static   # site + web client only, no restart
#
# On a host shared with another app (deploy/shared/), ship that Caddyfile:
#
#   JASB_CADDYFILE=deploy/shared/Caddyfile deploy/deploy.sh root@<ip>
#
# Needs `deploy/setup.sh` to have run on the server once.
#
# Releases are kept side by side in /opt/jasb/releases and `current` is a
# symlink, so a bad deploy is undone with:
#
#   ssh root@<ip> 'ln -sfn "$(ls -d /opt/jasb/releases/* | tail -2 | head -1)" /opt/jasb/current && systemctl restart jasb-server'

set -euo pipefail

TARGET="${1:?usage: deploy/deploy.sh user@host [--static]}"
MODE="${2:-all}"
API="${JASB_API:-https://api.jasb.dev}"
CADDYFILE="${JASB_CADDYFILE:-deploy/Caddyfile}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/deploy/.out"
RELEASE="$(date -u +%Y%m%dT%H%M%SZ)"

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

cd "$ROOT"
rm -rf "$OUT"
mkdir -p "$OUT"

log "Verify"
pnpm install --frozen-lockfile >/dev/null
pnpm --filter @jasb/intent-engine build >/dev/null
pnpm typecheck >/dev/null
pnpm test >/dev/null

log "Build static sites against $API"
VITE_JASB_API="$API" pnpm --filter @jasb/site build >/dev/null
VITE_JASB_SERVER="$API" pnpm --filter @jasb/web build >/dev/null

log "Ship static sites"
rsync -rlptz --delete apps/site/dist/ "$TARGET:/srv/jasb/site/"
rsync -rlptz --delete apps/web/dist/ "$TARGET:/srv/jasb/app/"
# macOS ships openrsync, which has no --chmod: set modes on the server instead.
# Everything is root-owned and world-readable; nothing here is secret.
ssh "$TARGET" 'chmod -R u=rwX,go=rX /srv/jasb/site /srv/jasb/app'

if [[ "$MODE" == "--static" ]]; then
  log "Static deploy done"
  exit 0
fi

log "Bundle the server"
# A self-contained copy of @jasb/server with production dependencies only.
# Every dependency is plain JavaScript, so a bundle built on macOS runs on Linux.
pnpm --filter @jasb/server deploy --prod --legacy "$OUT/server" >/dev/null
rm -rf "$OUT/server/test" "$OUT/server/dist"

log "Ship release $RELEASE"
rsync -rlptz "$OUT/server/" "$TARGET:/opt/jasb/releases/$RELEASE/"
rsync -rlptz deploy/jasb-server.service "$TARGET:/etc/systemd/system/jasb-server.service"
rsync -rlptz "$CADDYFILE" "$TARGET:/etc/caddy/Caddyfile"

log "Switch over"
ssh "$TARGET" bash -s -- "$RELEASE" <<'REMOTE'
set -euo pipefail
RELEASE="$1"
chmod -R u=rwX,go=rX "/opt/jasb/releases/$RELEASE"
chmod 644 /etc/systemd/system/jasb-server.service /etc/caddy/Caddyfile
ln -sfn "/opt/jasb/releases/$RELEASE" /opt/jasb/current
systemctl daemon-reload
systemctl enable --now jasb-server >/dev/null 2>&1
systemctl restart jasb-server

# Wait for the server before reloading Caddy: a reload re-runs the active
# health check, and one that fires before Node is listening marks the API
# down for a whole interval (30 s of 503s).
for _ in $(seq 1 20); do
  curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && break
  sleep 0.5
done
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
systemctl reload caddy || systemctl restart caddy

# Keep the five newest releases.
ls -1d /opt/jasb/releases/* | head -n -5 | xargs -r rm -rf
echo "local health: $(curl -fsS http://127.0.0.1:8787/health)"
journalctl -u jasb-server -n 4 --no-pager -o cat
REMOTE

log "Public checks"
check() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" || true)"
  printf '  %-34s %s\n' "$1" "$code"
}
check https://jasb.dev/
check https://jasb.dev/privacy.html
check https://app.jasb.dev/
check "$API/health"
echo
echo "A 000 means DNS or TLS is not ready yet. See LAUNCH.md §2 (or deploy/shared/README.md"
echo "on a shared host) for where the certificates come from."
