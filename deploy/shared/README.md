# Jasb on a shared host

This is how jasb.dev runs on 49.13.132.84, a machine it shares with **ark**
(sinavdegerlendir.com). Ark runs in Docker from `/opt/ark`, and its nginx
container (`ark_nginx`) owns ports 80 and 443.

```
internet ──443──▶ ark_nginx (Docker)  ── TLS for both apps
                    ├─ sinavdegerlendir.com ─▶ ark containers
                    └─ *.jasb.dev ──HTTP──▶ 172.18.0.1:8090  Caddy (host)
                                               ├─ jasb.dev     /srv/jasb/site
                                               ├─ app.jasb.dev /srv/jasb/app
                                               └─ api.jasb.dev 127.0.0.1:8787 jasb-server
```

## What Jasb adds, and what it leaves alone

**Added on the host:** Node 22 (NodeSource apt), Caddy (apt, listening on
8090 only), the `jasb` user, `/opt/jasb`, `/srv/jasb`, `/etc/jasb/jasb.env`,
`jasb-server.service`, and one ufw rule: `8090/tcp` from `172.16.0.0/12`,
so containers can reach Caddy. Port 8090 stays closed to the internet.

**Added to ark:**
- The jasb.dev blocks in `/opt/ark/nginx/nginx.conf` (from `nginx-jasb.conf`,
  between the `jasb.dev` marker comments).
- The `jasb.dev` certificate in `/opt/ark/nginx/ssl`, next to ark's.
- The `jasb-certs.timer` renewal timer.

**Not touched:** ark's containers, compose files, existing nginx blocks and
firewall rules.

> **Ark's `update.sh` rsyncs `nginx/nginx.conf` from the ark source on the
> developer's Mac.** The jasb.dev blocks must also live in that source copy,
> or the next ark update deletes them and jasb.dev goes down.

## Setup

```bash
ssh root@49.13.132.84 'bash -s' < deploy/shared/setup.sh
JASB_CADDYFILE=deploy/shared/Caddyfile deploy/deploy.sh root@49.13.132.84
```

Every later release is the same `deploy.sh` line.

## Certificates

Ark's nginx already answers `/.well-known/acme-challenge/` for every host
name on port 80, so the certificate can be issued before the jasb.dev blocks
exist. DNS for all four names must point at the server first.

```bash
docker run --rm -v /opt/ark/nginx/ssl:/etc/letsencrypt -v ark_certbot_data:/var/www/certbot \
  certbot/certbot certonly --webroot -w /var/www/certbot --non-interactive --agree-tos \
  -m dev@jasb.dev --cert-name jasb.dev -d jasb.dev -d www.jasb.dev -d app.jasb.dev -d api.jasb.dev
```

Then paste `nginx-jasb.conf` just before the closing `}` of `http { … }` in
`/opt/ark/nginx/nginx.conf`. Write the file in place: it is a single-file bind
mount, and an editor that replaces the file hands the container a stale copy.
Test and reload without downtime:

```bash
docker exec ark_nginx nginx -t && docker exec ark_nginx nginx -s reload
```

Renewal runs from `jasb-certs.timer`, twice a day. It renews only `jasb.dev`,
then reloads ark's nginx.
