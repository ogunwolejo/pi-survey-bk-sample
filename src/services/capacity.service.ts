import { prisma } from "../lib/prisma";
import { JobStatus } from "@prisma/client";
import { pipelineLogger as logger } from "../lib/logger";

const DEFAULT_JOBS_PER_CREW_PER_DAY = 6;

export async function getCapacityData() {
  logger.info("Computing capacity data");
  const activeJobsPerCrewSetting = await prisma.systemSetting.findUnique({
    where: { key: "jobs_per_crew_per_day" },
  });
  const jobsPerCrewPerDay =
    (activeJobsPerCrewSetting?.value as { value: number } | null)?.value
    ?? DEFAULT_JOBS_PER_CREW_PER_DAY;

  const activeCrewCount = await prisma.crew.count({ where: { isActive: true } });
  const dailyCapacity = activeCrewCount * jobsPerCrewPerDay;

  const pipelineJobs = await prisma.job.groupBy({
    by: ["status"],
    where: {
      status: { notIn: [JobStatus.complete] },
      deletedAt: null,
    },
    _count: { id: true },
  });

  const statusCounts: Record<string, number> = {};
  let totalPipeline = 0;
  for (const row of pipelineJobs) {
    statusCounts[row.status] = row._count.id;
    totalPipeline += row._count.id;
  }

  const unassignedCount = statusCounts[JobStatus.unassigned] ?? 0;
  const projectedDaysOfWork = dailyCapacity > 0
    ? Math.ceil(unassignedCount / dailyCapacity)
    : null;

  const alertThresholdSetting = await prisma.systemSetting.findUnique({
    where: { key: "capacity_alert_threshold_days" },
  });
  const alertThresholdDays =
    (alertThresholdSetting?.value as { value: number } | null)?.value ?? 5;

  const alertLevel =
    projectedDaysOfWork === null ? "unknown"
    : projectedDaysOfWork > alertThresholdDays * 2 ? "critical"
    : projectedDaysOfWork > alertThresholdDays ? "warning"
    : "normal";

  return {
    activeCrewCount,
    dailyCapacity,
    jobsPerCrewPerDay,
    totalPipelineJobs: totalPipeline,
    statusCounts,
    unassignedCount,
    projectedDaysOfWork,
    alertLevel,
  };
}
