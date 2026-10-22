import { redis } from "@redis-lab/redis";
import { keys } from "@redis-lab/redis/keys";

const STEP = 10_000;

for (let i = 0; i < STEP * 100; i += STEP) {
    console.log("Batch", 1 + i / STEP);

    const batch = Array.from({ length: STEP }, (_, j) => i + j + 1).map((n) =>
        redis.set(keys.seed(n), `value_${n}`),
    );

    await Promise.all(batch);
}

await redis.quit();
