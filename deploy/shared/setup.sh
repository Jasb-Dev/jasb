#!/usr/bin/env bash
#
# One-time provisioning of Jasb on a host that already runs another app, whose
# nginx container owns ports 80 and 443. Run as root on the server:
#
#   ssh root@<ip> 'bash -s' < deploy/shared/setup.sh
#
# Unlike deploy/setup.sh this never touches ports 80/443, the firewall's
# defaults, or anything belonging to the other app. It only adds: Node 22,
# Caddy on port 8090, a `jasb` user, /opt/jasb, /srv/jasb, /etc/jasb, and one
# ufw rule letting Docker containers reach port 8090.

set -euo pipefail

NODE_MAJOR=22
log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

log "Node.js ${NODE_MAJOR}"
if ! node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

log "Caddy (port 8090 only)"
if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  # The package's default Caddyfile listens on :80, which the other app owns.
  # Put ours in place first and keep it (--force-confold) so Caddy never
  # tries to take port 80, not even for a moment.
  mkdir -p /etc/caddy
  printf '{\n\tauto_https off\n\thttp_port 8090\n}\n\nhttp://:8090 {\n\trespond 404\n}\n' > /etc/caddy/Caddyfile
  apt-get install -y -qq -o Dpkg::Options::=--force-confold caddy >/dev/null
fi
caddy version

log "Service user and directories"
id jasb >/dev/null 2>&1 || useradd --system --home /opt/jasb --shell /usr/sbin/nologin jasb
install -d -o jasb -g jasb /opt/jasb /opt/jasb/releases
install -d -m 755 /srv/jasb /srv/jasb/site /srv/jasb/app
install -d -m 750 -o root -g jasb /etc/jasb

if [[ ! -f /etc/jasb/jasb.env ]]; then
  cat > /etc/jasb/jasb.env <<'ENV'
# Production environment for the Jasb server. Read by systemd, not by a shell:
# no quotes, no `export`. After editing: systemctl restart jasb-server
PORT=8787
JASB_HOST=127.0.0.1
JASB_ALLOWED_ORIGINS=https://jasb.dev,https://app.jasb.dev
JASB_REFUSE_BYOK=true
JASB_DAILY_BUDGET=2000
JASB_DEMO_DAILY_QUOTA=5
JASB_FREE_DAILY_QUOTA=15
JASB_PRO_DAILY_QUOTA=600
JASB_SHARED_CACHE_K=3

# Fill these in.
JASB_BRAVE_API_KEY=
JASB_SYSTEM_ONE_PRESET=
JASB_SYSTEM_ONE_URL=
JASB_LLM_PROVIDER=anthropic
JASB_LLM_API_KEY=
JASB_LLM_MODEL=

# Paddle. Checkout stays off until the client token, the webhook secret and
# at least one price id are all set.
JASB_PADDLE_ENV=sandbox
JASB_PADDLE_CLIENT_TOKEN=
JASB_PADDLE_WEBHOOK_SECRET=
JASB_PADDLE_PRICE_PRO=
JASB_PADDLE_PRICE_SUPPORTER=
ENV
  chmod 640 /etc/jasb/jasb.env
  chown root:jasb /etc/jasb/jasb.env
fi

log "Firewall: Docker containers → 8090"
# Additive only. The default policy (drop) and the other app's rules stay as
# they are; port 8090 remains closed to the internet.
ufw status | grep -q "8090/tcp.*172.16.0.0/12" \
  || ufw allow from 172.16.0.0/12 to any port 8090 proto tcp comment 'jasb: nginx container -> caddy' >/dev/null
ufw status | grep 8090

log "Done"
