# Launching Jasb

From a green `pnpm test` to a public jasb.dev. Each step has the command to
run and the check that proves it worked.

Everything runs on **one server**, with Caddy in front:

| Host | Serves | From | On the server |
| --- | --- | --- | --- |
| `jasb.dev` | Landing, legal pages, demo, `/welcome.html` | `apps/site` | `/srv/jasb/site` |
| `app.jasb.dev` | The web client | `apps/web` | `/srv/jasb/app` |
| `api.jasb.dev` | The API (`/resolve`, `/billing/*`, …) | `apps/server` | `jasb-server.service` on 127.0.0.1:8787 |

The files for this live in `deploy/`: `setup.sh` (runs once), `deploy.sh`
(runs on every release), `Caddyfile` and `jasb-server.service`.

---

## 1 · Server

A fresh **Debian 12 or Ubuntu 22.04+** VPS. 1 vCPU and 1 GB RAM are enough to
start. You need SSH access as root (or as a user with passwordless sudo, with
`root@` in the commands below replaced by that user).

```bash
ssh root@<ip> 'bash -s' < deploy/setup.sh
```

This installs Node 22, pnpm, Caddy and ufw (opening 22, 80 and 443). It creates
the `jasb` service user and the directories, and writes
`/etc/jasb/jasb.env` with production defaults.

**Check:** the script ends with `Done`, and `ssh root@<ip> caddy version` prints a version.

## 2 · DNS

Point three A records at the server's IP. A wildcard `*` record covers `app` and `api` too:

| Type | Name | Value |
| --- | --- | --- |
| A | `@` | `<ip>` |
| A | `www` | `<ip>` |
| A | `app` | `<ip>` |
| A | `api` | `<ip>` |

If the DNS host is Cloudflare, set these to **DNS only** (grey cloud) at first.
Caddy needs to reach Let's Encrypt directly to obtain its certificates.

**Check:** `dig +short jasb.dev app.jasb.dev api.jasb.dev` prints the IP three times.

## 3 · Keys

On the server, edit `/etc/jasb/jasb.env` and fill in at least:

```bash
JASB_BRAVE_API_KEY=...          # the general index
JASB_LLM_API_KEY=...            # the decider fallback
# and/or a System One model:
JASB_SYSTEM_ONE_PRESET=clm
JASB_SYSTEM_ONE_URL=http://...
```

`JASB_REFUSE_BYOK=true` and the demo budget are already set. Leave the Paddle
lines empty for now (§6).

## 4 · Deploy

From your machine, in the repo:

```bash
deploy/deploy.sh root@<ip>
```

This runs the tests, builds the site and web client against
`https://api.jasb.dev`, bundles the server, uploads a new release and switches
over. Then it prints the status codes of the public URLs. Old releases stay in
`/opt/jasb/releases`; the rollback one-liner is at the top of the script.

Only the site or the web client changed? Use `deploy/deploy.sh root@<ip> --static`.

**Check:** every line of the public checks prints `200`. A `000` means DNS or
TLS is not ready yet. Wait a minute and run the `curl` again.

```bash
curl -s https://api.jasb.dev/health
# … "configuration":"decider=system-one:clm sources=brave,wikipedia,marginalia quota=15/day billing=off"
```

If the decider shows `none (keyword heuristic only)`, the keys from §3 did not
load. Check the file, then run `systemctl restart jasb-server`.

Then open https://jasb.dev, click a demo chip, and confirm that real cards come back.

## 5 · Email

`dev@jasb.dev` and `contact@jasb.dev` appear in the footer, the legal pages and
the welcome page. Set up MX records with any mail host (or forwarding such as
ImprovMX or Cloudflare Email Routing). **Check:** send a message to each one.

## 6 · Paddle

Checkout is built and switched off. It turns on when all of these are set in
`/etc/jasb/jasb.env`, followed by a restart. Nothing needs rebuilding.

1. Create the Paddle account and complete business verification. This takes days.
2. **Catalog → Products:** create *Jasb Pro* with a $5/month price, and *Jasb
   Supporter* with a $19 one-time price. Copy the two `pri_…` ids.
3. **Developer tools → Authentication:** create a *client-side token* (`live_…` or `test_…`).
4. **Developer tools → Notifications:** add a destination
   `https://api.jasb.dev/billing/webhook` with the events `transaction.completed`,
   `subscription.updated`, `subscription.canceled`, `subscription.paused` and
   `subscription.resumed`. Copy its secret key.
5. **Checkout → Website approval:** add `jasb.dev`.
6. Put the privacy, terms and refund URLs in the dashboard. Paddle reviews them.

```bash
JASB_PADDLE_ENV=sandbox          # production once live
JASB_PADDLE_CLIENT_TOKEN=test_…
JASB_PADDLE_WEBHOOK_SECRET=pdl_ntfset_…
JASB_PADDLE_PRICE_PRO=pri_…
JASB_PADDLE_PRICE_SUPPORTER=pri_…
```

```bash
ssh root@<ip> systemctl restart jasb-server
```

**Check (sandbox first):** `/health` says `billing=paddle:sandbox`, and the
pricing buttons on jasb.dev read "Subscribe" and "Support". Buy Pro with
Paddle's test card. You should land on `/welcome.html` with a `jasb-…` key.
Paste the key into app.jasb.dev → Settings → Licence, where it should say
"Pro is active". Cancel the subscription in the sandbox; the same field should
then say it is no longer active.

For production, repeat steps 2–4 in the live environment and switch
`JASB_PADDLE_ENV=production`.

A lost key is re-issued by hand. Find the purchase in Paddle, and use
`/var/lib/jasb/licenses.json` to deactivate the old one. That file holds only
hashes, plans and subscription ids. Back it up: it is the only record of who
has paid.

```bash
ssh root@<ip> 'cp /var/lib/jasb/licenses.json /root/licenses-$(date +%F).json'
```

## 7 · Chrome Web Store

```bash
pnpm --filter @jasb/extension build     # talks to https://api.jasb.dev
cd apps/extension/dist && zip -r ../../../jasb-extension.zip . && cd -
```

In the developer dashboard ($5 one-off):

- Upload `jasb-extension.zip`.
- Justify each permission: `bookmarks` and `history` are local sources that
  never leave the browser, and `storage` holds rules, the device token and the
  licence key. The only host permission is `api.jasb.dev`.
- Privacy tab: link `https://jasb.dev/privacy.html`.
- Assets: the 128 px icon is at `apps/extension/public/icons/icon-128.png`,
  and screenshots are 1280×800.

After approval, add the extension origin to the server and point the site at the listing:

```bash
# /etc/jasb/jasb.env
JASB_ALLOWED_ORIGINS=https://jasb.dev,https://app.jasb.dev,chrome-extension://<extension-id>
```

In `apps/site/index.html`, change the "Add to Chrome →" link from the GitHub
release to the store URL, then run `deploy/deploy.sh root@<ip> --static`.

## 8 · Desktop release

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` builds the macOS `.dmg`/`.zip` (Apple silicon
and Intel), the Windows installer, the Linux AppImage and `.deb`, and the
extension zip. It attaches them all to a GitHub release. The site's "Download →"
link points at `github.com/jasb-dev/jasb/releases/latest`, so the repository
must be public under that name, or the link changed.

To build locally: `pnpm --filter @jasb/desktop dist:mac`, with the output in
`apps/desktop/release/`.

**Signing:** without a certificate the builds are unsigned. On macOS,
Gatekeeper blocks a double-click; the user has to right-click → Open. Say so in
the release notes. To sign and notarise, you need an Apple Developer Program
membership and a **Developer ID Application** certificate. The *Apple Development*
certificate in the local keychain is not enough. Add these repository secrets:
`MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. The workflow already passes
them through. Windows signing is optional; SmartScreen warns until the app has
built up a reputation.

## 9 · Show HN

- Title: `Show HN: Jasb – type what you want, get the right sites (no chat, no ads)`
- Link to `https://jasb.dev`, not the repo. The demo is the pitch.
- Post Tuesday–Thursday, around 8–9am US Eastern.
- First comment: why it's a router and not an author, what it refuses to do,
  the open-model decider, and what isn't built yet (README → Status).

**While it's live:**

```bash
watch -n 60 'curl -s https://api.jasb.dev/budget'
ssh root@<ip> 'journalctl -u jasb-server -f'
```

When the budget runs out, the demo drops to free sources instead of failing.
That's the design, not an outage. Raise `JASB_DAILY_BUDGET` only if the spend
is one you'd accept.
