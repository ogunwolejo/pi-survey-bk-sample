import { prisma } from "../lib/prisma";
import { JobStatus } from "@prisma/client";
import { ConflictError, NotFoundError, AuthorizationError } from "../lib/errors";
import { jobLogger as logger } from "../lib/logger";

export async function getDraftingQueue(statusFilter?: string) {
  const statuses = statusFilter
    ? [statusFilter as JobStatus]
    : [JobStatus.ready_for_drafting, JobStatus.awaiting_corrections];

  return prisma.job.findMany({
    where: { status: { in: statuses }, deletedAt: null },
    select: {
      id: true,
      jobNumber: true,
      status: true,
      internalDueDate: true,
      isAlta: true,
      claimedById: true,
      claimedAt: true,
      claimedBy: { select: { id: true, name: true } },
      order: { select: { propertyAddressLine1: true, propertyCity: true } },
      documentMetadata: { select: { id: true } },
    },
    orderBy: { internalDueDate: "asc" },
  });
}

export async function claimJob(jobId: string, userId: string) {
  logger.info("Claiming drafting job", { jobId, userId });
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundError("Job");

  if (job.claimedById !== null) {
    throw new ConflictError("Job is already claimed by another drafter");
  }

  return prisma.job.update({
    where: { id: jobId, claimedById: null },
    data: { claimedById: userId, claimedAt: new Date() },
  });
}

export async function unclaimJob(jobId: string, userId: string) {
  logger.info("Unclaiming drafting job", { jobId, userId });
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundError("Job");
  if (job.claimedById !== userId) throw new AuthorizationError("You did not claim this job");

  return prisma.job.update({
    where: { id: jobId },
    data: { claimedById: null, claimedAt: null },
  });
}

export async function getDraftingThroughput() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const jobs = await prisma.job.findMany({
    where: {
      status: JobStatus.drafted,
      lastStatusChangedAt: { gte: today },
      lastStatusChangedById: { not: null },
      deletedAt: null,
    },
    select: {
      lastStatusChangedById: true,
      lastStatusChangedBy: { select: { id: true, name: true } },
    },
  });

  const byDrafter: Record<string, { id: string; name: string; count: number }> = {};
  for (const job of jobs) {
    if (job.lastStatusChangedById && job.lastStatusChangedBy) {
      const id = job.lastStatusChangedById;
      if (!byDrafter[id]) {
        byDrafter[id] = { id, name: job.lastStatusChangedBy.name, count: 0 };
      }
      byDrafter[id]!.count++;
    }
  }

  return {
    total: jobs.length,
    byDrafter: Object.values(byDrafter),
    date: today.toISOString().split("T")[0],
  };
}
