# Redis learning lab

A hands-on way to learn Redis: a mini event-ticketing API that gains one Redis-backed feature per phase. Each feature comes with an experiment that breaks the naive version first, so you can see why the feature exists.

## Roadmap

| Phase | Topic | Highlights |
| --- | --- | --- |
| 0 | Fundamentals and tooling | Workspace setup, `SCAN` vs `KEYS`, `UNLINK` |
| 1 | Caching | Cache-aside, TTL jitter, stampedes, eviction |
| 2 | Atomicity and concurrency | Rate limiting, seat holds, Lua, `WATCH`/`MULTI` |
| 3 | Core data structures | Sessions, leaderboards, delayed jobs |
| 4 | Messaging | Pub/Sub with SSE, Streams with consumer groups |
| 5 | Analytics and specialized structures | HyperLogLog, bitmaps, Bloom filters, Geo |

The full plan is in [SPECS.md](SPECS.md).

## Stack

TypeScript (run with `tsx`), Express 5, `node-redis`, Redis 8 and Redis Insight in Docker, pnpm workspaces.

## Getting started

Requirements: Node 24+, pnpm and Docker.

```bash
pnpm install
docker compose up -d
pnpm --filter labs exec tsx ping.ts    # prints PONG
```

Redis Insight runs at http://localhost:5540. Connect it to host `redis`, port `6379`.

## Layout

```
packages/redis/   shared Redis client
apps/             production-style features (API, worker)
labs/             standalone experiments and benchmarks
```
