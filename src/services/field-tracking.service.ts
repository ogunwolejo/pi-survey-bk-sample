import { prisma } from "../lib/prisma";
import { pipelineLogger as logger } from "../lib/logger";

export async function getFieldTrackingData() {
  logger.info("Loading field tracking data");
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const crews = await prisma.crew.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      crewNumber: true,
      currentLat: true,
      currentLng: true,
      gpsUpdatedAt: true,
      routes: {
        where: {
          routeDate: today,
          status: "published",
        },
        select: {
          routeJobs: {
            select: {
              job: { select: { id: true, status: true, jobNumber: true } },
              sortOrder: true,
            },
            orderBy: { sortOrder: "asc" },
          },
        },
        take: 1,
      },
    },
  });

  const now = new Date();
  const idleThresholdMs = 30 * 60 * 1000; // 30 minutes

  const crewData = crews.map((crew) => {
    const todayRoute = crew.routes[0];
    const jobs = todayRoute?.routeJobs.map((rj) => rj.job) ?? [];
    const completed = jobs.filter((j) => j.status === "field_complete" || j.status === "ready_for_drafting").length;
    const isIdle = crew.gpsUpdatedAt
      ? now.getTime() - crew.gpsUpdatedAt.getTime() > idleThresholdMs
      : true;

    return {
      id: crew.id,
      name: crew.name,
      crewNumber: crew.crewNumber,
      currentLat: crew.currentLat,
      currentLng: crew.currentLng,
      gpsUpdatedAt: crew.gpsUpdatedAt,
      progress: { completed, total: jobs.length },
      isIdle,
      status: isIdle ? "idle" : "active",
    };
  });

  return { crews: crewData, asOf: now };
}
