import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { generalLogger as logger } from "../lib/logger";
import { subtractBusinessDays, datesToHolidaySet, type HolidaySet } from "../lib/date-utils";

const HOLIDAY_CACHE_KEY = "pi:holidays:set";
const HOLIDAY_CACHE_TTL_SECONDS = 86400; // 24 hours
const INTERNAL_DUE_DATE_OFFSET_DAYS = 3;

async function loadHolidaySet(): Promise<HolidaySet> {
  const cached = await redis.get(HOLIDAY_CACHE_KEY);
  if (cached) {
    const dates = JSON.parse(cached) as string[];
    return new Set(dates);
  }

  const holidays = await prisma.holiday.findMany({ select: { date: true } });
  const holidaySet = datesToHolidaySet(holidays.map((h) => h.date));

  await redis.setex(HOLIDAY_CACHE_KEY, HOLIDAY_CACHE_TTL_SECONDS, JSON.stringify([...holidaySet]));
  return holidaySet;
}

export async function invalidateHolidayCache(): Promise<void> {
  await redis.del(HOLIDAY_CACHE_KEY);
}

export async function calculateInternalDueDate(ownerSelectedDate: Date): Promise<Date> {
  const holidays = await loadHolidaySet();
  return subtractBusinessDays(ownerSelectedDate, INTERNAL_DUE_DATE_OFFSET_DAYS, holidays);
}

export async function recalculateJobInternalDueDate(jobId: string): Promise<Date | null> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { order: { select: { closingDate: true, requestedDate: true } } },
  });

  if (!job) return null;

  const ownerDate = job.order.closingDate ?? job.order.requestedDate;
  if (!ownerDate) return null;

  const internalDueDate = await calculateInternalDueDate(ownerDate);

  await prisma.job.update({
    where: { id: jobId },
    data: { internalDueDate },
  });

  return internalDueDate;
}
