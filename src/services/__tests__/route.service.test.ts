import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    job: { findMany: vi.fn() },
    routeJob: { findMany: vi.fn() },
    route: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../../lib/redis", () => ({
  redis: { get: vi.fn(), setex: vi.fn() },
}));

vi.mock("../../lib/logger", () => ({
  pipelineLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../env-store", () => ({
  envStore: { SENDGRID_API_KEY: undefined, SENDGRID_FROM_EMAIL: undefined, GOOGLE_MAPS_API_KEY: undefined },
}));

vi.mock("../site-access.service", () => ({
  scheduleSiteAccessEmail: vi.fn(),
  cancelSiteAccessEmail: vi.fn(),
  rescheduleSiteAccessEmails: vi.fn(),
}));

vi.mock("../email-templates", () => ({
  routePublishedNotificationHtml: vi.fn().mockReturnValue("<html></html>"),
  routeCancelledNotificationHtml: vi.fn().mockReturnValue("<html></html>"),
  routeReminderNotificationHtml: vi.fn().mockReturnValue("<html></html>"),
}));

const mockQueueAdd = vi.fn();
const mockQueueGetJob = vi.fn();

vi.mock("../../workers/route-notification.worker", () => ({
  getRouteNotificationQueue: () => ({
    add: mockQueueAdd,
    getJob: mockQueueGetJob,
  }),
}));

import { getCalendarCounts, getAvailableJobs, checkDoubleBooking, scheduleRouteNotification, cancelRouteNotification } from "../route.service";
import { prisma } from "../../lib/prisma";

const mockPrisma = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCalendarCounts", () => {
  it("returns empty object for a month with no available jobs", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    const result = await getCalendarCounts("crew-1", new Date("2026-03-01"), new Date("2026-03-31"));
    expect(result).toEqual({});
  });

  it("returns date-to-count map for month with multiple dates", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { date: "2026-03-15", count: 5 },
      { date: "2026-03-20", count: 2 },
    ]);
    const result = await getCalendarCounts("crew-1", new Date("2026-03-01"), new Date("2026-03-31"));
    expect(result).toEqual({ "2026-03-15": 5, "2026-03-20": 2 });
  });

  it("calls prisma.$queryRaw with correct parameters", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await getCalendarCounts("crew-abc", new Date("2026-04-01"), new Date("2026-04-30"));
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe("getAvailableJobs", () => {
  function makeDecimal(val: number) {
    return Object.assign(Object.create(null), { valueOf: () => val, toString: () => String(val), toNumber: () => val, [Symbol.toPrimitive]: () => val });
  }

  const mockJob = {
    id: "job-1",
    jobNumber: "J-1001",
    status: "assigned",
    propertyLat: makeDecimal(30.2672),
    propertyLng: makeDecimal(-97.7431),
    fieldDate: new Date("2026-03-15"),
    stakingRequired: false,
    isAlta: false,
    specialNotes: null,
    complexityTag: null,
    assignedCrew: { id: "crew-1", name: "Crew 1" },
    order: {
      propertyAddressLine1: "123 Main St",
      propertyAddressLine2: null,
      propertyCity: "Austin",
      propertyState: "TX",
      propertyZip: "78701",
      surveyType: "Boundary",
      orderNumber: "ORD-100",
    },
  };

  it("returns jobs filtered by crew and date", async () => {
    mockPrisma.job.findMany.mockResolvedValue([mockJob] as never);
    const result = await getAvailableJobs("crew-1", new Date("2026-03-15"));
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("job-1");
  });

  it("returns null distanceMiles when no reference point provided", async () => {
    mockPrisma.job.findMany.mockResolvedValue([mockJob] as never);
    const result = await getAvailableJobs("crew-1", new Date("2026-03-15"));
    expect(result[0]!.distanceMiles).toBeNull();
  });

  it("computes distance when refLat/refLng provided", async () => {
    mockPrisma.job.findMany.mockResolvedValue([mockJob] as never);
    const result = await getAvailableJobs("crew-1", new Date("2026-03-15"), 32.7767, -96.797);
    expect(result[0]!.distanceMiles).not.toBeNull();
    expect(result[0]!.distanceMiles!).toBeGreaterThan(100);
  });

  it("handles jobs with null coordinates by returning null distance", async () => {
    const noGpsJob = { ...mockJob, propertyLat: null, propertyLng: null };
    mockPrisma.job.findMany.mockResolvedValue([noGpsJob] as never);
    const result = await getAvailableJobs("crew-1", new Date("2026-03-15"), 30.0, -97.0);
    expect(result[0]!.distanceMiles).toBeNull();
  });

  it("sorts by distance ascending when refLat/refLng provided", async () => {
    const farJob = {
      ...mockJob,
      id: "job-far",
      propertyLat: makeDecimal(32.7767),
      propertyLng: makeDecimal(-96.797),
    };
    const nearJob = {
      ...mockJob,
      id: "job-near",
      propertyLat: makeDecimal(30.268),
      propertyLng: makeDecimal(-97.744),
    };
    mockPrisma.job.findMany.mockResolvedValue([farJob, nearJob] as never);
    const result = await getAvailableJobs("crew-1", new Date("2026-03-15"), 30.2672, -97.7431);
    expect(result[0]!.id).toBe("job-near");
    expect(result[1]!.id).toBe("job-far");
  });
});

describe("checkDoubleBooking", () => {
  it("returns empty array for non-conflicting jobs", async () => {
    mockPrisma.routeJob.findMany.mockResolvedValue([]);
    const result = await checkDoubleBooking(["job-1", "job-2"]);
    expect(result).toEqual([]);
  });

  it("returns conflicting job details", async () => {
    mockPrisma.routeJob.findMany.mockResolvedValue([
      { jobId: "job-1", routeId: "route-99" },
    ] as never);
    const result = await checkDoubleBooking(["job-1", "job-2"]);
    expect(result).toEqual([{ jobId: "job-1", existingRouteId: "route-99" }]);
  });

  it("returns only conflicting entries for mixed input", async () => {
    mockPrisma.routeJob.findMany.mockResolvedValue([
      { jobId: "job-2", routeId: "route-55" },
    ] as never);
    const result = await checkDoubleBooking(["job-1", "job-2", "job-3"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.jobId).toBe("job-2");
  });

  it("returns empty array for empty input", async () => {
    const result = await checkDoubleBooking([]);
    expect(result).toEqual([]);
  });
});

describe("scheduleRouteNotification", () => {
  const mockRoute = {
    id: "route-1",
    routeDate: new Date("2026-04-15"),
    totalDriveTimeMinutes: 45,
    notificationJobId: null,
    crew: {
      name: "Crew Alpha",
      members: [{ email: "a@test.com" }, { email: "b@test.com" }],
    },
    routeJobs: [
      {
        job: {
          jobNumber: "J-100",
          order: { propertyAddressLine1: "123 Main", propertyCity: "Austin", propertyState: "TX" },
        },
      },
    ],
  };

  it("schedules a BullMQ job with correct jobId key", async () => {
    mockPrisma.route.findUnique.mockResolvedValue(mockRoute as never);
    mockPrisma.route.update.mockResolvedValue(mockRoute as never);
    mockQueueAdd.mockResolvedValue({});

    await scheduleRouteNotification("route-1");

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const addArgs = mockQueueAdd.mock.calls[0]!;
    expect(addArgs[0]).toBe("send-crew-notification");
    expect(addArgs[2]?.jobId).toBe("route-notify:route-1");
  });

  it("stores notificationJobId on the Route record", async () => {
    mockPrisma.route.findUnique.mockResolvedValue(mockRoute as never);
    mockPrisma.route.update.mockResolvedValue(mockRoute as never);
    mockQueueAdd.mockResolvedValue({});

    await scheduleRouteNotification("route-1");

    expect(mockPrisma.route.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { notificationJobId: "route-notify:route-1" },
      })
    );
  });

  it("uses delay >= 0 (immediate if route is <24h away)", async () => {
    const nearRoute = { ...mockRoute, routeDate: new Date(Date.now() + 6 * 60 * 60 * 1000) };
    mockPrisma.route.findUnique.mockResolvedValue(nearRoute as never);
    mockPrisma.route.update.mockResolvedValue(nearRoute as never);
    mockQueueAdd.mockResolvedValue({});

    await scheduleRouteNotification("route-1");

    const addArgs = mockQueueAdd.mock.calls[0]!;
    expect(addArgs[2]?.delay).toBeGreaterThanOrEqual(0);
  });
});

describe("cancelRouteNotification", () => {
  it("removes the BullMQ job and clears notificationJobId", async () => {
    const mockRemove = vi.fn();
    mockPrisma.route.findUnique.mockResolvedValue({
      notificationJobId: "route-notify:route-1",
    } as never);
    mockQueueGetJob.mockResolvedValue({ remove: mockRemove });
    mockPrisma.route.update.mockResolvedValue({} as never);

    await cancelRouteNotification("route-1");

    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockPrisma.route.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { notificationJobId: null },
      })
    );
  });

  it("does nothing when no notificationJobId exists", async () => {
    mockPrisma.route.findUnique.mockResolvedValue({ notificationJobId: null } as never);

    await cancelRouteNotification("route-1");

    expect(mockQueueGetJob).not.toHaveBeenCalled();
  });

  it("handles missing BullMQ job gracefully (idempotent)", async () => {
    mockPrisma.route.findUnique.mockResolvedValue({
      notificationJobId: "route-notify:route-1",
    } as never);
    mockQueueGetJob.mockResolvedValue(null);
    mockPrisma.route.update.mockResolvedValue({} as never);

    await cancelRouteNotification("route-1");

    expect(mockPrisma.route.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { notificationJobId: null },
      })
    );
  });
});
