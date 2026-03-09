import { describe, it, expect } from "vitest";
import { addBusinessDays, subtractBusinessDays, datesToHolidaySet, type HolidaySet } from "../date-utils";

const NO_HOLIDAYS: HolidaySet = new Set();

describe("addBusinessDays", () => {
  it("adds business days skipping weekends", () => {
    // 2026-01-05 is Monday → +5 biz days → 2026-01-12 (Monday)
    const start = new Date("2026-01-05");
    const result = addBusinessDays(start, 5, NO_HOLIDAYS);
    expect(result.toISOString().slice(0, 10)).toBe("2026-01-12");
  });

  it("skips holidays in the set", () => {
    const holidays: HolidaySet = new Set(["2026-01-06"]);
    // 2026-01-05 (Mon) +1 → would be Tue 01-06 but that's a holiday → Wed 01-07
    const start = new Date("2026-01-05");
    const result = addBusinessDays(start, 1, holidays);
    expect(result.toISOString().slice(0, 10)).toBe("2026-01-07");
  });

  it("returns the same date when adding 0 days", () => {
    const start = new Date("2026-03-10");
    const result = addBusinessDays(start, 0, NO_HOLIDAYS);
    expect(result.toISOString().slice(0, 10)).toBe("2026-03-10");
  });

  it("handles month boundary crossing", () => {
    // 2026-01-29 (Thu) +2 → Fri 01-30, Mon 02-02
    const start = new Date("2026-01-29");
    const result = addBusinessDays(start, 2, NO_HOLIDAYS);
    expect(result.toISOString().slice(0, 10)).toBe("2026-02-02");
  });

  it("handles year boundary crossing", () => {
    // 2025-12-31 (Wed) +1 → Thu 2026-01-01
    const start = new Date("2025-12-31");
    const result = addBusinessDays(start, 1, NO_HOLIDAYS);
    expect(result.toISOString().slice(0, 10)).toBe("2026-01-01");
  });

  it("does not mutate the input date", () => {
    const start = new Date("2026-01-05");
    const originalTime = start.getTime();
    addBusinessDays(start, 3, NO_HOLIDAYS);
    expect(start.getTime()).toBe(originalTime);
  });
});

describe("subtractBusinessDays", () => {
  it("subtracts business days skipping weekends", () => {
    // 2026-01-12 (Mon) -5 → 2026-01-05 (Mon)
    const start = new Date("2026-01-12");
    const result = subtractBusinessDays(start, 5, NO_HOLIDAYS);
    expect(result.toISOString().slice(0, 10)).toBe("2026-01-05");
  });

  it("skips holidays when subtracting", () => {
    const holidays: HolidaySet = new Set(["2026-01-09"]);
    // 2026-01-12 (Mon) -1 → Fri 01-09 is holiday → Thu 01-08
    const start = new Date("2026-01-12");
    const result = subtractBusinessDays(start, 1, holidays);
    expect(result.toISOString().slice(0, 10)).toBe("2026-01-08");
  });

  it("returns the same date when subtracting 0 days", () => {
    const start = new Date("2026-06-15");
    const result = subtractBusinessDays(start, 0, NO_HOLIDAYS);
    expect(result.toISOString().slice(0, 10)).toBe("2026-06-15");
  });

  it("handles month boundary crossing backwards", () => {
    // 2026-02-02 (Mon) -2 → Fri 01-30, Thu 01-29
    const start = new Date("2026-02-02");
    const result = subtractBusinessDays(start, 2, NO_HOLIDAYS);
    expect(result.toISOString().slice(0, 10)).toBe("2026-01-29");
  });
});

describe("datesToHolidaySet", () => {
  it("converts an array of dates to a set of yyyy-MM-dd strings", () => {
    const dates = [new Date("2026-01-01"), new Date("2026-07-04"), new Date("2026-12-25")];
    const set = datesToHolidaySet(dates);

    expect(set.size).toBe(3);
    expect(set.has("2026-01-01")).toBe(true);
    expect(set.has("2026-07-04")).toBe(true);
    expect(set.has("2026-12-25")).toBe(true);
  });

  it("returns an empty set for an empty array", () => {
    const set = datesToHolidaySet([]);
    expect(set.size).toBe(0);
  });

  it("deduplicates identical dates", () => {
    const dates = [new Date("2026-01-01"), new Date("2026-01-01")];
    const set = datesToHolidaySet(dates);
    expect(set.size).toBe(1);
  });
});
