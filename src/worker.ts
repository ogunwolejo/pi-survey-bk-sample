import "dotenv/config";
import { configureEnv } from "./env-store";
import { workerLogger as logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { redis } from "./lib/redis";
import { startCustomerIoWorker } from "./lib/customerio-worker";
import { startEscalationWorker } from "./workers/escalation.worker";
import { startSiteAccessWorker } from "./workers/site-access.worker";
import { startRouteNotificationWorker } from "./workers/route-notification.worker";

async function bootstrap(): Promise<void> {
  await configureEnv();

  logger.info("Starting BullMQ workers…");

  startCustomerIoWorker();
  startEscalationWorker();
  startSiteAccessWorker();
  startRouteNotificationWorker();

  logger.info("All workers running");
}

const shutdown = (signal: string) => {
  logger.info(`${signal} received — shutting down workers`);
  void redis.quit().then(() =>
    prisma.$disconnect().then(() => process.exit(0)),
  );
  setTimeout(() => process.exit(1), 10_000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

bootstrap().catch((err) => {
  logger.error("Worker bootstrap failed", { error: String(err) });
  process.exit(1);
});
