import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    systemSetting: { findUnique: vi.fn() },
    quote: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock("../../lib/transaction", () => ({
  withTransaction: vi.fn((fn: (tx: unknown) => unknown) => fn(mockTx)),
}));

vi.mock("../../lib/sequential-number", () => ({
  getNextSequence: vi.fn(),
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

import { create, list, send, accept, checkExpired } from "../quote.service";
import { prisma } from "../../lib/prisma";
import { getNextSequence } from "../../lib/sequential-number";
import { findOrCreateFromSubmission } from "../contact.service";
import { calculateDates } from "../date-calculation.service";

const mockPrisma = vi.mocked(prisma, true);
const mockGetNextSequence = vi.mocked(getNextSequence);
const mockFindOrCreate = vi.mocked(findOrCreateFromSubmission);
const mockCalcDates = vi.mocked(calculateDates);

const mockTx = {
  quote: {
    create: vi.fn(),
    update: vi.fn(),
  },
  quoteToken: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  entityAuditLog: {
    create: vi.fn(),
  },
  order: {
    create: vi.fn(),
  },
  client: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("create", () => {
  it("finds or creates contact and generates QUOTE-YYNNNN number", async () => {
    mockFindOrCreate.mockResolvedValue({ id: "contact-1" });
    mockGetNextSequence.mockResolvedValue("QUOTE-260001");
    mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
    mockTx.quote.create.mockResolvedValue({
      id: "q-1",
      quoteNumber: "QUOTE-260001",
      clientId: "contact-1",
      client: { id: "contact-1", firstName: "John", lastName: "Doe", email: "j@d.com" },
    });

    const result = await create({
      clientFirstName: "John",
      clientLastName: "Doe",
      clientEmail: "j@d.com",
      clientPhone: "555-1234",
      propertyAddressLine1: "123 Main St",
      propertyCity: "Chicago",
      propertyState: "IL",
      propertyZip: "60601",
      propertyCounty: "Cook",
      pin: "12-34-56",
      surveyType: "boundary",
      source: "internal",
    }, "user-1");

    expect(mockFindOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ email: "j@d.com", firstName: "John" })
    );
    expect(mockGetNextSequence).toHaveBeenCalledWith("QUOTE");
    expect(mockTx.quote.create).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("uses existing clientId when provided", async () => {
    mockGetNextSequence.mockResolvedValue("QUOTE-260002");
    mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
    mockTx.quote.create.mockResolvedValue({ id: "q-2", quoteNumber: "QUOTE-260002" });

    await create({
      clientId: "existing-client",
      propertyAddressLine1: "456 Oak Ave",
      propertyCity: "Evanston",
      propertyState: "IL",
      propertyZip: "60201",
      propertyCounty: "Cook",
      pin: "99-88-77",
      surveyType: "alta",
      source: "website",
    });

    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });

  it("throws ValidationError when no clientId and missing contact info", async () => {
    await expect(
      create({
        propertyAddressLine1: "123 Main",
        propertyCity: "Chicago",
        propertyState: "IL",
        propertyZip: "60601",
        propertyCounty: "Cook",
        pin: "11-22-33",
        surveyType: "boundary",
        source: "internal",
      })
    ).rejects.toThrow("clientId or contact info");
  });
});

describe("list", () => {
  it("returns paginated quotes", async () => {
    const mockQuotes = [
      { id: "q-1", quoteNumber: "QUOTE-260001" },
      { id: "q-2", quoteNumber: "QUOTE-260002" },
    ];
    mockPrisma.quote.findMany.mockResolvedValue(mockQuotes as never);
    mockPrisma.quote.count.mockResolvedValue(15);

    const result = await list({}, 1, 10);

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(15);
    expect(mockPrisma.quote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 10 })
    );
  });

  it("applies status filter", async () => {
    mockPrisma.quote.findMany.mockResolvedValue([]);
    mockPrisma.quote.count.mockResolvedValue(0);

    await list({ status: "sent" }, 1, 10);

    expect(mockPrisma.quote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "sent" }),
      })
    );
  });

  it("calculates skip correctly for page 3", async () => {
    mockPrisma.quote.findMany.mockResolvedValue([]);
    mockPrisma.quote.count.mockResolvedValue(0);

    await list({}, 3, 25);

    expect(mockPrisma.quote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 50, take: 25 })
    );
  });
});

describe("send", () => {
  it("creates a QuoteToken and updates status to sent", async () => {
    mockPrisma.quote.findUnique.mockResolvedValue({
      id: "q-1",
      quoteNumber: "QUOTE-260001",
      status: "new",
      deletedAt: null,
      client: { id: "c-1", email: "c@test.com" },
    } as never);

    mockTx.quoteToken.create.mockResolvedValue({ id: "tok-1", token: "uuid-token" });
    mockTx.quote.update.mockResolvedValue({ id: "q-1", status: "sent" });
    mockTx.entityAuditLog.create.mockResolvedValue({});

    const result = await send("q-1", "user-1") as { status: string; quoteToken: { id: string } };

    expect(mockTx.quoteToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quoteId: "q-1" }),
      })
    );
    expect(mockTx.quote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "sent" }),
      })
    );
    expect(result.quoteToken).toBeDefined();
  });

  it("throws when quote status is not sendable", async () => {
    mockPrisma.quote.findUnique.mockResolvedValue({
      id: "q-1",
      status: "accepted",
      deletedAt: null,
      client: { id: "c-1", email: "c@test.com" },
    } as never);

    await expect(send("q-1", "user-1")).rejects.toThrow("Cannot send quote");
  });
});

describe("accept", () => {
  it("creates order, marks quote accepted, and consumes token", async () => {
    mockTx.quoteToken.findUnique.mockResolvedValue({
      token: "valid-token",
      usedAt: null,
      expiresAt: new Date(Date.now() + 86400000),
      quote: {
        id: "q-1",
        clientId: "c-1",
        billingClientId: null,
        deletedAt: null,
        status: "sent",
        quoteNumber: "QUOTE-260001",
        propertyAddressLine1: "123 Main",
        propertyAddressLine2: null,
        propertyCity: "Chicago",
        propertyState: "IL",
        propertyZip: "60601",
        propertyCounty: "Cook",
        pin: "12-34-56",
        additionalPins: [],
        surveyType: "boundary",
        price: 1500,
        paymentTerms: "pre_pay",
        team: "residential",
        client: { id: "c-1" },
      },
    });

    mockGetNextSequence.mockResolvedValue("ORDER-260001");
    mockCalcDates.mockResolvedValue({
      dropDeadDate: new Date("2026-04-01"),
      internalClosingDate: new Date("2026-03-30"),
      dueDate: new Date("2026-03-25"),
      isRush: false,
      rushFeeApplicable: false,
    });

    mockTx.order.create.mockResolvedValue({ id: "ord-1", orderNumber: "ORDER-260001" });
    mockTx.quote.update.mockResolvedValue({ id: "q-1", status: "accepted" });
    mockTx.quoteToken.update.mockResolvedValue({});

    const result = await accept("valid-token", {}) as { order: { id: string } };

    expect(mockTx.order.create).toHaveBeenCalled();
    expect(mockTx.quote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "accepted" }),
      })
    );
    expect(mockTx.quoteToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ usedAt: expect.any(Date) }),
      })
    );
    expect(result.order.id).toBe("ord-1");
  });

  it("throws when token has already been used", async () => {
    mockTx.quoteToken.findUnique.mockResolvedValue({
      token: "used-token",
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      quote: { id: "q-1", status: "sent", deletedAt: null },
    });

    await expect(accept("used-token", {})).rejects.toThrow("already been used");
  });
});

describe("checkExpired", () => {
  it("batch-expires quotes past their expiryDate", async () => {
    mockPrisma.quote.updateMany.mockResolvedValue({ count: 3 } as never);

    const count = await checkExpired();

    expect(count).toBe(3);
    expect(mockPrisma.quote.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "expired" },
      })
    );
  });

  it("returns 0 when no quotes are expired", async () => {
    mockPrisma.quote.updateMany.mockResolvedValue({ count: 0 } as never);

    const count = await checkExpired();
    expect(count).toBe(0);
  });
});
