import Redis from "ioredis";
import { envStore } from "../env-store";

function createRedis(): Redis {
  const client = new Redis(envStore.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
    lazyConnect: true,
  });
  client.on("error", (err: Error) => console.error("[Redis] error:", err.message));
  return client;
}

const globalForRedis = globalThis as unknown as { _redis?: Redis };

function getInstance(): Redis {
  if (!globalForRedis._redis) {
    globalForRedis._redis = createRedis();
  }
  return globalForRedis._redis;
}

export const redis: Redis = new Proxy({} as Redis, {
  get(_, prop) {
    const instance = getInstance();
    const val = instance[prop as keyof Redis];
    return typeof val === "function" ? (val as Function).bind(instance) : val;
  },
});

export const key = (...parts: string[]): string => `pi:${parts.join(":")}`;
export const permissionsKey = (userId: string): string => key("permissions", userId);
export const rateLimitKey = (endpoint: string, id: string): string => key("ratelimit", endpoint, id);
