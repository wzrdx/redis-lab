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

- [✅] Load 1M keys with a pipelined script in `labs/`, then compare `KEYS *` with `SCAN`. While `KEYS` runs, time a `PING` from a second client: Redis runs commands one at a time, so everything else waits.
- [✅] Compare `DEL` vs `UNLINK` on a very large key (`UNLINK` frees memory in the background).

**Housekeeping**

- [✅] Clean up afterwards with FLUSHALL ASYNC.

## Phase 1: Caching

Goal: go beyond `SET EX` and learn what goes wrong with caches under load and memory pressure.

**Background.** A cache is a fast copy of data whose real home is somewhere slower, usually a database. Redis keeps everything in memory, so reading a key takes well under a millisecond, while a database query might take tens or hundreds. The catch is that a copy can go stale (the database changed but the cache didn't), and memory is limited, so the cache can't hold everything forever. Every task in this phase deals with one of those two problems.

**Commands:**

| Command | What it does |
| --- | --- |
| `SET key value EX seconds` | Stores a string that Redis deletes automatically after `seconds`. The remaining lifetime is the key's TTL (time to live). |
| `GET key` / `MGET key1 key2 ...` | Reads one key, or several keys in a single round-trip. A missing key returns `nil` (`null` in node-redis). |
| `HSET key field value ...` / `HGETALL key` | Writes fields of a hash / reads all of them (see Phase 0 notes for what a hash is). |
| `CONFIG SET maxmemory 5mb` | Caps how much memory Redis may use for data. `0` means no limit. |
| `CONFIG SET maxmemory-policy <policy>` | Decides what happens when the cap is reached: refuse writes (`noeviction`) or delete keys to make room, such as `allkeys-lru` (least recently used first). |
| `INFO stats` | Server counters, including `keyspace_hits`, `keyspace_misses` and `evicted_keys`. |

**Build:**

- [ ] **Fake a slow database.** Create an in-memory "events" store in `apps/api` that stands in for a real database.
    - Keep the data in a plain `Map<string, Event>`, where an event has fields such as `id`, `name`, `venue`, `date`, `price` and `seatsTotal`. Seed it with a handful of events at startup.
    - Wrap reads and writes in `async` functions (`getEvent(id)`, `updateEvent(id, changes)`) that wait 200 ms (`await new Promise((r) => setTimeout(r, 200))`) before answering. This makes the cost of a cache miss obvious.
    - Count every call to `getEvent` in a variable and expose it on a debug endpoint such as `GET /debug/db-reads`. You'll use this number in the stampede experiment to see how many requests actually reached the "database".
- [ ] **Cache-aside for `GET /events/:id`.** Cache-aside means the application, not Redis, manages the cache. On every read:
    1. Look in Redis first: `GET event:42`.
    2. On a **hit** (a value came back), parse it and return it. No database call.
    3. On a **miss** (`null`), call the slow `getEvent`, store the result with `SET event:42 <json> EX 60`, then return it.
    - Use the `keys.event(id)` helper for the key name.
    - Add a response header such as `X-Cache: HIT` or `X-Cache: MISS` so you can see what happened with `curl -i`.
    - **Invalidation on `PUT /events/:id`:** update the database first, then `DEL event:42`. The next `GET` misses and reloads fresh data. Deleting is safer than writing the new value into the cache, because two concurrent updates could otherwise leave the older value cached.
    - Check it: request the same event twice (MISS takes ~200 ms, then HIT is fast), update it, request again (MISS with the new data).
- [ ] **Add random jitter to TTLs.** If you warm the cache with 1,000 events at once and all get `EX 60`, they all expire in the same second and the database gets 1,000 requests at once.
    - Instead of a fixed TTL, use the base plus a random extra, for example `60 + Math.floor(Math.random() * 10)` seconds. Keys written together now expire spread over 10 seconds.
    - Check it: write a few keys in a loop and compare their `TTL` values in `redis-cli`.
- [ ] **Store an event as a JSON string and as a hash, and compare.** The same event can live in Redis in two shapes:
    - **String:** `SET event:42 '{"id":"42","name":"Jazz night","price":30}'`. You always read and write the whole thing.
    - **Hash:** `HSET event:42:h id 42 name "Jazz night" price 30`. Each field is separate. All values come back as strings, so numbers must be converted.
    - Compare three things and write the results in `NOTES.md`:
        1. **Reads:** `GET` + `JSON.parse` versus `HGETALL`.
        2. **Partial updates:** changing only the price. For the string you must read, parse, modify, stringify and write the whole value back. For the hash it's a single `HSET event:42:h price 35`.
        3. **Memory:** `MEMORY USAGE event:42` versus `MEMORY USAGE event:42:h`.
    - There's no single winner. The point is to know which trade-off each shape makes.

**Prove it:**

- [ ] **Cache stampede.** A stampede (also called "thundering herd") happens when a popular key expires and many requests miss at the same moment. Every one of them goes to the database, which is exactly the load the cache was meant to absorb.
    - Install `autocannon` as a dev dependency. It's a load-testing tool that sends many concurrent HTTP requests.
    - Give one event a short TTL (for example 5 seconds), reset the database read counter, and point autocannon at `GET /events/:id` with around 100 concurrent connections for longer than the TTL.
    - Read `GET /debug/db-reads`. Without protection you'll see many reads per expiry instead of one.
    - **Fix 1, a rebuild lock in Redis:** on a miss, try `SET lock:event:42 1 NX EX 5`. `NX` means "only set if the key doesn't exist", so exactly one request gets `OK` and rebuilds the cache. The others get `null`; they wait briefly (for example 50 ms) and read the cache again.
    - **Fix 2, in-process request coalescing:** keep a `Map<string, Promise<Event>>` of loads in progress. If a load for the same id is already running, await that promise instead of starting a new one. This works within one Node process, without Redis, but each API instance still makes its own call.
    - Rerun autocannon after each fix and record the database read counts in `NOTES.md`.
- [ ] **Eviction under memory pressure.** Redis can be told how much memory it may use, and what to do when it runs out.
    - In `redis-cli`, set a small limit: `CONFIG SET maxmemory 5mb`. Redis itself uses about 1 MB, so this leaves a few MB for data.
    - **Policy `noeviction`:** `CONFIG SET maxmemory-policy noeviction`. Write keys in a loop (a `labs/` script) until it fails. Writes start returning an `OOM command not allowed` error, while reads keep working.
    - **Policy `allkeys-lru`:** set it, flush, and run the same loop. This time writes never fail: Redis deletes the least recently used keys to make room. Watch `evicted_keys` grow in `INFO stats`, and `DBSIZE` stop growing.
    - `CONFIG SET` changes only the running server. Reset both settings afterwards (`CONFIG SET maxmemory 0`, `CONFIG SET maxmemory-policy noeviction`) or restart the container.

## Phase 2: Atomicity and concurrency

Goal: understand how Redis keeps concurrent clients correct, and the difference between batching and atomicity.

**Background.** Every single Redis command is atomic: it runs from start to finish without any other command running in the middle (you saw why in Phase 0, there's one command thread). Problems appear when your logic needs **several** commands, such as "read the stock, then decrement it". Between your two commands, another client's commands can run, and the value you read may already be wrong. This phase covers the three tools for this: atomic single commands, transactions (`MULTI`/`EXEC` with `WATCH`), and Lua scripts.

**Commands:**

| Command | What it does |
| --- | --- |
| `INCR key` / `DECRBY key n` | Adds 1 / subtracts `n` and returns the new value, atomically. A missing key counts as 0. |
| `EXPIRE key seconds` | Sets a TTL on an existing key. |
| `SET key value NX PX ms` | Sets the key only if it doesn't exist (`NX`) with a TTL in milliseconds (`PX`). Returns `OK` or `nil`. |
| `MULTI` ... `EXEC` | Queues several commands and runs them as one block that nothing can interleave with. |
| `WATCH key` | Makes the next `EXEC` fail (return `nil`) if `key` changed after `WATCH`. Used for "check, then write" logic. |
| `EVAL script numkeys key... arg...` | Runs a Lua script inside Redis. The whole script is atomic, and it can use `if`/`else` on values it reads. |
| `ZADD` / `ZREMRANGEBYSCORE` / `ZCARD` | Sorted set commands: add a member with a numeric score / remove members in a score range / count members. |

**Build:**

- [ ] **Rate limiter, three versions.** A rate limiter allows each client at most N requests per time window (for example 10 per minute per IP) and rejects the rest. Build it in `packages/redis` or `apps/api` as a function `isAllowed(clientId): Promise<{ allowed: boolean; retryAfter: number }>`, then improve it twice:
    1. **Fixed window:** count requests per minute in a key such as `ratelimit:<ip>:<minute number>`. Each request does `INCR`; if the result is `1` (first request in this window), also `EXPIRE` the key for 60 seconds so old windows clean themselves up. Allowed if the count is ≤ N.
        - Weakness to observe: a client can send N requests at 0:59 and N more at 1:00, so 2N in two seconds.
    2. **Sliding window with a sorted set:** keep one sorted set per client, where each member is one request and its score is the request's timestamp in ms. Per request: remove entries older than 60 seconds (`ZREMRANGEBYSCORE key 0 <now - 60000>`), add the current request (`ZADD key <now> <unique id>`), count (`ZCARD`). Members must be unique, so use something like `` `${now}-${Math.random()}` ``.
        - Weakness to observe: rejected requests are also added to the set, so a client that keeps retrying stays blocked forever.
    3. **Lua script:** move the same logic into one script that removes old entries, counts, and **only adds the request if it's allowed**. Version 2 can't do this as separate commands, because the decision depends on the count read in the same step. In node-redis, register scripts with `defineScript` when creating the client.
- [ ] **Express middleware for the limiter.** Write middleware that calls `isAllowed(req.ip)`.
    - Allowed: call `next()`.
    - Rejected: respond `429 Too Many Requests` with a `Retry-After` header holding the number of seconds until the client may try again.
    - Apply it to the events routes and check it with a quick loop of `curl` requests.
- [ ] **Seat holds.** When a user selects a seat, hold it for 10 minutes so nobody else can take it while they pay.
    - `POST /events/:id/seats/:seat/hold`: generate a random token (`crypto.randomUUID()`), then `SET hold:event:42:seat:A7 <token> NX PX 600000`.
        - `OK`: the seat is now held. Return `201` with the token; the client needs it to release the hold.
        - `null`: someone else holds it. Return `409 Conflict`.
    - `DELETE /events/:id/seats/:seat/hold` with the token in the body: release the hold **only if the stored value equals the token**. Do this in a Lua script (`if redis.call("GET", key) == token then return redis.call("DEL", key) else return 0 end`). With a separate `GET` then `DEL`, the hold could expire and be taken by someone else between the two commands, and you would delete their hold.
    - The TTL means an abandoned hold frees itself; no cleanup job needed.
- [ ] **Ticket stock.** Some events sell general-admission tickets from a counter, `stock:event:42`, instead of numbered seats.
    - Seed it with `SET stock:event:42 100`.
    - `POST /events/:id/reserve` with a quantity `n`: reserve `n` tickets **only if at least `n` remain**, otherwise return `409`.
    - Do the check and the decrement in one Lua script, so no other request can run between them. The "Overselling" experiment below shows what goes wrong without it.

**Prove it:**

- [ ] **Overselling.** Show the race condition, then fix it two ways.
    - **The naive version:** an endpoint (or `labs/` script) that does `GET stock`, checks `stock >= 1` in JavaScript, then `DECR stock`. Set the stock to 100, fire 200 concurrent reservations with `Promise.all`, and count how many succeeded and what the final stock is. Expect more than 100 successes and a negative stock: many requests read "1 left" before any of them decremented.
    - **Fix with `WATCH`/`MULTI`:** `WATCH stock`, `GET stock`, check in JS, then `MULTI` + `DECR` + `EXEC`. If another client changed `stock` after your `WATCH`, `EXEC` returns `null` and nothing happens; you retry. Count the retries.
        - `WATCH` belongs to a **connection**, so 200 concurrent attempts on one shared connection would interfere with each other. Each attempt needs its own connection. node-redis has `createClientPool()`, and `pool.execute(async (client) => { ... })` runs a function on one isolated connection.
    - **Fix with Lua:** the script from the Ticket stock task. No retries at all, because nothing can interleave.
    - Record successes, final stock and retry counts for all three in `NOTES.md`.
- [ ] **Pipelining is not atomicity.** Two ideas that are easy to confuse:
    - **Pipelining** sends many commands without waiting for each reply, which saves network round-trips. Time 10,000 `SET`s awaited one by one versus fired together with `Promise.all` (node-redis pipelines commands sent in the same tick automatically). Expect a large speed difference.
    - **But a pipeline isn't atomic:** other clients' commands can run between the pipelined ones. Only `MULTI`/`EXEC` (or Lua) guarantees nothing runs in between. Also note that `MULTI` doesn't roll back: if one queued command fails, the others still run.
    - Write down the timings and the difference in `NOTES.md`.
- [ ] **Lock expiry and why the token matters.**
    1. Client A holds seat A7 with a **1 second** TTL, then "works" for 2 seconds (`setTimeout`).
    2. Meanwhile the hold expires, and client B holds A7 with its own token.
    3. Client A finishes and releases A7 with a plain `DEL`: B's hold is gone, and a third client could now take the seat B thinks is theirs.
    4. Repeat with the token-checking Lua release: A's release does nothing (returns 0), and B's hold survives.

## Phase 3: Core data structures

Goal: pick the right structure for each problem and see how Redis stores it in memory.

**Background.** Phase 0 introduced the idea that one key can hold a collection. Each collection type is good at different questions:

| Type | Think of it as | Good at |
| --- | --- | --- |
| Hash | A JS object: field → value | Records with named fields, counters per field |
| List | An array you push to and pop from at both ends | Recent items, queues, "latest N" |
| Set | A JS `Set` of unique strings | Membership checks, tags, intersections ("in both A and B") |
| Sorted set | A set where every member has a numeric score, always kept sorted by score | Rankings, leaderboards, anything ordered by time or number |

Small collections are stored compactly (`listpack` encoding, one block of memory) and switch to a real data structure as they grow, which uses more memory but stays fast at large sizes. On this server, sorted sets and sets switch after 128 members (sets containing only integers use an even smaller `intset` encoding up to 512), and hashes after 512 (`CONFIG GET *-max-*-entries`).

**Build:**

- [ ] **Hash: user sessions and a seat cart with per-field TTL.**
    - **Sessions:** install `express-session` and `connect-redis`, and configure the session store to use the shared Redis client. Add a fake `POST /login` that puts a `userId` in the session.
        - Look at the result in Redis Insight: the session is a key such as `sess:<id>` with a TTL. Check its `TYPE`: `connect-redis` stores the session as a JSON **string**, not a hash. This shows how a library chose to use Redis.
    - **Seat cart as a hash:** store a user's held seats in `cart:user:7`, with one field per seat (`A7`, `A8`) and the hold token as the value. `HSET` adds a seat, `HDEL` removes one, `HGETALL` lists the cart, `HLEN` counts it.
    - **Per-field TTL:** a hold expires after 10 minutes, so each cart field should too. `HEXPIRE cart:user:7 600 FIELDS 1 A7` gives just that field a TTL, so seats disappear individually. Before Redis 7.4, only whole keys could expire.
    - Use `HINCRBY` for a numeric field, for example a per-user `views` counter in a `stats:user:7` hash.
- [ ] **List: "recently viewed events" per user, capped at 20.**
    - When a logged-in user opens `GET /events/:id`, push the id to the front: `LPUSH recent:user:7 42`.
    - Cap the list: `LTRIM recent:user:7 0 19` keeps only indexes 0 to 19 (the 20 newest). Without this the list grows forever.
    - Avoid duplicates: remove the id first with `LREM recent:user:7 0 42`, so viewing an event again moves it to the front instead of listing it twice.
    - `GET /me/recent` returns `LRANGE recent:user:7 0 -1` (`-1` means the last element).
- [ ] **Set: event tags and tag queries.**
    - Give each event tags such as `jazz`, `london`, `outdoor`. Store them both ways:
        - Event → tags: `SADD tags:event:42 jazz london` answers "what tags does this event have?".
        - Tag → events: `SADD tag:jazz 42` and `SADD tag:london 42` answer "which events have this tag?". This reverse direction is called an index.
    - `GET /events?tags=jazz,london` returns `SINTER tag:jazz tag:london`: the events in **both** sets (AND). Offer OR with `SUNION`.
    - `SISMEMBER tag:jazz 42` checks a single membership in O(1).
    - When an event's tags change, update both directions, ideally in one `MULTI` so they can't get out of sync.
- [ ] **Sorted set: "most popular events" leaderboard.**
    - Every view of an event: `ZINCRBY popular 1 42` adds 1 to event 42's score (creating it with score 1 if needed).
    - `GET /events/popular` returns the top 10 with their view counts: `ZRANGE popular 0 9 REV WITHSCORES` (`REV` means highest score first; older docs use `ZREVRANGE`).
    - `ZREVRANK popular 42` gives an event's position (0 = most popular).
    - `ZRANGEBYSCORE popular 100 +inf` lists events with at least 100 views.
- [ ] **Sorted set: delayed jobs.** Run a task at a specific time in the future, for example "remind the user 1 hour before the event".
    - Schedule: `ZADD jobs:delayed <runAt timestamp in ms> <job>`, where the job is a JSON string or a job id. The score is the time it should run, so the set is automatically ordered by due time.
    - A poller (a loop in `apps/api` or a small script) runs every second: `ZRANGEBYSCORE jobs:delayed -inf <now> LIMIT 0 10` fetches up to 10 jobs that are due.
    - For each job, **claim it** with `ZREM jobs:delayed <job>` before running it. `ZREM` returns `1` only to the client that actually removed it, so only that poller runs the job.
    - "Running" the job can simply be a `console.log`.

**Prove it:**

- [ ] **Watch the encoding change.** In a `labs/` script or `redis-cli`:
    - Add 128 members to a sorted set. `OBJECT ENCODING` says `listpack`; note `MEMORY USAGE`.
    - Add one more. The encoding becomes `skiplist`, and `MEMORY USAGE` jumps by much more than one member's worth.
    - Explain in `NOTES.md` why Redis uses two encodings (compact and slow to search versus bigger and fast).
- [ ] **Two pollers, each job runs once.** Start two delayed-job pollers at the same time, schedule 100 jobs due now, and record which poller ran each job.
    - Every job must run exactly once in total. Prove it by counting.
    - Then remove the `ZREM` check (run every job you fetched) and show that jobs now run twice.

## Phase 4: Messaging

Goal: know when to use Pub/Sub (fire-and-forget broadcast) versus Streams (durable log with acknowledgments).

**Background.** Redis can carry messages between processes in two very different ways:

- **Pub/Sub** is like a radio broadcast. Publishers send a message to a named **channel**; whoever is subscribed at that moment receives it. Redis stores nothing, so a subscriber that is offline misses the message forever. Good for live updates where only the latest state matters.
- **Streams** are like an append-only log, or a mailbox that keeps letters. Every message is stored with an ID until you trim it. **Consumer groups** let several workers share the work: each message goes to one worker, and the worker must **acknowledge** it when done. Unacknowledged messages stay "pending" and can be recovered if a worker crashes. Good for jobs that must not be lost, like orders.

**Commands:**

| Command | What it does |
| --- | --- |
| `PUBLISH channel message` | Sends a message to everyone subscribed to `channel` right now. Returns how many received it. |
| `SUBSCRIBE channel` / `PSUBSCRIBE pattern` | Listens to a channel / to all channels matching a pattern such as `seats:*`. |
| `XADD stream * field value ...` | Appends a message. `*` lets Redis generate the ID (`<ms timestamp>-<sequence>`). |
| `XGROUP CREATE stream group $ MKSTREAM` | Creates a consumer group. `$` means "only messages added from now on"; `MKSTREAM` creates the stream if missing. |
| `XREADGROUP GROUP group consumer COUNT n BLOCK ms STREAMS stream >` | Reads up to `n` new messages (`>`) for this consumer, waiting up to `ms` if there are none. |
| `XACK stream group id` | Marks a message as done, removing it from the pending list. |
| `XPENDING stream group` | Shows delivered but not yet acknowledged messages, and which consumer has them. |
| `XAUTOCLAIM stream group consumer min-idle-ms start` | Takes over pending messages that have been idle too long, such as those of a crashed worker. |
| `XTRIM stream MAXLEN ~ n` | Deletes old messages to keep the stream around `n` long. |

**Build:**

- [ ] **Live seat availability with Pub/Sub and Server-Sent Events.**
    - Whenever a seat hold is created or released (Phase 2), `PUBLISH seats:event:42 '{"seat":"A7","status":"held"}'`.
    - Add `GET /events/:id/seats/stream`, a **Server-Sent Events** (SSE) endpoint: a long-lived HTTP response with header `Content-Type: text/event-stream`, where the server writes `data: <json>\n\n` each time something happens. Browsers read it with `new EventSource(url)`; `curl -N` shows it in a terminal.
    - Use **one** subscriber connection per API instance (`redis.duplicate()`, because a subscribed connection can't run other commands). Subscribe to `seats:*` with `PSUBSCRIBE`, and forward each message to the SSE responses watching that event. Keep the open responses in a `Map<eventId, Set<Response>>` and remove them when the client disconnects (`req.on("close", ...)`).
    - Limitation to note: holds that **expire** don't trigger your code, so no message is published. Redis can announce expirations through "keyspace notifications"; that's optional here.
- [ ] **Two API instances, one Redis.** Start a second API on another port (`PORT=3001 pnpm --filter api dev`).
    - Open an SSE stream on each instance (`curl -N localhost:3000/...` and `curl -N localhost:3001/...`), then hold a seat through only one of them. Both streams must show the update.
    - This is why Pub/Sub is used instead of an in-process `EventEmitter`: an event inside one Node process never reaches the other.
- [ ] **Order processing with a Stream and a consumer group.**
    - `POST /orders` appends the order to a stream: `XADD orders * userId 7 eventId 42 qty 2`, and returns `202 Accepted` with the message ID right away, without waiting for processing.
    - Create `apps/worker`, a separate Node process. At startup it creates the group (`XGROUP CREATE orders workers $ MKSTREAM`; ignore the error if it already exists), then loops: `XREADGROUP GROUP workers worker-1 COUNT 10 BLOCK 5000 STREAMS orders >`, "processes" each order (wait 2 seconds and log it), then `XACK orders workers <id>`.
    - Give each worker its own consumer name (for example from an env variable), so you can run several.
    - The blocking read ties up its connection, so the worker uses a dedicated connection for it.
- [ ] **Cap the stream length.** A stream keeps every message until told otherwise, so it grows forever.
    - Add `MAXLEN ~ 10000` to the `XADD` (in node-redis, the `TRIM` option). Redis then trims old entries as it adds new ones.
    - The `~` means "about": Redis trims only when it can drop a whole internal block, which is much cheaper than trimming to exactly 10,000 on every add.

**Prove it:**

- [ ] **Pub/Sub doesn't store anything.**
    - Subscribe in one terminal (`redis-cli SUBSCRIBE test`) and publish from another: the message arrives, and `PUBLISH` returns `1`.
    - Stop the subscriber, publish again (`PUBLISH` returns `0`, nobody received it), then subscribe again: the message is gone for good.
    - Contrast with streams: messages added while the worker is stopped are waiting when it starts.
- [ ] **A crashed worker doesn't lose orders.**
    1. Post an order and kill the worker (Ctrl+C) during its 2-second "processing", before it acks.
    2. `XPENDING orders workers` shows the message still pending, assigned to the dead consumer, with its idle time.
    3. Start a second worker that runs `XAUTOCLAIM orders workers worker-2 10000 0-0` at startup: it takes over messages idle for more than 10 seconds, processes them and acks them.
    4. `XPENDING` is empty again. Note in `NOTES.md` that a message can be **processed twice** this way (the first worker may have finished the work but crashed before `XACK`), so processing should be safe to repeat.

## Phase 5: Analytics and specialized structures

Goal: learn the structures that trade a little accuracy, or a constraint on IDs, for very large memory savings.

**Background.** Some questions don't need exact answers, or have a shape that allows a much smaller representation:

- **HyperLogLog** counts unique items (for example unique visitors) using at most about 12 KB per counter, no matter how many items. The count is approximate, with an error of about 0.81%.
- **Bitmaps** are strings used as arrays of bits. Bit number N represents user N. One million users fit in about 125 KB, but it only works when IDs are integers packed closely together.
- **Bloom filters** answer "have I seen this item?" with either "definitely not" or "probably yes". They never miss an item that was added, but sometimes say "probably yes" for one that wasn't (a false positive). You choose the false-positive rate up front.
- **Geo** stores longitude/latitude points and finds those within a distance. Underneath it's a sorted set whose scores encode the location.

**Build:**

- [ ] **HyperLogLog: unique viewers per event, per day and per week.**
    - On every event view, `PFADD views:event:42:2026-10-27 <userId>`. Adding the same user twice doesn't change the count.
    - `PFCOUNT views:event:42:2026-10-27` returns the approximate number of unique viewers that day.
    - **Per week:** `PFCOUNT` accepts several keys and counts the union, so pass the 7 daily keys. To keep the weekly result, `PFMERGE views:event:42:week-44 <the 7 daily keys>`.
    - Expose it on `GET /events/:id/stats`.
- [ ] **Bitmap: daily active users.**
    - When a user does anything, `SETBIT active:2026-10-27 <userId> 1`. The user ID is the bit position, so IDs must be integers.
    - `BITCOUNT active:2026-10-27` counts how many users were active that day.
    - "Active on both days": `BITOP AND active:both active:2026-10-26 active:2026-10-27`, then `BITCOUNT active:both`. `OR` gives "active on either day".
    - `GETBIT active:2026-10-27 7` checks one user.
- [ ] **Bloom filter: "is this username taken?"**
    - Create the filter once: `BF.RESERVE usernames 0.01 100000` (1% false positives, sized for 100,000 names). Bloom filters are built into Redis 8; in node-redis use `redis.bf.reserve(...)`.
    - When a user registers, add the name to the fake database and `BF.ADD usernames <name>`.
    - `GET /usernames/:name/available`: if `BF.EXISTS` returns 0, the name is **definitely** free; answer without touching the database. If it returns 1, the name is **probably** taken, so confirm in the database.
    - The win: most checks for free names never reach the database.
- [ ] **Geo: "events within 5 km of me".**
    - Store each event's venue: `GEOADD venues <longitude> <latitude> 42`. Note the order: **longitude first**, the opposite of how coordinates are usually written.
    - `GET /events/nearby?lat=...&lon=...&km=5` returns `GEOSEARCH venues FROMLONLAT <lon> <lat> BYRADIUS 5 km ASC WITHDIST`: events within 5 km, nearest first, with their distance.
    - `GEODIST venues 42 43 km` gives the distance between two venues.

**Prove it:**

- [ ] **HyperLogLog vs Set: memory and accuracy.**
    - In a `labs/` script, add the same 1M distinct IDs to a set (`SADD`) and to a HyperLogLog (`PFADD`), in pipelined batches.
    - Compare `MEMORY USAGE` of both keys: tens of MB versus about 12 KB.
    - Compare `SCARD` (exact count) with `PFCOUNT` and compute the error percentage. It should be around 1% or less.
- [ ] **Bitmaps need dense integer IDs.**
    - On an empty key, `SETBIT sparse 10000000 1` sets one single bit, then check `MEMORY USAGE sparse`: about 1.25 MB, because Redis must allocate every bit up to position 10,000,000.
    - Conclusion for `NOTES.md`: bitmaps suit sequential IDs (1, 2, 3, ...), not random or very large ones such as UUIDs or phone numbers.
- [ ] **Measure the Bloom filter's false-positive rate.**
    - Reserve a filter with a 1% error rate and add 100,000 names.
    - Check 100,000 **different** names that were never added, and count how many `BF.EXISTS` wrongly reports as present.
    - The result should be close to 1%.
    - Then add far more names than the capacity you reserved and run `BF.INFO usernames`. By default the filter doesn't fill up: it adds extra internal layers ("sub-filters") to keep the error rate in check, at the cost of more memory. Note how the memory and the false-positive rate change.
- [ ] **Geo is a sorted set underneath.**
    - `TYPE venues` says `zset`, and `ZRANGE venues 0 -1 WITHSCORES` lists the members with large numeric scores: each score is the location encoded as a number (a geohash).
    - So sorted set commands such as `ZREM` and `ZCARD` work on geo keys too.

## Pacing

Phases 0–4 are the core and cover most production Redis usage; Phase 5 is shorter and can be done in any order after Phase 3. A phase is done when its "Prove it" items pass and its `NOTES.md` explains, in your own words, why each fix works.

- [✅] Phase 0: Fundamentals and tooling
- [ ] Phase 1: Caching
- [ ] Phase 2: Atomicity and concurrency
- [ ] Phase 3: Core data structures
- [ ] Phase 4: Messaging
- [ ] Phase 5: Analytics and specialized structures
