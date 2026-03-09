import { prisma } from "../lib/prisma";
import { ChatEntityType, JobStatus } from "@prisma/client";
import { ValidationError, NotFoundError } from "../lib/errors";
import { jobLogger as logger } from "../lib/logger";
import { canTransition } from "../lib/status-engine";
import { createSystemEvent as createChatSystemEvent } from "./chat.service";

export async function getReviewQueue(team?: string) {
  const where: Record<string, unknown> = { status: JobStatus.pls_review, deletedAt: null };
  if (team) where.team = team;

  return prisma.job.findMany({
    where,
    select: {
      id: true,
      jobNumber: true,
      status: true,
      internalDueDate: true,
      plsReviewRoundTrips: true,
      isAlta: true,
      team: true,
      assignedCrew: { select: { id: true, name: true } },
      order: { select: { propertyAddressLine1: true, propertyCity: true } },
    },
    orderBy: { internalDueDate: "asc" },
  });
}

export async function approveJob(jobId: string, plsUserId: string, notes?: string) {
  logger.info("PLS approving job", { jobId, plsUserId });
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundError("Job");
  if (!canTransition("job", job.status, JobStatus.ready_for_delivery)) {
    throw new ValidationError(`Cannot approve job in status ${job.status}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.pLSSignOff.create({
      data: { jobId, plsUserId, notes },
    });

    const result = await tx.job.update({
      where: { id: jobId },
      data: {
        status: JobStatus.ready_for_delivery,
        lastStatusChangedAt: new Date(),
        lastStatusChangedById: plsUserId,
      },
    });

    return result;
  });

  await createChatSystemEvent({
    entityType: ChatEntityType.job,
    entityId: jobId,
    eventType: "pls_approve",
    content: `✅ PLS approved — job moved to Ready for Delivery${notes ? `: ${notes}` : ""}`,
    metadata: { action: "pls_approve" },
    userId: plsUserId,
  });

  return updated;
}

export async function requestCorrections(
  jobId: string,
  plsUserId: string,
  correctionNotes: string
) {
  logger.info("PLS requesting corrections", { jobId, plsUserId });
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundError("Job");
  if (!canTransition("job", job.status, JobStatus.awaiting_corrections)) {
    throw new ValidationError(`Cannot request corrections for job in status ${job.status}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.job.update({
      where: { id: jobId },
      data: {
        status: JobStatus.awaiting_corrections,
        lastStatusChangedAt: new Date(),
        lastStatusChangedById: plsUserId,
        plsReviewRoundTrips: { increment: 1 },
      },
    });

    return result;
  });

  await createChatSystemEvent({
    entityType: ChatEntityType.job,
    entityId: jobId,
    eventType: "pls_request_corrections",
    content: `🔄 Corrections requested: ${correctionNotes}`,
    metadata: { action: "pls_request_corrections", correctionNotes },
    userId: plsUserId,
  });

  return updated;
}
