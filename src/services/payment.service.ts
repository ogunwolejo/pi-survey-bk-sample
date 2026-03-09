import {
  type PaymentMethod,
  type PaymentSource,
  type PaymentType,
  type PaymentStatus,
  InvoiceStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import { withTransaction } from "../lib/transaction";
import { getNextSequence } from "../lib/sequential-number";
import { NotFoundError, ValidationError, AppError } from "../lib/errors";
import { paymentLogger as logger } from "../lib/logger";

const CREDIT_CARD_FEE_RATE = 0.03;

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface CreatePaymentInput {
  orderId: string;
  jobId?: string | null;
  invoiceId?: string | null;
  quoteId?: string | null;
  amount: number;
  baseAmount?: number;
  taxAmount?: number;
  processingFee?: number;
  convenienceFee?: number;
  paymentMethod: PaymentMethod;
  cardBrand?: string;
  cardLastFour?: string;
  checkNumber?: string;
  bankName?: string;
  transactionId?: string;
  quickbooksPaymentId?: string;
  paymentSource: PaymentSource;
  paymentType?: PaymentType;
  paymentDate?: Date;
  status?: PaymentStatus;
  notes?: string;
  recordedBy?: string;
}

export interface PaymentListQuery {
  page: number;
  limit: number;
  search?: string;
  paymentMethod?: string;
  status?: string;
  source?: string;
  dateFrom?: string;
  dateTo?: string;
  entityType?: string;
  sort?: string;
  order?: "asc" | "desc";
}

export interface RecordPaymentInput {
  amount: number;
  paymentMethod: "credit_card" | "ach" | "check" | "cash" | "other";
  paymentDate: string | Date;
  transactionId?: string;
  referenceNumber?: string;
  notes?: string;
}

export interface PaymentSummaryMetrics {
  totalCollectedThisMonth: number;
  totalOutstandingBalance: number;
  paymentsThisWeek: number;
  averagePaymentAmount: number;
}

// ─── Create Payment (Transactional) ──────────────────────────────────────────

export async function createPayment(input: CreatePaymentInput) {
  logger.info("Creating payment", { orderId: input.orderId, amount: input.amount });

  const paymentNumber = await getNextSequence("PAY");
  const creditCardFee =
    input.paymentMethod === "credit_card" && !input.convenienceFee
      ? Math.round(input.amount * CREDIT_CARD_FEE_RATE * 100) / 100
      : undefined;

  const result = await withTransaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, price: true, amountPaid: true, balanceRemaining: true },
    });
    if (!order) throw new NotFoundError("Order not found");

    const currentBalance = Number(order.balanceRemaining);
    if (currentBalance <= 0 && input.amount > 0) {
      throw new AppError("FULLY_PAID", "Order is fully paid — no balance remaining", 409);
    }

    const resolvedStatus = input.status ?? "completed";
    const isImmediate = resolvedStatus === "completed";

    const payment = await tx.payment.create({
      data: {
        paymentNumber,
        orderId: input.orderId,
        jobId: input.jobId ?? undefined,
        invoiceId: input.invoiceId ?? undefined,
        quoteId: input.quoteId ?? undefined,
        status: resolvedStatus,
        amount: input.amount,
        baseAmount: input.baseAmount,
        taxAmount: input.taxAmount,
        processingFee: input.processingFee,
        convenienceFee: input.convenienceFee,
        creditCardFee,
        paymentMethod: input.paymentMethod,
        cardBrand: input.cardBrand,
        cardLastFour: input.cardLastFour,
        checkNumber: input.checkNumber,
        bankName: input.bankName,
        transactionId: input.transactionId,
        quickbooksPaymentId: input.quickbooksPaymentId,
        paymentSource: input.paymentSource,
        paymentType: input.paymentType,
        paymentDate: input.paymentDate ?? new Date(),
        notes: input.notes,
        recordedBy: input.recordedBy,
        completedAt: isImmediate ? new Date() : undefined,
      },
    });

    if (resolvedStatus === "completed") {
      const price = Number(order.price ?? 0);
      const newAmountPaid = Number(order.amountPaid) + input.amount;
      const newBalance = Math.max(0, Math.round((price - newAmountPaid) * 100) / 100);

      await tx.order.update({
        where: { id: input.orderId },
        data: {
          amountPaid: Math.round(newAmountPaid * 100) / 100,
          balanceRemaining: newBalance,
        },
      });

      return {
        payment,
        amountPaid: Math.round(newAmountPaid * 100) / 100,
        balanceRemaining: newBalance,
        fullyPaid: newBalance <= 0,
      };
    }

    return {
      payment,
      amountPaid: Number(order.amountPaid),
      balanceRemaining: Number(order.balanceRemaining),
      fullyPaid: false,
    };
  }, "RepeatableRead");

  logger.info("Payment created", {
    paymentId: result.payment.id,
    paymentNumber,
    amount: input.amount,
    balanceRemaining: result.balanceRemaining,
  });

  return result;
}

// ─── Get Payment By ID ───────────────────────────────────────────────────────

export async function getPaymentById(id: string) {
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          quickbooksInvoiceId: true,
          status: true,
        },
      },
      quote: { select: { id: true, quoteNumber: true, status: true } },
      order: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          price: true,
          amountPaid: true,
          balanceRemaining: true,
        },
      },
      job: { select: { id: true, jobNumber: true, status: true } },
      recordedByUser: { select: { id: true, name: true, email: true } },
    },
  });

  if (!payment) throw new NotFoundError("Payment not found");

  let relatedPayments: unknown[] = [];
  if (payment.orderId) {
    relatedPayments = await prisma.payment.findMany({
      where: { orderId: payment.orderId, id: { not: payment.id } },
      orderBy: { paymentDate: "asc" },
      select: {
        id: true,
        paymentNumber: true,
        paymentDate: true,
        amount: true,
        paymentMethod: true,
        status: true,
        paymentType: true,
        invoice: { select: { invoiceNumber: true } },
      },
    });
  }

  const orderPrice = payment.order ? Number(payment.order.price ?? 0) : 0;
  const orderAmountPaid = payment.order ? Number(payment.order.amountPaid) : 0;
  const fullyPaid = payment.order
    ? Number(payment.order.balanceRemaining) <= 0 && orderPrice > 0
    : false;

  return {
    ...payment,
    relatedPayments,
    fullyPaid,
    orderTotalPaid: orderAmountPaid,
    orderPrice,
  };
}

// ─── List Payments (Paginated) ───────────────────────────────────────────────

export async function listPayments(query: PaymentListQuery) {
  const where: Prisma.PaymentWhereInput = {};

  if (query.paymentMethod) {
    where.paymentMethod = query.paymentMethod as PaymentMethod;
  }
  if (query.status) {
    const statuses = query.status.split(",") as PaymentStatus[];
    where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
  }
  if (query.source) {
    where.paymentSource = query.source as PaymentSource;
  }
  if (query.dateFrom || query.dateTo) {
    where.paymentDate = {
      ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
      ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
    };
  }
  if (query.entityType) {
    if (query.entityType === "quote") where.quoteId = { not: null };
    else if (query.entityType === "order") where.orderId = { not: null };
    else if (query.entityType === "job") where.jobId = { not: null };
  }
  if (query.search) {
    where.OR = [
      { paymentNumber: { contains: query.search, mode: "insensitive" } },
      { transactionId: { contains: query.search, mode: "insensitive" } },
      { order: { orderNumber: { contains: query.search, mode: "insensitive" } } },
      { quote: { quoteNumber: { contains: query.search, mode: "insensitive" } } },
      { job: { jobNumber: { contains: query.search, mode: "insensitive" } } },
    ];
  }

  const sortField = query.sort ?? "paymentDate";
  const sortDir = query.order ?? "desc";
  const orderByMap: Record<string, Prisma.PaymentOrderByWithRelationInput> = {
    payment_date: { paymentDate: sortDir },
    amount: { amount: sortDir },
    payment_number: { paymentNumber: sortDir },
  };
  const orderBy = orderByMap[sortField] ?? { paymentDate: "desc" };

  const [total, payments] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      orderBy,
      include: {
        invoice: { select: { id: true, invoiceNumber: true } },
        quote: { select: { id: true, quoteNumber: true } },
        order: {
          select: {
            id: true,
            orderNumber: true,
            balanceRemaining: true,
            client: { select: { firstName: true, lastName: true } },
          },
        },
        job: { select: { id: true, jobNumber: true } },
        recordedByUser: { select: { id: true, name: true } },
      },
    }),
  ]);

  const data = payments.map((p) => ({
    id: p.id,
    paymentNumber: p.paymentNumber,
    paymentDate: p.paymentDate,
    amount: p.amount,
    baseAmount: p.baseAmount,
    taxAmount: p.taxAmount,
    processingFee: p.processingFee,
    paymentMethod: p.paymentMethod,
    cardBrand: p.cardBrand,
    cardLastFour: p.cardLastFour,
    status: p.status,
    paymentSource: p.paymentSource,
    paymentType: p.paymentType,
    quoteNumber: p.quote?.quoteNumber ?? null,
    quoteId: p.quoteId,
    orderNumber: p.order?.orderNumber ?? null,
    orderId: p.orderId,
    jobNumber: p.job?.jobNumber ?? null,
    jobId: p.jobId,
    invoiceNumber: p.invoice?.invoiceNumber ?? null,
    invoiceId: p.invoiceId,
    balanceRemaining: p.order ? Number(p.order.balanceRemaining) : null,
    clientName: p.order?.client
      ? `${p.order.client.firstName} ${p.order.client.lastName}`
      : null,
    recordedBy: p.recordedByUser
      ? { id: p.recordedByUser.id, name: p.recordedByUser.name }
      : null,
    createdAt: p.createdAt,
  }));

  return { data, total };
}

// ─── Summary Metrics ─────────────────────────────────────────────────────────

export async function getPaymentSummaryMetrics(): Promise<PaymentSummaryMetrics> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const dayOfWeek = now.getDay();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - dayOfWeek);
  startOfWeek.setHours(0, 0, 0, 0);

  const [collectedThisMonth, outstandingBalance, paymentsThisWeek, avgPayment] =
    await Promise.all([
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: {
          status: "completed",
          paymentDate: { gte: startOfMonth, lte: endOfMonth },
        },
      }),
      prisma.order.aggregate({
        _sum: { balanceRemaining: true },
        where: { balanceRemaining: { gt: 0 } },
      }),
      prisma.payment.count({
        where: {
          status: "completed",
          paymentDate: { gte: startOfWeek },
        },
      }),
      prisma.payment.aggregate({
        _avg: { amount: true },
        where: { status: "completed" },
      }),
    ]);

  return {
    totalCollectedThisMonth: Number(collectedThisMonth._sum.amount ?? 0),
    totalOutstandingBalance: Number(outstandingBalance._sum.balanceRemaining ?? 0),
    paymentsThisWeek,
    averagePaymentAmount: Number(avgPayment._avg.amount ?? 0),
  };
}

// ─── Legacy: Record Manual Payment (invoice-centric, kept for backward compat)

function recalculateStatus(total: number, paid: number): InvoiceStatus {
  if (paid >= total && total > 0) return InvoiceStatus.paid;
  if (paid > 0 && paid < total) return InvoiceStatus.partial;
  return InvoiceStatus.sent;
}

export async function recordManualPayment(
  invoiceId: string,
  input: RecordPaymentInput,
  userId?: string,
): Promise<{ payment: unknown; invoice: unknown }> {
  logger.info("Recording manual payment", {
    invoiceId,
    amount: input.amount,
    paymentMethod: input.paymentMethod,
    userId,
  });
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) {
    logger.warn("Payment recording failed — invoice not found", { invoiceId });
    throw new NotFoundError("Invoice not found");
  }

  if (
    invoice.status === InvoiceStatus.cancelled ||
    invoice.status === InvoiceStatus.refunded
  ) {
    logger.warn("Payment recording failed — invalid invoice status", {
      invoiceId,
      status: invoice.status,
    });
    throw new ValidationError(
      `Cannot record payment on a ${invoice.status} invoice`,
    );
  }

  const creditCardFee =
    input.paymentMethod === "credit_card"
      ? Math.round(input.amount * CREDIT_CARD_FEE_RATE * 100) / 100
      : undefined;

  const notesParts: string[] = [];
  if (input.referenceNumber) notesParts.push(`Ref: ${input.referenceNumber}`);
  if (input.notes) notesParts.push(input.notes);
  const combinedNotes =
    notesParts.length > 0 ? notesParts.join(" — ") : undefined;

  const paymentNumber = await getNextSequence("PAY");

  const result = await withTransaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        paymentNumber,
        invoiceId,
        amount: input.amount,
        paymentMethod: input.paymentMethod as PaymentMethod,
        paymentDate:
          input.paymentDate instanceof Date
            ? input.paymentDate
            : new Date(input.paymentDate),
        paymentSource: "manual",
        transactionId: input.transactionId,
        creditCardFee,
        notes: combinedNotes,
        recordedBy: userId,
      },
      include: {
        recordedByUser: { select: { id: true, name: true, email: true } },
      },
    });

    const currentPaid = Number(invoice.amountPaid);
    const newAmountPaid =
      Math.round((currentPaid + input.amount) * 100) / 100;
    const totalAmount = Number(invoice.totalAmount);
    const newBalanceDue = Math.max(
      0,
      Math.round((totalAmount - newAmountPaid) * 100) / 100,
    );
    const newStatus = recalculateStatus(totalAmount, newAmountPaid);

    const updatedInvoice = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        amountPaid: newAmountPaid,
        balanceDue: newBalanceDue,
        status: newStatus,
        updatedBy: userId,
      },
    });

    return { payment, invoice: updatedInvoice };
  }, "RepeatableRead");

  logger.info("Manual payment recorded", {
    invoiceId,
    amount: input.amount,
    paymentMethod: input.paymentMethod,
  });

  return result;
}

export async function getSummaryMetrics() {
  return getPaymentSummaryMetrics();
}
