import { Queue, Worker, type Job } from "bullmq";
import type { Server as SocketServer } from "socket.io";
import { getBullMQConnection } from "./bullmq-connection";
import { redis, key } from "./redis";
import { generalLogger as logger } from "./logger";
import type { DashboardRoom, DashboardEventName } from "./socket-emitter";

const QUEUE_NAME = "dashboard-events";
const EVENT_LOG_KEY = key("dashboard-events", "log");
const EVENT_LOG_TTL_MS = 5 * 60 * 1000;

export interface DashboardEventJob {
  room: DashboardRoom;
  event: DashboardEventName;
  payload: Record<string, unknown>;
  timestamp: number;
}

// ─── Queue (used by route handlers via enqueueDashboardEvent) ────────────────

let _dashboardQueue: Queue<DashboardEventJob> | null = null;

function getDashboardQueue(): Queue<DashboardEventJob> {
  if (!_dashboardQueue) {
    _dashboardQueue = new Queue<DashboardEventJob>(QUEUE_NAME, {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 200,
        removeOnFail: 500,
      },
    });
  }
  return _dashboardQueue;
}

/**
 * Enqueue a dashboard event for reliable delivery.
 * Called from route handlers instead of emitting directly.
 */
export async function enqueueDashboardEvent(
  room: DashboardRoom,
  event: DashboardEventName,
  payload: Record<string, unknown>,
): Promise<void> {
  await getDashboardQueue().add("emit", {
    room,
    event,
    payload,
    timestamp: Date.now(),
  });
}

// ─── Worker (started once at server bootstrap) ──────────────────────────────

let worker: Worker<DashboardEventJob> | null = null;

/**
 * Starts the BullMQ worker that processes dashboard events.
 * Must be called once at server startup with the Socket.io instance.
 */
export function startDashboardEventWorker(io: SocketServer): void {
  if (worker) return;

  worker = new Worker<DashboardEventJob>(
    QUEUE_NAME,
    async (job: Job<DashboardEventJob>) => {
      const { room, event, payload, timestamp } = job.data;

      io.to(room).emit(event, payload);

      const logEntry = JSON.stringify({ room, event, payload, timestamp });
      await redis.zadd(EVENT_LOG_KEY, timestamp, logEntry);

      const cutoff = Date.now() - EVENT_LOG_TTL_MS;
      await redis.zremrangebyscore(EVENT_LOG_KEY, "-inf", cutoff);

      logger.debug("Dashboard event emitted", { room, event });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 10,
    },
  );

  worker.on("failed", (job, err) => {
    logger.error("Dashboard event worker failed", {
      jobId: job?.id,
      error: err.message,
    });
  });

  worker.on("error", (err) => {
    logger.error("Dashboard event worker error", { error: err.message });
  });

  logger.info("Dashboard event worker started");
}

/**
 * Returns events from the Redis log since the given timestamp.
 * Used for catch-up when a client reconnects.
 */
export async function getEventsSince(
  sinceTimestamp: number,
): Promise<DashboardEventJob[]> {
  const entries = await redis.zrangebyscore(
    EVENT_LOG_KEY,
    sinceTimestamp,
    "+inf",
  );
  return entries.map((e) => JSON.parse(e) as DashboardEventJob);
}
