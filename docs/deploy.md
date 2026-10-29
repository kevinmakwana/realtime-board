# Deploying

CI publishes two images to GitHub Container Registry whenever `main` (or a `v*` tag) passes every job:

| Image | Contents |
| --- | --- |
| `ghcr.io/kevinmakwana/realtime-board-server` | the API and Socket.IO server (Node 22, runs as the `node` user, port 3001) |
| `ghcr.io/kevinmakwana/realtime-board-web` | nginx with the built web app, and the sticky load balancer for the server instances (port 80) |

Both are built for `linux/amd64` and `linux/arm64`. Tags: `latest` (main), `sha-<commit>`, and `1.2.3` / `1.2` for a tag `v1.2.3`. Pull requests never publish.

> The first time a package is published GitHub may create it as **private**. If you want people to pull it without logging in, open the package's settings on GitHub and make it public once. Otherwise log in with `docker login ghcr.io` using a token that has `read:packages`.

## What you need

- A host with Docker Compose v2 (one VM is enough to start), or any platform that can run the two images plus Postgres 17 and Redis 7.
- A way to terminate **TLS** in front of nginx (a cloud load balancer, Caddy, ...). The web image speaks plain HTTP only, and it must forward WebSocket upgrades.
- Optional: an SMTP server for magic-link and invitation emails. Without one, emails are printed to the server log, so nobody can sign in by link; set `SMTP_URL`.

## Quick start (single host)

```bash
cp deploy/.env.example deploy/.env
# edit deploy/.env: WEB_ORIGIN, JWT_SECRET (openssl rand -base64 48), POSTGRES_PASSWORD (openssl rand -hex 24)
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --wait
curl -fsS http://127.0.0.1/ready          # {"ok":true,...}  (nginx listens on loopback only; see below)
```

[`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml) runs Postgres, Redis, two server instances and the web image. Compose refuses to start without `JWT_SECRET`, `POSTGRES_PASSWORD` and `WEB_ORIGIN`; the server itself refuses the public development secret when `NODE_ENV=production`. Database migrations run when a server starts, so an upgrade is `docker compose ... pull && docker compose ... up -d --wait`.

Dev sign-in (`AUTH_DEV_LOGIN`) is **off** in production, so people sign in with an emailed magic link. Turn it on only for a throwaway demo (see [Public demo](#public-demo-one-small-vps-about-10-minutes)).

## Public demo (one small VPS, about 10 minutes)

For a link you can send to someone: one cheap Linux VM (1 vCPU / 2 GB is plenty for a demo) with Docker, ports 80 and 443 open, and a name that points at it.

```bash
git clone https://github.com/kevinmakwana/realtime-board.git && cd realtime-board
./deploy/demo-up.sh board.example.com        # or, with no domain: ./deploy/demo-up.sh 203-0-113-7.sslip.io
```

The second form uses [sslip.io](https://sslip.io), which resolves `203-0-113-7.sslip.io` to `203.0.113.7`, so Caddy can get a real certificate for a bare IP. The script writes `deploy/.env` with fresh secrets, starts the stack with automatic HTTPS (the `tls` profile: Caddy in front of nginx), loads the demo board and prints the URL. It is safe to run again; it keeps the existing `deploy/.env` and does not seed twice. Update later with `./deploy/demo-up.sh <same name>` (it pulls the newest `latest` images).

What it turns on, and what that means:

- **One-click demo sign-in** (`AUTH_DEV_LOGIN=true`). Anyone can sign in as any email, so they can read and change each other's boards. That is what a demo needs, and the reason it must hold fictional data only. For a real deployment leave it off and set `SMTP_URL`.
- **Open sign-up.** Anyone with the link can create boards. Rate limits stay on, and old events are pruned after 90 days, but nothing stops someone filling the disk. Start fresh any time with `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env --profile tls down -v` and run the script again.
- **Not highly available.** One host, one Postgres, no backups. It shows how the two instances behave, not how to run it for customers.
- **No secrets in the repo.** `deploy/.env` is created on the server (mode 600) and git-ignored.

Checks: `curl https://<name>/ready` answers `{"ok":true,...}`, and two windows signed in as different people see each other's cards. To demonstrate the reconnect behaviour live, `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env --profile tls stop server-1` while the header shows which instance you are on (the badge reads "Live on server-1" or "server-2"), then `start` it again.

## Behind TLS

nginx is published on `127.0.0.1:80` by default, so the host's public interface does not expose plain HTTP. Point your TLS terminator at it (Caddy on the same host is the simplest) and set `WEB_ORIGIN` to the public `https://` URL. If the terminator is on another machine, set `HTTP_BIND` to this host's private address and **firewall that port to the terminator only**.

`TRUST_PROXY` defaults to `2` here: nginx is one proxy and the terminator is the other, and the server needs the right count to see real client IPs for rate limiting. This is only safe while every request really goes through the terminator. If clients can reach nginx directly, they can forge `X-Forwarded-For` and get a fresh rate-limit bucket per request; with too small a count, everyone shares the terminator's IP and the sign-in limit (20 a minute) applies to the whole site. Whatever sits in front must pass `Upgrade`/`Connection` headers and allow idle connections of at least two minutes.

## Running on other platforms

Keep these constraints and the rest is up to you:

1. **Sticky sessions for `/socket.io/`.** Socket.IO's long-polling handshake must hit one instance for the whole session. The web image's nginx does this by hashing the per-tab `cid` query parameter. Its config names its upstreams `server-1:3001` and `server-2:3001` ([`docker/nginx.conf`](../docker/nginx.conf)), so keep those names or mount your own config. If you use another balancer, hash on `cid` too.
2. **Redis is shared by all instances** (fan-out, presence, rate limits). It needs no persistence; losing it drops live presence and briefly stops cross-instance delivery, and clients recover by re-joining.
3. **Postgres is the source of truth.** Back it up like any database. Every write holds one connection for its whole transaction, so `PG_POOL_MAX` (per instance, default 10) times the number of instances must stay under Postgres' `max_connections`.
4. **More instances** are fine on the server side (add `server-3` and list it in the nginx upstreams). Each Node instance saturated about one core at roughly 150 board commands per second in our [load test](load-testing.md); size by that.

## Health, logs, metrics

- `GET /health` is liveness (touches no dependency); `GET /ready` checks Postgres and Redis and returns 503 naming the one that failed. The compose healthchecks use `/ready`.
- Logs are one JSON object per line.
- `POSTGRES_PASSWORD` is applied only when the `pgdata` volume is first created. Changing it in `deploy/.env` later makes the servers fail to authenticate; change it inside Postgres (`ALTER USER`) as well.
- nginx resolves `server-1` and `server-2` once, at startup. After recreating only the server containers, restart `web` (`docker compose ... restart web`); a plain `up -d` after `pull` recreates all of them together, which is fine.
- `GET /metrics` (Prometheus) is deliberately **not** proxied by nginx. Scrape each server instance on port 3001 from inside the network.
- Old board events are pruned after `EVENT_RETENTION_DAYS` (default 90); see the README's scaling notes.

## Releasing

Push a tag: `git tag v1.0.0 && git push origin v1.0.0`. CI runs every job again on the tag and, if they pass, publishes `1.0.0` and `1.0` next to `sha-<commit>`. Pin `IMAGE_TAG=1.0.0` in `deploy/.env` to run exactly that release; rolling back is changing the tag and running `up -d` again (migrations only move forward, so check the release notes before rolling back across a migration).

## Verifying the images

Every published image is signed keyless with [cosign](https://docs.sigstore.dev/cosign/overview/) by the CI workflow itself (no key is stored anywhere), and carries an SBOM and build provenance attestation. To check that an image really came from this repository's CI before you run it:

```bash
cosign verify ghcr.io/kevinmakwana/realtime-board-server:1.0.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/kevinmakwana/realtime-board/\.github/workflows/ci\.yml@refs/(heads/main|tags/v.+)$'
docker buildx imagetools inspect ghcr.io/kevinmakwana/realtime-board-server:1.0.0 --format '{{ json .SBOM }}'
```

## Automatic deploy (optional)

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) can roll a new build out to one host over SSH after CI publishes it. It does nothing until you enable it:

1. Put `deploy/docker-compose.prod.yml` and your `deploy/.env` on the host (a clone of this repository works), under a directory you name in the repository variable `DEPLOY_PATH`.
2. Create a GitHub environment called `production`, restrict its deployment branches to `main`, and add required reviewers there if you want a manual approval before each deploy and add the secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (a key allowed to run `docker compose` on the host) and `DEPLOY_KNOWN_HOSTS` (the output of `ssh-keyscan -t ed25519 <host>`; the host key is pinned, never accepted blindly).
3. Set the repository variable `DEPLOY_ENABLED=true`, and optionally `DEPLOY_URL` (checked at `/ready` after the rollout).

After a green CI **push** run on `main` (pull requests, including from forks, never deploy) it deploys that commit's `sha-<commit>` image. It resolves the tag to a digest, runs `cosign verify` on that digest and refuses an image that was not signed by this repository's CI workflow, then tells the host to run exactly those digests under those image names (whatever `IMAGE_PREFIX` says in the host's `.env`). To deploy a release or roll back, run the workflow by hand ("Run workflow") and give it a tag such as `1.0.0`.

The rollout recreates the containers together, so expect a few seconds of reconnecting clients; they catch up on their own. The workflow has not been run against a real host; try it on a staging machine first.

## WebSocket-only builds (optional)

By default the browser starts with HTTP long-polling and upgrades to WebSocket, which is why nginx hashes sessions onto one instance. If every client path allows WebSockets you can build the web app without the polling fallback and drop that requirement:

```bash
docker build --target web --build-arg VITE_WS_ONLY=true -t my-board-web .
```

The published `web` image keeps the default. With a WebSocket-only build, `hash $arg_cid` in the nginx config becomes unnecessary (plain round-robin works), but it does no harm. Clients on networks that block WebSockets cannot connect to a WebSocket-only build at all.

## What is not covered

Zero-downtime rollouts (a rolling restart behind the load balancer) and multiple hosts: the compose file and the deploy workflow target a single machine.
