import { prisma } from "../lib/prisma";
import { JobStatus } from "@prisma/client";
import { generalLogger as logger } from "../lib/logger";
import { subDays, subMonths, subQuarters } from "date-fns";

function getPeriodStart(period: string): Date {
  const now = new Date();
  if (period === "week") return subDays(now, 7);
  if (period === "quarter") return subQuarters(now, 1);
  return subMonths(now, 1); // default: month
}

export async function getMetrics(period: string, team?: string, isAlta?: boolean) {
  logger.info("Computing metrics", { period, team, isAlta });
  const since = getPeriodStart(period);

  const where: Record<string, unknown> = {
    status: JobStatus.complete,
    lastStatusChangedAt: { gte: since },
    deletedAt: null,
  };
  if (team) where.team = team;
  if (typeof isAlta === "boolean") where.isAlta = isAlta;

  const completedJobs = await prisma.job.findMany({
    where,
    select: {
      id: true,
      jobNumber: true,
      plsReviewRoundTrips: true,
      lastStatusChangedAt: true,
      lastStatusChangedById: true,
      lastStatusChangedBy: { select: { id: true, name: true } },
    },
  });

  const totalCompleted = completedJobs.length;
  const withCorrections = completedJobs.filter((j) => j.plsReviewRoundTrips > 0).length;
  const correctionRate = totalCompleted > 0
    ? Math.round((withCorrections / totalCompleted) * 100)
    : 0;

  const byDrafter: Record<string, { id: string; name: string; completed: number; withCorrections: number }> = {};
  for (const job of completedJobs) {
    if (job.lastStatusChangedById && job.lastStatusChangedBy) {
      const id = job.lastStatusChangedById;
      if (!byDrafter[id]) {
        byDrafter[id] = { id, name: job.lastStatusChangedBy.name, completed: 0, withCorrections: 0 };
      }
      byDrafter[id]!.completed++;
      if (job.plsReviewRoundTrips > 0) byDrafter[id]!.withCorrections++;
    }
  }

  return {
    period,
    since: since.toISOString(),
    totalCompleted,
    correctionRate,
    withCorrections,
    drafterStats: Object.values(byDrafter),
  };
}
