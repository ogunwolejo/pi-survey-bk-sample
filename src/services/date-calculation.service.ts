import { prisma } from "../lib/prisma";
import { redis, key } from "../lib/redis";
import { subtractBusinessDays, addBusinessDays, datesToHolidaySet, type HolidaySet } from "../lib/date-utils";
import { generalLogger as logger } from "../lib/logger";

const HOLIDAYS_CACHE_KEY = key("holidays", "all");
const HOLIDAYS_TTL_SECONDS = 3600;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DateCalcResult {
  dropDeadDate: Date;
  internalClosingDate: Date;
  dueDate: Date;
  isRush: boolean;
  rushFeeApplicable: boolean;
}

// ─── loadHolidays ─────────────────────────────────────────────────────────────

async function loadHolidays(): Promise<HolidaySet> {
  try {
    const cached = await redis.get(HOLIDAYS_CACHE_KEY);
    if (cached) {
      const dates = JSON.parse(cached) as string[];
      return new Set(dates);
    }
  } catch {
    // Redis failure is non-fatal; fall through to DB
  }

  const rows = await prisma.holiday.findMany({ select: { date: true } });
  const holidaySet = datesToHolidaySet(rows.map((r) => r.date));
  const asArray = Array.from(holidaySet);

  try {
    await redis.setex(HOLIDAYS_CACHE_KEY, HOLIDAYS_TTL_SECONDS, JSON.stringify(asArray));
  } catch {
    // Redis write failure is non-fatal
  }

  return holidaySet;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function countBusinessDaysUntil(from: Date, to: Date, holidays: HolidaySet): number {
  let count = 0;
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);

  while (cursor < end) {
    const day = cursor.getDay();
    const dateStr = cursor.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !holidays.has(dateStr)) {
      count++;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

// ─── calculateDates ───────────────────────────────────────────────────────────

export async function calculateDates(
  closingDate?: Date | null,
  requestedDate?: Date | null,
  clientId?: string | null,
  orderCreationDate?: Date
): Promise<DateCalcResult> {
  const holidays = await loadHolidays();

  const today = orderCreationDate ? new Date(orderCreationDate) : new Date();
  today.setHours(0, 0, 0, 0);

  // dropDeadDate: closing date preferred → requested date → 14 business days from today
  const dropDeadDate: Date =
    closingDate ?? requestedDate ?? addBusinessDays(today, 14, holidays);

  // Determine if client belongs to an ORT company (tighter internal offset)
  let isOrt = false;
  if (clientId) {
    const companyContacts = await prisma.companyContact.findMany({
      where: { clientId },
      include: { company: { select: { isOrt: true } } },
    });
    isOrt = companyContacts.some((cc) => cc.company.isOrt);
  }

  const internalOffsetDays = isOrt ? 3 : 2;
  const internalClosingDate = subtractBusinessDays(dropDeadDate, internalOffsetDays, holidays);

  // dueDate = 3 calendar days before the user-provided date (dropDeadDate)
  const dueDate = new Date(dropDeadDate);
  dueDate.setDate(dueDate.getDate() - 3);

  const businessDaysUntilDue = countBusinessDaysUntil(today, dueDate, holidays);
  const isRush = businessDaysUntilDue <= 7;

  logger.debug("Date calculation result", {
    dropDeadDate,
    internalClosingDate,
    dueDate,
    isRush,
    isOrt,
    businessDaysUntilDue,
  });

  return {
    dropDeadDate,
    internalClosingDate,
    dueDate,
    isRush,
    rushFeeApplicable: isRush,
  };
}
