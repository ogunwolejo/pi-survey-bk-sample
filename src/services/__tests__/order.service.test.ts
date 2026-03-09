import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    order: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../../lib/transaction", () => ({
  withTransaction: vi.fn((fn: (tx: unknown) => unknown) => fn(mockTx)),
}));

vi.mock("../../lib/sequential-number", () => ({
  getNextSequence: vi.fn(),
}));

vi.mock("../../lib/status-engine", () => ({
  canTransition: vi.fn(),
}));

vi.mock("../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../contact.service", () => ({
  findOrCreateFromSubmission: vi.fn(),
}));

vi.mock("../date-calculation.service", () => ({
  calculateDates: vi.fn(),
}));

import { create, transitionStatus } from "../order.service";
import { prisma } from "../../lib/prisma";
import { getNextSequence } from "../../lib/sequential-number";
import { canTransition } from "../../lib/status-engine";
import { findOrCreateFromSubmission } from "../contact.service";
import { calculateDates } from "../date-calculation.service";

const mockPrisma = vi.mocked(prisma, true);
const mockGetNextSequence = vi.mocked(getNextSequence);
const mockCanTransition = vi.mocked(canTransition);
const mockFindOrCreate = vi.mocked(findOrCreateFromSubmission);
const mockCalcDates = vi.mocked(calculateDates);

const mockTx = {
  order: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  job: {
    create: vi.fn(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCalcDates.mockResolvedValue({
    dropDeadDate: new Date("2026-04-01"),
    internalClosingDate: new Date("2026-03-30"),
    dueDate: new Date("2026-03-25"),
    isRush: false,
    rushFeeApplicable: false,
  });
});

describe("create", () => {
  it("finds or creates contact, calculates dates, and generates ORDER-YYNNNN", async () => {
    mockFindOrCreate.mockResolvedValue({ id: "contact-1" });
    mockGetNextSequence.mockResolvedValue("ORDER-260001");
    mockTx.order.create.mockResolvedValue({
      id: "ord-1",
      orderNumber: "ORDER-260001",
      clientId: "contact-1",
      client: { id: "contact-1" },
    });

    const result = await create(
      {
        clientFirstName: "Jane",
        clientLastName: "Smith",
        clientEmail: "jane@example.com",
        clientPhone: "555-9999",
        propertyAddressLine1: "789 Elm St",
        propertyCity: "Naperville",
        propertyState: "IL",
        propertyZip: "60540",
        propertyCounty: "DuPage",
        pin: "44-55-66",
        surveyType: "boundary",
        price: 2000,
        paymentTerms: "pre_pay",
        source: "internal",
        team: "residential",
      },
      "user-1"
    );

    expect(mockFindOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ email: "jane@example.com" })
    );
    expect(mockGetNextSequence).toHaveBeenCalledWith("ORDER");
    expect(mockCalcDates).toHaveBeenCalled();
    expect(mockTx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderNumber: "ORDER-260001",
          status: "draft",
          dropDeadDate: expect.any(Date),
          isRush: false,
        }),
      })
    );
    expect(result).toHaveProperty("id", "ord-1");
  });

  it("uses existing clientId when provided", async () => {
    mockGetNextSequence.mockResolvedValue("ORDER-260002");
    mockTx.order.create.mockResolvedValue({ id: "ord-2", orderNumber: "ORDER-260002" });

    await create({
      clientId: "existing-client",
      propertyAddressLine1: "100 Test Blvd",
      propertyCity: "Chicago",
      propertyState: "IL",
      propertyZip: "60601",
      propertyCounty: "Cook",
      pin: "77-88-99",
      surveyType: "alta",
      price: 3000,
      paymentTerms: "fifty_fifty",
      source: "website",
      team: "residential",
    });

    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });

  it("throws ValidationError when no clientId and missing contact info", async () => {
    await expect(
      create({
        propertyAddressLine1: "100 Test",
        propertyCity: "Chicago",
        propertyState: "IL",
        propertyZip: "60601",
        propertyCounty: "Cook",
        pin: "11-22-33",
        surveyType: "boundary",
        price: 1000,
        paymentTerms: "pre_pay",
        source: "internal",
        team: "residential",
      })
    ).rejects.toThrow("clientId or contact info");
  });
});

describe("transitionStatus", () => {
  it("updates status on valid transition", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      status: "paid",
      deletedAt: null,
      team: "residential",
      internalNotes: null,
    } as never);
    mockCanTransition.mockReturnValue(true);
    mockPrisma.order.update.mockResolvedValue({
      id: "ord-1",
      status: "research_in_progress",
    } as never);

    const result = await transitionStatus("ord-1", "research_in_progress", undefined, "user-1");

    expect(mockCanTransition).toHaveBeenCalledWith("order", "paid", "research_in_progress");
    expect(mockPrisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "research_in_progress" }),
      })
    );
    expect(result).toBeDefined();
  });

  it("throws ValidationError on invalid transition", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      status: "draft",
      deletedAt: null,
      team: "residential",
      internalNotes: null,
    } as never);
    mockCanTransition.mockReturnValue(false);

    await expect(
      transitionStatus("ord-1", "research_in_progress")
    ).rejects.toThrow("Cannot transition order");
  });

  it("throws NotFoundError for non-existent order", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);

    await expect(
      transitionStatus("nonexistent", "paid")
    ).rejects.toThrow("not found");
  });

  it("creates a Job with JOB-YYNNNN when transitioning to ready_for_field", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      status: "research_complete",
      deletedAt: null,
      team: "residential",
      internalNotes: null,
    } as never);
    mockCanTransition.mockReturnValue(true);

    mockTx.order.findUnique.mockResolvedValue({
      team: "residential",
      internalNotes: null,
    });
    mockGetNextSequence.mockResolvedValue("JOB-260001");
    mockTx.job.create.mockResolvedValue({
      id: "job-1",
      jobNumber: "JOB-260001",
      orderId: "ord-1",
      status: "unassigned",
    });
    mockTx.order.update.mockResolvedValue({
      id: "ord-1",
      status: "ready_for_field",
    });

    const result = await transitionStatus("ord-1", "ready_for_field", undefined, "user-1") as {
      job: { id: string; jobNumber: string };
    };

    expect(mockGetNextSequence).toHaveBeenCalledWith("JOB");
    expect(mockTx.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          jobNumber: "JOB-260001",
          orderId: "ord-1",
          status: "unassigned",
        }),
      })
    );
    expect(result.job.jobNumber).toBe("JOB-260001");
  });

  it("emits socket event when transitioning to ready_for_field with io", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      status: "research_complete",
      deletedAt: null,
      team: "residential",
      internalNotes: null,
    } as never);
    mockCanTransition.mockReturnValue(true);
    mockTx.order.findUnique.mockResolvedValue({ team: "residential", internalNotes: null });
    mockGetNextSequence.mockResolvedValue("JOB-260002");
    mockTx.job.create.mockResolvedValue({ id: "job-2", jobNumber: "JOB-260002" });
    mockTx.order.update.mockResolvedValue({ id: "ord-1", status: "ready_for_field" });

    const mockIo = { emit: vi.fn() };
    await transitionStatus("ord-1", "ready_for_field", undefined, "user-1", mockIo);

    expect(mockIo.emit).toHaveBeenCalledWith(
      "dashboard:jobs",
      expect.objectContaining({ event: "job:created" })
    );
  });
});
