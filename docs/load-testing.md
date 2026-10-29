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
| `STORM_AT`, `STORM_SPREAD` | 0 (off), 2 | reconnect storm: at `STORM_AT` seconds every user hangs up and returns within `STORM_SPREAD` seconds |
| `RECONNECT` | off | an unplanned disconnect is an outage to recover from, not a failure (use with a restart, below) |
| `SEED_CARDS` | 0 | cards each user creates first; `BOARDS=1 VUS=100 SEED_CARDS=30` is one board of about 3,000 cards |
| `RESYNC_P95_MS` | 5000 | limit on how long a returning user waits for its join to be answered |

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

## Reconnect storms and restarts

Both use the same script with extra switches (see the table above). All figures are from the same idle-ish laptop as the reference runs, with the load average noted when each run started; treat them as "order of magnitude", not as a benchmark.

**Reconnect storm** (`STORM_AT=18 STORM_SPREAD=2`, 100 users on 10 boards, 40 s). At 18 s every user hangs up on purpose and comes back at a random moment within two seconds, sending the last `seq` it saw. The script checks that every `seq` from the first join to the last arrived (live, replayed, or covered by a snapshot).

| Run | Load at start | Time for a join to be answered, p95 / max | ack p95 | Lost / failed / gaps |
| --- | --- | --- | --- | --- |
| 1 | 4.7 | 10 ms / 32 ms | 16 ms | 0 / 0 / 0 |
| 2 | 3.9 | 14 ms / 24 ms | 11 ms | 0 / 0 / 0 |
| 3 | 4.1 | 10 ms / 43 ms | 17 ms | 0 / 0 / 0 |

Returning users send their last `seq`, so they get a short replay, which is cheap. A user who comes back as a fresh page load gets the full snapshot instead (`STORM_COLD=1`).

**Instance restart under load** (`RECONNECT=1`, 100 users, 70 s; `docker compose --profile scale restart server-1` at 30 s). The users connected to that instance (about half) lose their socket. They back off 0.3 to 1.5 s, reconnect (nginx sends them to the instance that is up), rejoin with their last `seq` and carry on.

| Run | Load at start | Back in service after the drop, avg / p95 | Join answered, p95 | Lost / gaps | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | 4.5 | 0.9 s / 1.45 s | 35 ms | 0 / 0 | |
| 2 | 2.9 | 1.0 s / 1.8 s | 360 ms | 0 / 0 | ack p95 1.1 s: another process took the laptop to load 5.5 mid-run |
| 3 | 4.9 | 0.9 s / 1.4 s | 37 ms | 0 / 0 | |

Time back in service is dominated by the script's own backoff and the container restart, not by the join. A few commands per run were in flight at the moment of the drop (counted as `ops_in_doubt`): the client cannot know whether they landed, and the run does not count them as failures, but the zero-gap check on the stored log still passed.

## Large boards and one busy board: not measured yet

The script can build both (`SEED_CARDS`, `SEED_PER_SEC`, `BOARDS=1`, and `STORM_COLD=1` to make returning users pull a full snapshot), but I could not take clean measurements: the laptop was shared with other heavy workloads and, at the end, its Docker engine stopped responding. What I did see, and why it should not be quoted as a result:

- One board with 100 users (50 commands/s plus 200 cursor packets/s, each fanned out to 99 other sockets) was **much** slower than ten boards of ten with four times the commands: acknowledgement p95 in the tens of seconds, and some commands failing, in two runs taken while the machine's load average was between 5 and 15. The cause is probably cursor fan-out, which grows with the square of the people on a board, plus every command on a board taking that board's row lock. It was not confirmed, and it was not separated from the machine's own load.
- A board grown to about 3,700 cards worked normally for 30 users, and a snapshot of it was around 1 MB.

Until this is measured properly, do not read the reference numbers above as holding for a board with a hundred people on it. To measure it yourself on a quiet machine:

```bash
VUS=100 BOARDS=1 OPS_PER_SEC=0.5 CURSORS_PER_SEC=2 DURATION=60 npm run loadtest     # one busy board
VUS=100 BOARDS=1 OPS_PER_SEC=0.5 CURSORS_PER_SEC=0 DURATION=60 npm run loadtest     # same, without cursors
VUS=30 BOARDS=1 SEED_CARDS=100 SEED_PER_SEC=4 OPS_PER_SEC=0.5 DURATION=90 STORM_AT=50 STORM_COLD=1 \
  ACK_P95_MS=2000 FANOUT_P95_MS=5000 RESYNC_P95_MS=20000 npm run loadtest             # ~3,000 cards, then everyone reloads
```

## Running it from separate hosts

Everything above ran with k6, nginx, both servers, Postgres and Redis on one machine. To measure the real thing, deploy the stack with [`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml) (with `AUTH_DEV_LOGIN=true` and a raised `AUTH_RATE_LIMIT_PER_MIN` while you test, and then switch them off), and run k6 from another machine: `BASE_URL=https://board.example.com npm run loadtest`. One k6 process is fine up to a few hundred virtual users; beyond that run several processes against the same deployment (each creates its own boards). This has not been done by me.

## Where it runs out

Pushing past the reference profile (more users or higher rates) on this machine, each Node instance saturates about one core at roughly 150 commands/s plus the cursor fan-out, and Postgres, which serialises writes per board and holds a connection per transaction, is also close behind. Raising `PG_POOL_MAX` did not change throughput there. Once saturated, latency climbs while correctness still holds (no lost or duplicated events), which is the behaviour we want. Capacity planning from this: add instances for socket and fan-out load, and size Postgres for the write rate. Those are single-machine observations, not limits of the design.

## What this does not measure

- One board with many simultaneous editors, or very large boards (see above)
- Redis or Postgres loss, or restarting both instances at once
- The browser: rendering cost is not in these numbers
- WAN latency, TLS, or a real load balancer in front
