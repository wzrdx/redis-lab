# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Redis learning lab: a mini event-ticketing API that gains one Redis-backed feature per phase (0 to 5). `SPECS.md` is the roadmap and source of truth for scope. It lists each phase's commands, "Build" items and "Prove it" experiments as checkboxes. Completed items are marked `[✅]`. Read it before starting work, to see which phase is current.

Every phase follows the same loop: try the commands in `redis-cli`, implement in TypeScript, write a "break it" experiment that shows why the feature exists, then record findings in that phase's `NOTES.md`.

## Commands

```bash
docker compose up -d                              # Redis on :6379, Redis Insight on :5540
docker compose exec redis redis-cli               # interactive CLI
docker compose exec redis redis-cli MONITOR       # stream every command Redis receives

pnpm install
pnpm dev                                          # API on :3000 (PORT env), restarts on save
pnpm --filter labs exec tsx ping.ts               # run a lab script (connectivity check)
pnpm exec tsc -p packages/redis                   # type check a package
```

There is no build step: `tsx` runs `.ts` files directly, and `tsconfig.base.json` sets `noEmit`, so `tsc` only type checks. There are no tests or linter yet. The spec plans Vitest for turning "Prove it" experiments into repeatable tests, and `autocannon` for load experiments.

## Architecture

- **pnpm workspace** with three areas (`pnpm-workspace.yaml`):
  - `packages/redis`: the shared client, plus key-name helpers and Lua scripts as they're added.
  - `apps/`: features built as in production. `apps/api` is the Express 5 app with one router per phase. `apps/worker` holds the stream consumers from Phase 4. Neither exists yet.
  - `labs/`: throwaway standalone scripts for experiments, benchmarks and races.
- **`@redis-lab/redis`** exports its TypeScript source directly (`"exports": "./src/client.ts"`). Consumers depend on it with `workspace:*`.
- **Importing the client connects.** `client.ts` calls `await redis.connect()` at module top level. Scripts must call `redis.quit()` or the process won't exit. Pub/Sub subscribers and blocking reads (`XREADGROUP BLOCK`) need a dedicated connection from `redis.duplicate()`.
- **Client library:** `node-redis` (the `redis` package, v6), not `ioredis`. Methods are camelCase (`zAdd`, `hSet`) and options are objects (`{ NX: true, PX: 600_000 }`).
- **Redis 8** runs in Docker with append-only persistence, so data survives restarts. Bloom filters and other bundled data types are available without modules. From inside the Compose network (for example in Redis Insight), the host is `redis`, not `localhost`.
- **Key naming convention:** colon-separated, for example `event:42` and `hold:event:42:seat:A7`.
- **Tooling:** the pnpm version is pinned through `packageManager` in the root `package.json`, and `allowBuilds` in `pnpm-workspace.yaml` permits esbuild's install script, which `tsx` needs.
