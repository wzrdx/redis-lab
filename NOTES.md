# Notes

## Phase 0: Fundamentals and tooling

### `KEYS *` vs `SCAN` on 1M keys

Setup: 1M string keys (`seed:1` to `seed:1000000`). One connection runs the command while a second connection times `PING`s.

| Command | Server time (`SLOWLOG`) | `PING` on second connection |
| --- | --- | --- |
| `KEYS *` | 162 ms | ~189 ms |
| `SCAN` (`COUNT 1000`) | not logged (each call < 10 ms) | 1.3 to 2.8 ms |

- Redis executes commands one at a time, so a single slow command blocks every client, not just the one that sent it.
- `SCAN` does the same total work in small steps, and other clients' commands run between the steps.
- `SCAN` can return a key more than once across batches, so deduplicate with a `Set` if you need exact results.
- `SLOWLOG GET` shows the server-side execution time in microseconds, which excludes network time and waiting in the queue.

### `DEL` vs `UNLINK` on a large key

Studied, not measured. No timings were recorded.

- A large collection (for example a hash with 2M fields) is stored as millions of separate allocations, so freeing it is O(N).
- `DEL` frees everything on the main thread and blocks all clients while it does, the same problem as `KEYS *`.
- `UNLINK` removes the key from the keyspace in O(1), so it's gone for every client immediately, and frees the memory on a background thread ("lazy free"). Small values are freed inline because handing them off costs more.
- Small hashes (up to `hash-max-listpack-entries`, 512 on this server) use a compact `listpack` encoding, a single allocation, so deleting them is cheap either way. A big string is also a single allocation.
- `lazyfree-lazy-user-del yes` would make `DEL` behave like `UNLINK`. It's `no` on this server.
- `FLUSHALL ASYNC` applies the same lazy free to the whole dataset. With AOF enabled, `BGREWRITEAOF` compacts the log afterwards.
