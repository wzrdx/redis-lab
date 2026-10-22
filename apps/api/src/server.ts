import { redis } from "@redis-lab/redis";
import express from "express";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.get("/health", async (_req, res) => {
    if (!redis.isReady) {
        res.status(503).json({ status: "error", redis: "not ready" });

        return;
    }

    const pong = await redis.ping();

    res.json({ status: "ok", redis: pong });
});

const server = app.listen(port, () => {
    console.log(`api listening on http://localhost:${port}`);
});

async function shutdown(signal: string) {
    console.log(`${signal} received, shutting down`);

    server.close();
    await redis.quit();

    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
