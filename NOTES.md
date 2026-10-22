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
