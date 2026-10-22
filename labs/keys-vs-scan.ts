import { redis } from "@redis-lab/redis";

const duplicate = redis.duplicate();
await duplicate.connect();

setTimeout(async () => {
    const start = performance.now();
    await duplicate.ping();
    const end = performance.now();
    console.log(end - start);
}, 10);

setTimeout(async () => {
    const start = performance.now();
    await duplicate.ping();
    const end = performance.now();
    console.log(end - start);
}, 30);

setTimeout(async () => {
    const start = performance.now();
    await duplicate.ping();
    const end = performance.now();
    console.log(end - start);

    await duplicate.quit();
}, 50);

const all = new Set<string>();

for await (const keys of redis.scanIterator({ MATCH: "*", COUNT: 1000 })) {
    for (const key of keys) {
        all.add(key);
    }
}

console.log(all.size);

await redis.quit();
