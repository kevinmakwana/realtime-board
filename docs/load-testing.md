# Load testing

[`loadtest/board.js`](../loadtest/board.js) is a [k6](https://grafana.com/docs/k6/) script that speaks Socket.IO (Engine.IO v4) over a plain WebSocket, the same protocol the web app uses. Each virtual user is one person on one board: it signs in, joins, then creates cards, moves and comments on its own cards, and moves a cursor. Users are spread over `BOARDS` boards and nginx spreads their sockets over both server instances, so most boards have people on both and every event crosses Redis.

## Running it

```bash
# 1. Start the two-instance stack. Sign-in is rate limited per IP, so raise the limit for the test.
AUTH_RATE_LIMIT_PER_MIN=10000 docker compose --profile scale up -d --build --wait
# 2. Run (k6 must be installed: https://grafana.com/docs/k6/latest/set-up/install-k6/)
npm run loadtest                                           # 40 users, 4 boards, 60 s
VUS=100 BOARDS=10 DURATION=60 RAMP=10 npm run loadtest     # the reference profile below
BASE_URL=https://board.example.com k6 run loadtest/board.js
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8088` | where to aim; needs `AUTH_DEV_LOGIN=true` (the script signs in fictional users) |
| `VUS`, `BOARDS` | 40, 4 | users, and how many boards they share |
| `DURATION`, `RAMP` | 60, 10 | seconds each user stays; users join spread over `RAMP` seconds |
| `OPS_PER_SEC`, `CURSORS_PER_SEC` | 2, 5 | commands per user (the server allows 20/s per socket) and cursor packets per user |
| `ACK_P95_MS`, `FANOUT_P95_MS` | 500, 1000 | latency limits that fail the run |

Do not aim it at a deployment you care about: it creates users, boards and cards.

## What passes and fails

Correctness limits are exactly zero, and any breach makes k6 exit non-zero:

- `ops_failed`: a command was refused or errored (including rate limiting)
- `events_missing`: a `seq` between a socket's join and the newest one it saw never arrived
- `events_duplicate`: the same `seq` delivered twice
- `history_gaps`: after the run, each board's event log read back through the API is not gapless
- `connect_failures`: a socket that could not connect or join, or that was closed before the run's planned end; a command that never got its answer counts as `ops_failed`
- a check that events really did cross between instances

Latency limits are the two `*_P95_MS` values. The run also reports `ack_ms` (command sent to acknowledged) and `fanout_ms` (a card created on one socket until a socket on the board receives its event, the creator's own included; split by whether the receiver is on the creator's instance or the other one).

The script's failure detection was checked with deliberately broken copies of it (mutation checks): they fail the run, so a green run is not just a script that cannot fail.

CI runs a small version (10 users on one board, 10 seconds, loose latency limits) on every pull request. That guards correctness and the script itself; it says nothing about performance, because shared CI runners are too noisy.

## Reference numbers

100 users on 10 boards, 60 s, 10 s ramp, 2 commands and 5 cursor packets per user per second, so about 200 commands/s offered (each board event goes to every socket on its board, 10 here, so roughly 2,000 deliveries/s plus cursor packets). Three runs on an otherwise idle Apple M1 laptop (8 cores) with Docker Desktop (8 CPUs, 8 GB), where k6, both Node instances, nginx, Postgres and Redis **all share the same machine**:

| Run | Commands acked | ack p95 | ack p99 | fan-out p95 (same / other instance) | Missing / duplicate / failed / history gaps |
| --- | --- | --- | --- | --- | --- |
| 1 | 11,328 | 72 ms | 174 ms | 76 / 75 ms | 0 / 0 / 0 / 0 |
| 2 | 11,326 | 48 ms | 147 ms | 47 / 48 ms | 0 / 0 / 0 / 0 |
| 3 | 11,337 | 21 ms | 90 ms | 22 / 24 ms | 0 / 0 / 0 / 0 |

In each run 27,000 to 31,000 `card.created` deliveries went to a socket on the other instance than the creator's (the `fanout_cross_instance` counter).

How to read them:

- **The correctness result is solid.** It held in every run, including earlier ones where the machine was saturated.
- **The latency spread is real noise.** Run 1 started while the laptop was still settling from other work. Treat the figures as "tens of milliseconds at the 95th percentile", not as a benchmark.
- **This is a laptop with the load generator on it.** A real deployment puts k6 elsewhere, so absolute numbers will differ in both directions.

## Where it runs out

Pushing past the reference profile (more users or higher rates) on this machine, each Node instance saturates about one core at roughly 150 commands/s plus the cursor fan-out, and Postgres, which serialises writes per board and holds a connection per transaction, is also close behind. Raising `PG_POOL_MAX` did not change throughput there. Once saturated, latency climbs while correctness still holds (no lost or duplicated events), which is the behaviour we want. Capacity planning from this: add instances for socket and fan-out load, and size Postgres for the write rate. Those are single-machine observations, not limits of the design.

## What this does not measure

- Many boards with many idle viewers, or very large boards (thousands of cards)
- Reconnect storms, instance restarts under load, or Redis loss
- The browser: rendering cost is not in these numbers
- WAN latency, TLS, or a real load balancer in front
