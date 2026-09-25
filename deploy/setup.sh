#!/usr/bin/env bash
#
# One-time provisioning for a fresh Debian 12 / Ubuntu 22.04+ machine.
# Run as root on the server:
#
#   ssh root@<ip> 'bash -s' < deploy/setup.sh
#
# Safe to run again: every step checks before it changes anything.
# After this, `deploy/deploy.sh root@<ip>` ships the code.

set -euo pipefail

NODE_MAJOR=22

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

log "Base packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync ufw debian-keyring debian-archive-keyring apt-transport-https >/dev/null

log "Node.js ${NODE_MAJOR}"
if ! node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

log "pnpm"
corepack enable
corepack prepare pnpm@10.26.1 --activate >/dev/null
pnpm --version

log "Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
caddy version

log "Service user and directories"
id jasb >/dev/null 2>&1 || useradd --system --home /opt/jasb --shell /usr/sbin/nologin jasb
install -d -o jasb -g jasb /opt/jasb /opt/jasb/releases
install -d -o caddy -g caddy /srv/jasb /srv/jasb/site /srv/jasb/app
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
# Jasb Search allowances per month (Kagi-style). URLs, bangs and cache hits are free.
JASB_FREE_MONTHLY_QUOTA=50
JASB_STARTER_MONTHLY_QUOTA=300
JASB_PRO_MONTHLY_QUOTA=2000
JASB_SHARED_CACHE_K=3

# Fill these in.
JASB_BRAVE_API_KEY=
JASB_SYSTEM_ONE_PRESET=
JASB_SYSTEM_ONE_URL=
JASB_LLM_PROVIDER=anthropic
JASB_LLM_API_KEY=
JASB_LLM_MODEL=

# Paddle. Leave empty until the account is verified; checkout stays off until
# the client token, the webhook secret and at least one price id are all set.
JASB_PADDLE_ENV=sandbox
JASB_PADDLE_CLIENT_TOKEN=
JASB_PADDLE_WEBHOOK_SECRET=
# Price ids. Pro may list several, comma-separated (monthly,yearly).
JASB_PADDLE_PRICE_STARTER=
JASB_PADDLE_PRICE_PRO=
JASB_PADDLE_PRICE_SUPPORTER=
ENV
  chmod 640 /etc/jasb/jasb.env
  chown root:jasb /etc/jasb/jasb.env
  echo "wrote /etc/jasb/jasb.env — add the provider keys"
fi

log "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null   # HTTP/3
ufw --force enable >/dev/null
ufw status | head -n 12

log "Done"
echo "Next, from your machine:  deploy/deploy.sh root@<this-ip>"
