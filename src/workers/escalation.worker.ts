/**
 * Escalation Worker — BullMQ repeatable job
 *
 * Runs every hour. Finds jobs where the status hasn't changed for longer than
 * the configured threshold (SystemSetting `stuck_job_threshold_hours`, default 48h).
 * ALTA jobs use a 2x multiplier (SystemSetting `alta_stuck_threshold_multiplier`, default 2).
 *
 * On detection: creates Notification records for the job owner crew + all office managers.
 */

import { Worker, Queue } from "bullmq";
import { JobStatus, UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { workerLogger as logger } from "../lib/logger";
import { getBullMQConnection } from "../lib/bullmq-connection";

const QUEUE_NAME = "escalation";
const REPEATABLE_KEY = "stuck-job-check";
const STAKING_CHECK_KEY = "staking-escalation-check";

const NON_TERMINAL_STATUSES: JobStatus[] = [
  JobStatus.unassigned,
  JobStatus.assigned,
  JobStatus.in_progress,
  JobStatus.field_complete,
  JobStatus.ready_for_drafting,
  JobStatus.drafting,
  JobStatus.drafted,
  JobStatus.pls_review,
  JobStatus.awaiting_corrections,
  JobStatus.ready_for_delivery,
];

async function getSystemSettingNumber(key: string, defaultValue: number): Promise<number> {
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key } });
    if (setting && typeof setting.value === "number") return setting.value;
    if (setting && typeof setting.value === "object" && setting.value !== null) {
      const v = (setting.value as Record<string, unknown>)["value"];
      if (typeof v === "number") return v;
    }
  } catch {
    // fall through to default
  }
  return defaultValue;
}

async function runEscalationCheck(): Promise<void> {
  const thresholdHours = await getSystemSettingNumber("stuck_job_threshold_hours", 48);
  const altaMultiplier = await getSystemSettingNumber("alta_stuck_threshold_multiplier", 2);

  const now = new Date();
  const defaultThresholdMs = thresholdHours * 60 * 60 * 1000;
  const altaThresholdMs = defaultThresholdMs * altaMultiplier;

  const stuckJobs = await prisma.job.findMany({
    where: {
      status: { in: NON_TERMINAL_STATUSES },
      lastStatusChangedAt: { not: null },
    },
    select: {
      id: true,
      jobNumber: true,
      status: true,
      isAlta: true,
      lastStatusChangedAt: true,
      assignedCrewId: true,
      assignedCrew: { select: { id: true, name: true } },
    },
  });

  const stuckJobsList = stuckJobs.filter((job) => {
    if (!job.lastStatusChangedAt) return false;
    const elapsed = now.getTime() - job.lastStatusChangedAt.getTime();
    const threshold = job.isAlta ? altaThresholdMs : defaultThresholdMs;
    return elapsed > threshold;
  });

  if (stuckJobsList.length === 0) {
    logger.info("Escalation check: no stuck jobs found");
    return;
  }

  logger.info(`Escalation check: found ${stuckJobsList.length} stuck job(s)`);

  const officeManagers = await prisma.user.findMany({
    where: { role: UserRole.office_manager, isActive: true },
    select: { id: true },
  });

  const notifications: Array<{
    userId: string;
    type: string;
    title: string;
    message: string;
    entityType: string;
    entityId: string;
  }> = [];

  for (const job of stuckJobsList) {
    const elapsed = job.lastStatusChangedAt
      ? Math.floor((now.getTime() - job.lastStatusChangedAt.getTime()) / 3600000)
      : 0;

    const statusLabel = job.status.replace(/_/g, " ");
    const title = `Job ${job.jobNumber} is stuck in ${statusLabel}`;
    const message = `Job #${job.jobNumber}${job.isAlta ? " (ALTA)" : ""} has been in '${statusLabel}' for ${elapsed}h — escalation threshold exceeded.`;

    for (const om of officeManagers) {
      notifications.push({
        userId: om.id,
        type: "job_escalation",
        title,
        message,
        entityType: "job",
        entityId: job.id,
      });
    }
  }

  if (notifications.length > 0) {
    await prisma.notification.createMany({ data: notifications, skipDuplicates: true });
    logger.info(`Escalation: created ${notifications.length} notification(s)`);
  }
}

async function runStakingEscalationCheck(): Promise<void> {
  const thresholdMins = await getSystemSettingNumber("staking_escalation_threshold_mins", 30);
  const thresholdMs = thresholdMins * 60 * 1000;

  const now = new Date();
  const overdueRequests = await prisma.stakingRequest.findMany({
    where: {
      status: "pending",
      requestedAt: { lt: new Date(now.getTime() - thresholdMs) },
      escalatedAt: null,
    },
    include: {
      job: { select: { id: true, jobNumber: true } },
    },
  });

  if (overdueRequests.length === 0) {
    logger.info("Staking escalation check: no overdue requests");
    return;
  }

  logger.info(`Staking escalation: ${overdueRequests.length} overdue request(s)`);

  const officeManagers = await prisma.user.findMany({
    where: { role: UserRole.office_manager, isActive: true },
    select: { id: true },
  });

  const notifications: Array<{
    userId: string;
    type: string;
    title: string;
    message: string;
    entityType: string;
    entityId: string;
  }> = [];

  for (const req of overdueRequests) {
    const pendingMins = Math.floor((now.getTime() - req.requestedAt.getTime()) / 60000);
    const title = `Staking request for Job ${req.job.jobNumber} is overdue`;
    const message = `A staking request for Job #${req.job.jobNumber} has been pending for ${pendingMins} minutes (threshold: ${thresholdMins} min). Please assign someone to respond.`;

    for (const om of officeManagers) {
      notifications.push({
        userId: om.id,
        type: "staking_escalation",
        title,
        message,
        entityType: "staking_request",
        entityId: req.id,
      });
    }
  }

  if (notifications.length > 0) {
    await prisma.notification.createMany({ data: notifications, skipDuplicates: true });
  }

  // Mark as escalated so we don't re-notify on next run
  await prisma.stakingRequest.updateMany({
    where: { id: { in: overdueRequests.map((r) => r.id) } },
    data: { escalatedAt: now },
  });

  logger.info(`Staking escalation: created ${notifications.length} notification(s)`);
}

export function startEscalationWorker(): { worker: Worker; queue: Queue } {
  const connection = getBullMQConnection();

  const queue = new Queue(QUEUE_NAME, { connection });

  // Register repeatable jobs
  void queue.add(REPEATABLE_KEY, {}, { repeat: { every: 60 * 60 * 1000 }, jobId: REPEATABLE_KEY });
  // Staking escalation check every 5 minutes
  void queue.add(STAKING_CHECK_KEY, {}, { repeat: { every: 5 * 60 * 1000 }, jobId: STAKING_CHECK_KEY });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === REPEATABLE_KEY) {
        await runEscalationCheck();
      } else if (job.name === STAKING_CHECK_KEY) {
        await runStakingEscalationCheck();
      }
    },
    { connection, concurrency: 1 }
  );

  worker.on("completed", (job) => {
    logger.info(`Escalation job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`Escalation job ${job?.id} failed`, { error: err });
  });

  return { worker, queue };
}
