import { addDays, subDays, isWeekend, format } from "date-fns";

export type HolidaySet = Set<string>;

export function addBusinessDays(date: Date, days: number, holidays: HolidaySet): Date {
  let result = new Date(date);
  let added = 0;
  while (added < days) {
    result = addDays(result, 1);
    if (!isWeekend(result) && !holidays.has(format(result, "yyyy-MM-dd"))) added++;
  }
  return result;
}

export function subtractBusinessDays(date: Date, days: number, holidays: HolidaySet): Date {
  let result = new Date(date);
  let subtracted = 0;
  while (subtracted < days) {
    result = subDays(result, 1);
    if (!isWeekend(result) && !holidays.has(format(result, "yyyy-MM-dd"))) subtracted++;
  }
  return result;
}

export function datesToHolidaySet(dates: Date[]): HolidaySet {
  return new Set(dates.map((d) => format(d, "yyyy-MM-dd")));
}
