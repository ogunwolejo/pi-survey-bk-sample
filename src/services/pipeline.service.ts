import { prisma } from "../lib/prisma";
import { JobStatus } from "@prisma/client";
import { IssueFlagSeverity, IssueFlagStatus } from "@prisma/client";
import { pipelineLogger as logger } from "../lib/logger";

const PIPELINE_STATUSES: JobStatus[] = [
  JobStatus.field_complete,
  JobStatus.ready_for_drafting,
  JobStatus.drafting,
  JobStatus.drafted,
  JobStatus.pls_review,
  JobStatus.awaiting_corrections,
  JobStatus.ready_for_delivery,
];

export async function getPipelineBoard(team?: string, isAlta?: boolean) {
  logger.info("Loading pipeline board", { team, isAlta });
  const now = new Date();

  const where: Record<string, unknown> = {
    status: { in: PIPELINE_STATUSES },
    deletedAt: null,
  };
  if (team) where.team = team;
  if (typeof isAlta === "boolean") where.isAlta = isAlta;

  const jobs = await prisma.job.findMany({
    where,
    select: {
      id: true,
      jobNumber: true,
      status: true,
      internalDueDate: true,
      lastStatusChangedAt: true,
      isAlta: true,
      complexityTag: true,
      plsReviewRoundTrips: true,
      claimedById: true,
      claimedBy: { select: { id: true, name: true } },
      order: {
        select: {
          propertyAddressLine1: true,
          propertyCity: true,
          propertyState: true,
        },
      },
      issueFlags: {
        where: { status: IssueFlagStatus.open, severity: IssueFlagSeverity.critical },
        select: { id: true },
      },
    },
    orderBy: { internalDueDate: "asc" },
  });

  const columns: Record<string, typeof jobs> = {};
  for (const status of PIPELINE_STATUSES) {
    columns[status] = [];
  }

  for (const job of jobs) {
    const statusJobs = columns[job.status];
    if (statusJobs) {
      statusJobs.push(job);
    }
  }

  return PIPELINE_STATUSES.map((status) => ({
    status,
    jobs: (columns[status] ?? []).map((job) => {
      const daysInCurrentStatus = job.lastStatusChangedAt
        ? Math.floor((now.getTime() - job.lastStatusChangedAt.getTime()) / (1000 * 60 * 60 * 24))
        : null;

      const daysUntilDue = job.internalDueDate
        ? Math.ceil((job.internalDueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        : null;

      return {
        id: job.id,
        jobNumber: job.jobNumber,
        propertyAddress: [job.order.propertyAddressLine1, job.order.propertyCity, job.order.propertyState]
          .filter(Boolean)
          .join(", "),
        internalDueDate: job.internalDueDate,
        daysUntilDue,
        daysInCurrentStatus,
        claimedBy: job.claimedBy,
        hasOpenCriticalFlags: job.issueFlags.length > 0,
        isAlta: job.isAlta,
        complexityTag: job.complexityTag,
        plsReviewRoundTrips: job.plsReviewRoundTrips,
      };
    }),
  }));
}
