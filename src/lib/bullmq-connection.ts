import { envStore } from "../env-store";

export function getBullMQConnection(): {
  host: string;
  port: number;
  password?: string;
} {
  try {
    const parsed = new URL(envStore.REDIS_URL);
    return {
      host: parsed.hostname || "localhost",
      port: parseInt(parsed.port || "6379", 10),
      ...(parsed.password ? { password: parsed.password } : {}),
    };
  } catch {
    return { host: "localhost", port: 6379 };
  }
}
