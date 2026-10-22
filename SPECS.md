# Redis learning lab: project plan

2026-10-22 · WZRD

## Approach

Build one small app, a mini event-ticketing API, and add a Redis-backed feature in each of six phases (0–5). A single domain makes every command answer a concrete problem: caching, rate limiting, seat holds, leaderboards, background order processing, live updates and analytics.

Every phase follows the same loop:

1. Try the commands by hand in `redis-cli`.
2. Implement the feature in TypeScript.
3. Write a "break it" experiment that shows why the feature exists (a race condition, a stampede, a lost message).
4. Write down what surprised you in the phase's `NOTES.md`.

Keep `redis-cli MONITOR` running in a terminal while the app runs. Seeing the exact commands your code sends is the fastest way to build intuition.

## Setup decisions

The project lives at `~/dev/redis-lab` inside WSL, runs Redis in Docker, and talks to it with `node-redis`.

| Decision        | Choice                             | Why                                                                                                                               |
| --------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Location        | `~/dev/redis-lab` (WSL filesystem) | Code under `/mnt/c/...` is slow across the filesystem boundary and breaks file watchers                                           |
| Redis client    | `node-redis` (`redis` package)     | Redis's recommended Node client; `ioredis` is older and lacks newer features ([source](https://redis.io/resources/redis-clients)) |
| Redis server    | `redis:8` Docker image             | Includes the Bloom filter and other bundled data types, no modules to install                                                     |
| GUI             | Redis Insight (Docker)             | Browse keys and types visually alongside `redis-cli`                                                                              |
| Web framework   | Express 5                          | Familiar, minimal, keeps the focus on Redis                                                                                       |
| Package manager | pnpm workspaces                    | Monorepo with shared Redis package                                                                                                |
| Run TypeScript  | `tsx`                              | Run `.ts` files directly, no build step                                                                                           |
| Tests           | Vitest                             | "Prove it" experiments as repeatable tests                                                                                        |
| Load testing    | `autocannon`                       | Stampede and rate-limit experiments                                                                                               |

`node-redis` differences from snippets you may have seen with `ioredis`: methods are camelCase (`zAdd`, `hSet`), options are objects (`{ NX: true, PX: 600_000 }`), and you must call `connect()` explicitly.

## Monorepo layout

Three areas: `labs/` for throwaway experiments, `apps/` for features built as in production, and `packages/redis` for connection handling and key naming in one place.

```
~/dev/redis-lab/
  docker-compose.yml
  pnpm-workspace.yaml
  package.json
  packages/
    redis/            # client factory, key-name helpers, Lua scripts
  apps/
    api/              # Express app, one router per phase
    worker/           # background consumers (from Phase 4)
  labs/               # standalone tsx scripts: experiments, benchmarks, races
```

```yaml
# pnpm-workspace.yaml
packages:
    - "packages/*"
    - "apps/*"
    - "labs"
```

```yaml
# docker-compose.yml
services:
    redis:
        image: redis:8
        ports: ["6379:6379"]
        command: ["redis-server", "--appendonly", "yes"]
        volumes: [redis-data:/data]
    insight:
        image: redis/redisinsight:latest
        ports: ["5540:5540"] # in Insight, connect to host "redis", port 6379
volumes:
    redis-data:
```

```ts
// packages/redis/src/client.ts
import { createClient } from "redis";

export const redis = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
redis.on("error", (err) => console.error("redis error", err));
await redis.connect();
```

Useful commands from `~/dev/redis-lab`:

- `docker compose up -d` starts Redis and Insight (Insight at `http://localhost:5540`).
- `docker compose exec redis redis-cli` opens a CLI.
- `docker compose exec redis redis-cli MONITOR` streams every command Redis receives.

## Phase 0: Fundamentals and tooling

Goal: a working workspace and a feel for how Redis executes commands, especially why one slow command blocks everyone.

**Commands:** `SET`/`GET`, `INCR`, `EXPIRE`/`TTL`/`PERSIST`, `DEL`/`UNLINK`, `EXISTS`, `TYPE`, `SCAN`, `OBJECT ENCODING`, `INFO`, `MONITOR`.

**Build:**

- [✅] Scaffold the pnpm workspace, `docker-compose.yml` and `packages/redis` client.
- [✅] Express app with a `/health` endpoint that runs `PING`.
- [✅] Graceful shutdown: close the Redis connection on `SIGINT`/`SIGTERM`.
- [✅] Pick a key naming convention, e.g. `event:42`, `hold:event:42:seat:A7`.

**Prove it:**

- [ ] Load 1M keys with a pipelined script in `labs/`, then compare `KEYS *` with `SCAN`. While `KEYS` runs, time a `PING` from a second client: Redis runs commands one at a time, so everything else waits.
- [ ] Compare `DEL` vs `UNLINK` on a very large key (`UNLINK` frees memory in the background).

## Phase 1: Caching

Goal: go beyond `SET EX` and learn what goes wrong with caches under load and memory pressure.

**Commands:** `SET EX`, `MGET`, `HSET`/`HGETALL`, `CONFIG SET maxmemory`, `CONFIG SET maxmemory-policy`, `INFO stats`.

**Build:**

- [ ] Fake a slow database: an in-memory events store with a 200 ms delay per read.
- [ ] Cache-aside for `GET /events/:id`, with invalidation on `PUT /events/:id`.
- [ ] Add random jitter to TTLs so keys written together don't expire together.
- [ ] Store an event both as a JSON string and as a hash; compare reads, partial updates and memory.

**Prove it:**

- [ ] Cache stampede: point autocannon at one key just as it expires and count how many requests hit the "database" at once. Fix it with a short `SET NX` rebuild lock or in-process request coalescing, then rerun.
- [ ] Eviction: set `maxmemory` to a few MB, keep writing, and watch `evicted_keys` in `INFO stats` under `allkeys-lru` vs `noeviction` (writes start failing).

## Phase 2: Atomicity and concurrency

Goal: understand how Redis keeps concurrent clients correct, and the difference between batching and atomicity.

**Commands:** `INCR`, `MULTI`/`EXEC`, `WATCH`, `SET NX PX`, `EVAL`/`EVALSHA` (or `defineScript` in node-redis), pipelining.

**Build:**

- [ ] Rate limiter, three versions: fixed window (`INCR` + `EXPIRE`), sliding window (sorted set), then a Lua script that only records allowed requests.
- [ ] Express middleware using the limiter, returning `429` with a `Retry-After` header.
- [ ] Seat holds: `POST /events/:id/seats/:seat/hold` with `SET NX PX` and a random token; release only if the token matches (Lua).
- [ ] Ticket stock: "reserve N tickets only if at least N remain".

**Prove it:**

- [ ] Overselling: send 200 concurrent requests with `Promise.all` at a naive "read stock, then decrement" endpoint and count oversold tickets. Fix with `WATCH`/`MULTI`, then with Lua, and compare retries.
- [ ] Pipelining: send 10k `SET`s one by one vs pipelined and compare time. A pipeline batches network round-trips but isn't atomic; `MULTI` is atomic.
- [ ] Lock expiry: hold a seat with a 1 s TTL, sleep 2 s in the holder, let a second client take the seat, then show that releasing without a token check would delete the second client's hold.

## Phase 3: Core data structures

Goal: pick the right structure for each problem and see how Redis stores it in memory.

| Structure  | Feature to build                                                     | Commands                                                        |
| ---------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| Hash       | User sessions via `express-session` + `connect-redis`; per-field TTL | `HSET`, `HGETALL`, `HINCRBY`, `HEXPIRE`                         |
| List       | "Recently viewed events" per user, capped at 20                      | `LPUSH`, `LTRIM`, `LRANGE`                                      |
| Set        | Event tags; "events tagged jazz AND london"                          | `SADD`, `SISMEMBER`, `SINTER`, `SUNION`                         |
| Sorted set | "Most popular events" leaderboard                                    | `ZINCRBY`, `ZREVRANGE ... WITHSCORES`, `ZRANK`, `ZRANGEBYSCORE` |
| Sorted set | Delayed jobs: score = run-at timestamp, poller picks due jobs        | `ZADD`, `ZRANGEBYSCORE`, `ZREM`                                 |

**Prove it:**

- [ ] Grow a sorted set past 128 members and watch `OBJECT ENCODING` change from `listpack` to `skiplist`; compare `MEMORY USAGE` before and after.
- [ ] Run two delayed-job pollers at once and make sure each job runs only once (claim with `ZREM`, which returns 1 only for the winner).

## Phase 4: Messaging

Goal: know when to use Pub/Sub (fire-and-forget broadcast) versus Streams (durable log with acknowledgments).

**Commands:** `PUBLISH`, `SUBSCRIBE`, `PSUBSCRIBE`, `XADD`, `XGROUP CREATE`, `XREADGROUP`, `XACK`, `XPENDING`, `XAUTOCLAIM`, `XTRIM`.

**Build:**

- [ ] Live seat availability: publish on every hold/release, push to the browser with Server-Sent Events.
- [ ] Run two API instances on different ports and confirm both deliver updates.
- [ ] Order processing: `POST /orders` appends to a stream; `apps/worker` consumes it in a consumer group and acks after processing.
- [ ] Cap the stream length with `XADD ... MAXLEN ~`.

**Prove it:**

- [ ] Stop the subscriber, publish, restart it: the message is gone, because Pub/Sub stores nothing.
- [ ] Kill a worker mid-job: the order stays in the pending list (`XPENDING`); recover it from another worker with `XAUTOCLAIM`.

Note: a subscribed connection and a blocking read (`XREADGROUP BLOCK`) tie up their connection, so each needs a dedicated client (`redis.duplicate()`).

## Phase 5: Analytics and specialized structures

Goal: learn the structures that trade a little accuracy, or a constraint on IDs, for very large memory savings.

| Structure    | Feature to build                                            | Commands                                |
| ------------ | ----------------------------------------------------------- | --------------------------------------- |
| HyperLogLog  | Unique viewers per event, per day and per week              | `PFADD`, `PFCOUNT`, `PFMERGE`           |
| Bitmap       | Daily active users; "active on both days"                   | `SETBIT`, `GETBIT`, `BITCOUNT`, `BITOP` |
| Bloom filter | "Is this username taken?" check before hitting the database | `BF.RESERVE`, `BF.ADD`, `BF.EXISTS`     |
| Geo          | "Events within 5 km of me"                                  | `GEOADD`, `GEOSEARCH`, `GEODIST`        |

**Prove it:**

- [ ] Add the same 1M IDs to a set and to a HyperLogLog; compare `MEMORY USAGE` and measure the HLL's counting error.
- [ ] Bitmaps need dense integer IDs: set bit 10,000,000 on an empty key and check its memory.
- [ ] Check the Bloom filter's false-positive rate against the error rate you configured.
- [ ] Run `ZRANGE` on a geo key to see it's a sorted set underneath.

## Pacing

Phases 0–4 are the core and cover most production Redis usage; Phase 5 is shorter and can be done in any order after Phase 3. A phase is done when its "Prove it" items pass and its `NOTES.md` explains, in your own words, why each fix works.

- [ ] Phase 0: Fundamentals and tooling
- [ ] Phase 1: Caching
- [ ] Phase 2: Atomicity and concurrency
- [ ] Phase 3: Core data structures
- [ ] Phase 4: Messaging
- [ ] Phase 5: Analytics and specialized structures
