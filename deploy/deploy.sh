#!/usr/bin/env bash
#
# Build locally, ship to the server, switch over, verify.
#
#   deploy/deploy.sh root@<ip>            # everything
#   deploy/deploy.sh root@<ip> --static   # site + web client only, no restart
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
rsync -rlptz --delete --chmod=D755,F644 apps/site/dist/ "$TARGET:/srv/jasb/site/"
rsync -rlptz --delete --chmod=D755,F644 apps/web/dist/ "$TARGET:/srv/jasb/app/"

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
rsync -rlptz --chmod=D755,F644 "$OUT/server/" "$TARGET:/opt/jasb/releases/$RELEASE/"
rsync -rlptz --chmod=F644 deploy/jasb-server.service "$TARGET:/etc/systemd/system/jasb-server.service"
rsync -rlptz --chmod=F644 deploy/Caddyfile "$TARGET:/etc/caddy/Caddyfile"

log "Switch over"
ssh "$TARGET" bash -s -- "$RELEASE" <<'REMOTE'
set -euo pipefail
RELEASE="$1"
ln -sfn "/opt/jasb/releases/$RELEASE" /opt/jasb/current
systemctl daemon-reload
systemctl enable --now jasb-server >/dev/null 2>&1
systemctl restart jasb-server
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy || systemctl restart caddy

# Keep the five newest releases.
ls -1d /opt/jasb/releases/* | head -n -5 | xargs -r rm -rf

for _ in $(seq 1 20); do
  curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && break
  sleep 0.5
done
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
echo "A 000 means DNS or TLS is not ready yet. Caddy issues certificates on the"
echo "first request once DNS points at the server; give it a minute and rerun the checks."
