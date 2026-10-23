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
curl -fsS http://localhost/ready          # {"ok":true,...}
```

[`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml) runs Postgres, Redis, two server instances and the web image. Compose refuses to start without `JWT_SECRET`, `POSTGRES_PASSWORD` and `WEB_ORIGIN`; the server itself refuses the public development secret when `NODE_ENV=production`. Database migrations run when a server starts, so an upgrade is `docker compose ... pull && docker compose ... up -d --wait`.

Dev sign-in (`AUTH_DEV_LOGIN`) is **off** in production, so people sign in with an emailed magic link.

## Behind TLS

Point your TLS terminator at the `web` service (`HTTP_PORT`, default 80) and set `WEB_ORIGIN` to the public `https://` URL. Then set `TRUST_PROXY=2` in `deploy/.env`: nginx is one proxy and the terminator is another, and the server needs the right count to see real client IPs for rate limiting (a wrong count lets clients spoof `X-Forwarded-For`, or puts everyone behind one IP). Whatever sits in front must pass `Upgrade`/`Connection` headers and allow idle connections of at least two minutes.

## Running on other platforms

Keep these constraints and the rest is up to you:

1. **Sticky sessions for `/socket.io/`.** Socket.IO's long-polling handshake must hit one instance for the whole session. The web image's nginx does this by hashing the per-tab `cid` query parameter. Its config names its upstreams `server-1:3001` and `server-2:3001` ([`docker/nginx.conf`](../docker/nginx.conf)), so keep those names or mount your own config. If you use another balancer, hash on `cid` too.
2. **Redis is shared by all instances** (fan-out, presence, rate limits). It needs no persistence; losing it drops live presence and briefly stops cross-instance delivery, and clients recover by re-joining.
3. **Postgres is the source of truth.** Back it up like any database. Every write holds one connection for its whole transaction, so `PG_POOL_MAX` (per instance, default 10) times the number of instances must stay under Postgres' `max_connections`.
4. **More instances** are fine on the server side (add `server-3` and list it in the nginx upstreams). Each Node instance saturated about one core at roughly 150 board commands per second in our [load test](load-testing.md); size by that.

## Health, logs, metrics

- `GET /health` is liveness (touches no dependency); `GET /ready` checks Postgres and Redis and returns 503 naming the one that failed. The compose healthchecks use `/ready`.
- Logs are one JSON object per line.
- `GET /metrics` (Prometheus) is deliberately **not** proxied by nginx. Scrape each server instance on port 3001 from inside the network.
- Old board events are pruned after `EVENT_RETENTION_DAYS` (default 90); see the README's scaling notes.

## Releasing

Push a tag: `git tag v1.0.0 && git push origin v1.0.0`. CI runs every job again on the tag and, if they pass, publishes `1.0.0` and `1.0` next to `sha-<commit>`. Pin `IMAGE_TAG=1.0.0` in `deploy/.env` to run exactly that release; rolling back is changing the tag and running `up -d` again (migrations only move forward, so check the release notes before rolling back across a migration).

## What is not covered

There is no automatic deploy step: CI publishes images and stops. Running them is yours to wire (a webhook, Watchtower, your orchestrator's rollout). Image signing and an SBOM beyond buildx's default provenance are not set up.
