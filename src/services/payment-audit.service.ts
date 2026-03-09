import { Queue, Worker, type Job as BullJob } from "bullmq";
import { Prisma } from "@prisma/client";
import { getBullMQConnection } from "../lib/bullmq-connection";
import { prisma } from "../lib/prisma";
import { paymentLogger as logger } from "../lib/logger";

const QUEUE_NAME = "payment-audit";
const BATCH_SIZE = 50;

export interface AuditEntry {
  userId?: string;
  userName: string;
  actionType: string;
  entityType: string;
  entityId?: string;
  entityNumber?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

let _auditQueue: Queue<AuditEntry> | null = null;

function getAuditQueue(): Queue<AuditEntry> {
  if (!_auditQueue) {
    _auditQueue = new Queue<AuditEntry>(QUEUE_NAME, {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 500 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    });
  }
  return _auditQueue;
}

/**
 * Fire-and-forget audit log entry. Non-blocking — queues via BullMQ.
 */
export function logPaymentAudit(entry: AuditEntry): void {
  getAuditQueue()
    .add("audit", entry)
    .catch((err) => {
      logger.error("Failed to enqueue payment audit", {
        error: String(err),
        actionType: entry.actionType,
      });
    });
}

let _worker: Worker<AuditEntry> | null = null;

export function startPaymentAuditWorker(): void {
  if (_worker) return;

  const pending: AuditEntry[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  async function flushBatch(): Promise<void> {
    if (pending.length === 0) return;
    const batch = pending.splice(0, BATCH_SIZE);
    try {
      await prisma.paymentAuditLog.createMany({
        data: batch.map((e) => ({
          userId: e.userId ?? null,
          userName: e.userName,
          actionType: e.actionType,
          entityType: e.entityType,
          entityId: e.entityId ?? null,
          entityNumber: e.entityNumber ?? null,
          metadata:
            (e.metadata as Prisma.InputJsonValue | undefined) ??
            Prisma.JsonNull,
          ipAddress: e.ipAddress ?? null,
          userAgent: e.userAgent ?? null,
        })),
      });
      logger.debug(`Payment audit batch written: ${batch.length} entries`);
    } catch (err) {
      logger.error("Payment audit batch write failed", { error: String(err) });
    }
  }

  _worker = new Worker<AuditEntry>(
    QUEUE_NAME,
    async (job: BullJob<AuditEntry>) => {
      pending.push(job.data);
      if (pending.length >= BATCH_SIZE) {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        await flushBatch();
      } else if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flushBatch().catch(() => {});
        }, 2000);
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );

  _worker.on("error", (err) => {
    logger.error("Payment audit worker error", { error: err.message });
  });

  logger.info("Payment audit worker started");
}
