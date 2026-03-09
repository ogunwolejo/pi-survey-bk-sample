import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { envStore, AppEnv } from "../env-store";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pool: Pool | undefined;
};

function createPrismaClient(): PrismaClient {
  const rawUrl = envStore.DATABASE_URL;
  try {
    const parsed = new URL(rawUrl);
    console.log("[PRISMA-DEBUG] DB connection →", {
      host: parsed.hostname,
      port: parsed.port,
      database: parsed.pathname,
      user: parsed.username,
      passwordSet: !!parsed.password,
      params: parsed.search,
    });
  } catch {
    console.log("[PRISMA-DEBUG] DATABASE_URL is not a valid URL:", rawUrl?.slice(0, 30) + "…");
  }

  const pool = new Pool({ connectionString: rawUrl });
  globalForPrisma.pool = pool;

  const adapter = new PrismaPg(pool);

  const client = new PrismaClient({
    adapter,
    log:
      envStore.NODE_ENV === AppEnv.DEVELOPMENT
        ? ["query", "error", "warn"]
        : ["error"],
  });

  if (envStore.NODE_ENV !== AppEnv.PRODUCTION) {
    globalForPrisma.prisma = client;
  }

  return client;
}

/** Lazy-initialized — first access triggers creation (after configureEnv) */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (!globalForPrisma.prisma) {
      globalForPrisma.prisma = createPrismaClient();
    }
    return Reflect.get(globalForPrisma.prisma, prop, receiver);
  },
});
