import { Prisma, InvoiceStatus, type SyncStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { withTransaction } from "../lib/transaction";
import { canTransition } from "../lib/status-engine";
import { getNextSequence } from "../lib/sequential-number";
import { NotFoundError, ValidationError } from "../lib/errors";
import { invoiceLogger as logger } from "../lib/logger";

const DEFAULT_RUSH_FEE_RATE = 0.15;
const PAYMENT_DUE_DAYS = 30;

export interface InvoiceFilters {
  status?: string;
  clientId?: string;
  orderId?: string;
  dateFrom?: string;
  dateTo?: string;
  syncStatus?: string;
}

type InvoiceStatusResult = InvoiceStatus;

export interface InvoiceStatusInput {
  totalAmount: number | string | { toNumber: () => number };
  amountPaid: number | string | { toNumber: () => number };
  dueDate: Date;
}

function toNumber(val: number | string | { toNumber: () => number }): number {
  if (typeof val === "object" && "toNumber" in val) return val.toNumber();
  return Number(val);
}

export function calculateStatus(invoice: InvoiceStatusInput): InvoiceStatusResult {
  const total = toNumber(invoice.totalAmount);
  const paid = toNumber(invoice.amountPaid);

  if (paid >= total && total > 0) return InvoiceStatus.paid;
  if (paid > 0 && paid < total) {
    return invoice.dueDate < new Date() ? InvoiceStatus.overdue : InvoiceStatus.partial;
  }
  if (invoice.dueDate < new Date()) return InvoiceStatus.overdue;
  return InvoiceStatus.sent;
}

export async function generateFromOrder(
  orderId: string,
  createdBy?: string
): Promise<unknown> {
  logger.info("Generating invoice from order", { orderId, createdBy });
  const order = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null },
  });
  if (!order) {
    logger.warn("Invoice generation failed — order not found", { orderId });
    throw new NotFoundError("Order not found");
  }

  const existing = await prisma.invoice.findFirst({ where: { orderId } });
  if (existing) {
    logger.warn("Invoice generation failed — invoice already exists", { orderId, existingInvoiceId: existing.id });
    throw new ValidationError("An invoice already exists for this order");
  }

  const rushSetting = await prisma.systemSetting.findUnique({ where: { key: "rush_fee" } });
  const rushFeeRate =
    rushSetting !== null && typeof rushSetting.value === "number"
      ? rushSetting.value
      : DEFAULT_RUSH_FEE_RATE;

  const invoiceNumber = await getNextSequence("INV");
  const orderPrice = Number(order.price);

  const lineItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    sortOrder: number;
  }> = [
    {
      description: `Survey Service Fee — ${(order.surveyType ?? "boundary").replace(/_/g, " ")} Survey`,
      quantity: 1,
      unitPrice: orderPrice,
      amount: orderPrice,
      sortOrder: 1,
    },
  ];

  if (order.isRush && !order.rushFeeWaived) {
    const rushFee = Math.round(orderPrice * rushFeeRate * 100) / 100;
    lineItems.push({
      description: "Rush Fee",
      quantity: 1,
      unitPrice: rushFee,
      amount: rushFee,
      sortOrder: 2,
    });
  }

  const subtotal = lineItems.reduce((sum, li) => sum + li.amount, 0);
  const totalAmount = Math.round(subtotal * 100) / 100;

  const invoiceDate = new Date();
  const dueDate = new Date(invoiceDate);
  dueDate.setDate(dueDate.getDate() + PAYMENT_DUE_DAYS);

  const invoice = await withTransaction(async (tx) => {
    return tx.invoice.create({
      data: {
        invoiceNumber,
        orderId,
        clientId: order.clientId!,
        status: InvoiceStatus.draft,
        invoiceDate,
        dueDate,
        subtotal,
        taxRate: 0,
        taxAmount: 0,
        discountAmount: 0,
        creditApplied: 0,
        totalAmount,
        amountPaid: 0,
        balanceDue: totalAmount,
        taxExempt: false,
        createdBy,
        invoiceLineItems: { create: lineItems },
      },
      include: { invoiceLineItems: { orderBy: { sortOrder: "asc" } } },
    });
  });

  logger.info("Invoice generated from order", {
    invoiceId: invoice.id,
    invoiceNumber,
    orderId,
  });
  return invoice;
}

export async function list(
  filters: InvoiceFilters,
  page: number,
  limit: number
): Promise<{ data: unknown[]; total: number; page: number; limit: number }> {
  logger.info("Listing invoices", { page, limit, filters });
  const where: Prisma.InvoiceWhereInput = {
    ...(filters.status ? { status: filters.status as InvoiceStatus } : {}),
    ...(filters.clientId ? { clientId: filters.clientId } : {}),
    ...(filters.orderId ? { orderId: filters.orderId } : {}),
    ...(filters.syncStatus ? { syncStatus: filters.syncStatus as SyncStatus } : {}),
    ...(filters.dateFrom ?? filters.dateTo
      ? {
          invoiceDate: {
            ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
            ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
          },
        }
      : {}),
  };

  const [total, invoices] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, email: true } },
        order: { select: { id: true, orderNumber: true } },
      },
    }),
  ]);

  return { data: invoices, total, page, limit };
}

export async function getById(id: string): Promise<unknown> {
  logger.info("Getting invoice by ID", { invoiceId: id });
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, firstName: true, lastName: true, email: true } },
      order: { select: { id: true, orderNumber: true, surveyType: true } },
      invoiceLineItems: { orderBy: { sortOrder: "asc" } },
      payments: { orderBy: { paymentDate: "desc" } },
      credits: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!invoice) {
    logger.warn("Invoice not found", { invoiceId: id });
    throw new NotFoundError("Invoice not found");
  }
  logger.info("Invoice retrieved", { invoiceId: id, invoiceNumber: invoice.invoiceNumber, status: invoice.status });
  return invoice;
}

export async function transitionStatus(
  id: string,
  toStatus: InvoiceStatus,
  userId?: string
): Promise<unknown> {
  logger.info("Transitioning invoice status", { invoiceId: id, toStatus, userId });
  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) {
    logger.warn("Invoice transition failed — not found", { invoiceId: id });
    throw new NotFoundError("Invoice not found");
  }

  if (!canTransition("invoice", invoice.status, toStatus)) {
    logger.warn("Invoice transition failed — invalid transition", { invoiceId: id, fromStatus: invoice.status, toStatus });
    throw new ValidationError(
      `Cannot transition invoice from '${invoice.status}' to '${toStatus}'`
    );
  }

  const updated = await prisma.invoice.update({
    where: { id },
    data: {
      status: toStatus,
      updatedBy: userId,
    },
  });

  logger.info("Invoice status transitioned", { invoiceId: id, from: invoice.status, to: toStatus });
  return updated;
}
