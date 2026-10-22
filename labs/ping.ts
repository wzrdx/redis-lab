import { redis } from "@redis-lab/redis";

console.log(await redis.ping());

await redis.quit();
