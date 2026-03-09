import { getSiteAccessQueue, type SiteAccessJobPayload } from "../workers/site-access.worker";
import { prisma } from "../lib/prisma";
import { jobLogger as logger } from "../lib/logger";
import { addBusinessDays, datesToHolidaySet } from "../lib/date-utils";

async function getHolidaySet() {
  const holidays = await prisma.holiday.findMany({ select: { date: true } });
  return datesToHolidaySet(holidays.map((h) => h.date));
}

/** Returns 8 AM CT on the business day before `fieldDate` */
async function getSendTime(fieldDate: Date): Promise<Date> {
  const holidays = await getHolidaySet();
  // Go back 1 business day from fieldDate
  const sendDate = addBusinessDays(
    new Date(fieldDate.getTime() - 86400000 * 2), // start from day before
    0,
    holidays
  );
  // Actually we want 1 business day before, so subtract:
  const dayBefore = new Date(fieldDate);
  dayBefore.setDate(dayBefore.getDate() - 1);
  // Keep subtracting until it's a business day
  const dayMs = 86400000;
  let candidate = new Date(fieldDate.getTime() - dayMs);
  const holidayStrings = await getHolidaySet();
  while (
    candidate.getDay() === 0 ||
    candidate.getDay() === 6 ||
    holidayStrings.has(candidate.toISOString().split("T")[0]!)
  ) {
    candidate = new Date(candidate.getTime() - dayMs);
  }

  // Set to 8 AM CT (UTC-6 in standard, UTC-5 in daylight — use UTC-6 conservatively)
  candidate.setUTCHours(14, 0, 0, 0); // 8 AM CT = 14:00 UTC (standard)
  return candidate;
}

export async function scheduleSiteAccessEmail(
  routeJobId: string,
  payload: SiteAccessJobPayload
): Promise<string | null> {
  try {
    const sendAt = await getSendTime(new Date(payload.fieldDate));
    const delay = Math.max(0, sendAt.getTime() - Date.now());

    const queue = getSiteAccessQueue();
    const job = await queue.add("send-site-access-email", payload, {
      delay,
      jobId: `site-access:${routeJobId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    });

    // Store the BullMQ job ID on the RouteJob for later cancellation
    await prisma.routeJob.update({
      where: { id: routeJobId },
      data: { siteContactName: payload.siteContactName },
    });

    logger.info("Site access email scheduled", {
      routeJobId,
      sendAt: sendAt.toISOString(),
      bullJobId: job.id,
    });

    return job.id ?? null;
  } catch (err) {
    logger.error("Failed to schedule site access email", { routeJobId, error: err });
    return null;
  }
}

export async function cancelSiteAccessEmail(routeJobId: string): Promise<void> {
  try {
    const queue = getSiteAccessQueue();
    await queue.remove(`site-access:${routeJobId}`);
    logger.info("Site access email cancelled", { routeJobId });
  } catch (err) {
    logger.warn("Failed to cancel site access email", { routeJobId, error: err });
  }
}

export async function rescheduleSiteAccessEmails(
  routeId: string,
  newFieldDate: Date
): Promise<void> {
  const routeJobs = await prisma.routeJob.findMany({
    where: { routeId },
    select: {
      id: true,
      siteContactName: true,
      siteContactEmail: true,
      siteContactPhone: true,
      job: {
        select: {
          id: true,
          jobNumber: true,
          order: {
            select: {
              propertyAddressLine1: true,
              propertyCity: true,
              propertyState: true,
            },
          },
        },
      },
    },
  });

  for (const rj of routeJobs) {
    await cancelSiteAccessEmail(rj.id);

    if (!rj.siteContactEmail) continue;

    const propertyAddress = rj.job.order
      ? `${rj.job.order.propertyAddressLine1}, ${rj.job.order.propertyCity}, ${rj.job.order.propertyState}`
      : "Address on file";

    await scheduleSiteAccessEmail(rj.id, {
      routeJobId: rj.id,
      jobId: rj.job.id,
      jobNumber: rj.job.jobNumber,
      propertyAddress,
      fieldDate: newFieldDate.toISOString(),
      visitWindowStart: "8:00 AM",
      visitWindowEnd: "5:00 PM",
      siteContactName: rj.siteContactName ?? "Site Contact",
      siteContactEmail: rj.siteContactEmail,
      siteContactPhone: rj.siteContactPhone ?? undefined,
    });
  }
}
