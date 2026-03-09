import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    holiday: { findMany: vi.fn() },
    companyContact: { findMany: vi.fn() },
  },
}));

vi.mock("../../lib/redis", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    setex: vi.fn(),
  },
  key: (...parts: string[]) => `pi:${parts.join(":")}`,
}));

vi.mock("../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { calculateDates } from "../date-calculation.service";
import { prisma } from "../../lib/prisma";
import { redis } from "../../lib/redis";

const mockPrisma = vi.mocked(prisma, true);
const mockRedis = vi.mocked(redis, true);

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.get.mockResolvedValue(null);
  mockRedis.setex.mockResolvedValue("OK");

  mockPrisma.holiday.findMany.mockResolvedValue([]);
  mockPrisma.companyContact.findMany.mockResolvedValue([]);
});

describe("calculateDates", () => {
  it("uses closingDate as dropDeadDate when provided", async () => {
    const closingDate = new Date("2026-03-20");
    const result = await calculateDates(closingDate, null, null, new Date("2026-03-02"));

    expect(result.dropDeadDate.toISOString().slice(0, 10)).toBe("2026-03-20");
  });

  it("falls back to requestedDate when closingDate is null", async () => {
    const requestedDate = new Date("2026-03-25");
    const result = await calculateDates(null, requestedDate, null, new Date("2026-03-02"));

    expect(result.dropDeadDate.toISOString().slice(0, 10)).toBe("2026-03-25");
  });

  it("calculates internalClosingDate as dropDeadDate minus 2 business days for standard client", async () => {
    // 2026-03-20 (Fri) -2 biz days → Wed 2026-03-18
    const closingDate = new Date("2026-03-20");
    const result = await calculateDates(closingDate, null, null, new Date("2026-03-02"));

    expect(result.internalClosingDate.toISOString().slice(0, 10)).toBe("2026-03-18");
  });

  it("calculates internalClosingDate as dropDeadDate minus 3 business days for ORT client", async () => {
    mockPrisma.companyContact.findMany.mockResolvedValue([
      { company: { isOrt: true } } as never,
    ]);

    // 2026-03-20 (Fri) -3 biz days → Tue 2026-03-17
    const closingDate = new Date("2026-03-20");
    const result = await calculateDates(closingDate, null, "client-ort", new Date("2026-03-02"));

    expect(result.internalClosingDate.toISOString().slice(0, 10)).toBe("2026-03-17");
  });

  it("detects rush when due within 7 business days of creation", async () => {
    // Due date is internalClosingDate - 3 biz days.
    // Use a closingDate only ~6 biz days from creation → definitely rush.
    const creationDate = new Date("2026-03-02"); // Monday
    const closingDate = new Date("2026-03-10"); // Tue (6 biz days)
    const result = await calculateDates(closingDate, null, null, creationDate);

    expect(result.isRush).toBe(true);
    expect(result.rushFeeApplicable).toBe(true);
  });

  it("is not rush when there is plenty of time", async () => {
    const creationDate = new Date("2026-03-02");
    const closingDate = new Date("2026-04-15"); // >30 biz days out
    const result = await calculateDates(closingDate, null, null, creationDate);

    expect(result.isRush).toBe(false);
    expect(result.rushFeeApplicable).toBe(false);
  });

  it("uses cached holidays from Redis when available", async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify(["2026-03-19"]));

    // 2026-03-20 (Fri) -2 biz days, but 03-19 is holiday → must skip to 03-17
    const closingDate = new Date("2026-03-20");
    const result = await calculateDates(closingDate, null, null, new Date("2026-03-02"));

    expect(result.internalClosingDate.toISOString().slice(0, 10)).toBe("2026-03-17");
    expect(mockPrisma.holiday.findMany).not.toHaveBeenCalled();
  });

  it("loads holidays from DB and caches to Redis on cache miss", async () => {
    mockRedis.get.mockResolvedValue(null);
    mockPrisma.holiday.findMany.mockResolvedValue([
      { date: new Date("2026-01-01") } as never,
    ]);

    await calculateDates(new Date("2026-03-20"), null, null, new Date("2026-03-02"));

    expect(mockPrisma.holiday.findMany).toHaveBeenCalled();
    expect(mockRedis.setex).toHaveBeenCalled();
  });

  it("continues gracefully when Redis read fails", async () => {
    mockRedis.get.mockRejectedValue(new Error("Redis down"));
    mockPrisma.holiday.findMany.mockResolvedValue([]);

    const result = await calculateDates(new Date("2026-03-20"), null, null, new Date("2026-03-02"));
    expect(result.dropDeadDate).toBeDefined();
  });
});
