import { Router } from "express";
import { z } from "zod";
import { InvoiceStatus, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { withTransaction } from "../lib/transaction";
import { canTransition } from "../lib/status-engine";
import { getNextSequence } from "../lib/sequential-number";
import { invoiceLogger as logger } from "../lib/logger";
import { sendSuccess, sendPaginated, sendError } from "../lib/response";
import { NotFoundError, ValidationError } from "../lib/errors";
import { requireAuth } from "../middleware/auth.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z
    .enum(["draft", "sent", "paid", "partial", "overdue", "cancelled", "refunded"])
    .optional(),
  client_id: z.string().optional(),
  order_id: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  sync_status: z.enum(["pending", "synced", "failed"]).optional(),
});

const createInvoiceSchema = z.object({
  orderId: z.string().min(1),
  notes: z.string().optional(),
  taxRate: z.number().min(0).max(1).default(0),
  taxExempt: z.boolean().default(false),
  discountAmount: z.number().min(0).default(0),
});

const statusUpdateSchema = z.object({
  status: z.enum(["draft", "sent", "paid", "partial", "overdue", "cancelled", "refunded"]),
  notes: z.string().optional(),
});

const recordPaymentSchema = z.object({
  amount: z.number().positive(),
  paymentMethod: z.enum(["credit_card", "ach", "check", "cash", "other"]),
  paymentDate: z.string().min(1),
  transactionId: z.string().optional(),
  referenceNumber: z.string().optional(),
  notes: z.string().optional(),
});

const applyCreditSchema = z.object({
  amount: z.number().positive(),
  reason: z.string().min(1),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RUSH_FEE_RATE = 0.15;
const SHIPPING_FEE = 25.0;

function recalculateInvoiceStatus(totalAmount: number, amountPaid: number): InvoiceStatus {
  if (amountPaid <= 0) return InvoiceStatus.sent;
  if (amountPaid >= totalAmount) return InvoiceStatus.paid;
  return InvoiceStatus.partial;
}

// ─── GET /summary ─────────────────────────────────────────────────────────────

router.get("/summary", requireAuth, async (_req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const [outstanding, paidThisMonth, overdueInvoices, partialInvoices] = await Promise.all([
      prisma.invoice.aggregate({
        _sum: { balanceDue: true },
        where: { status: { in: [InvoiceStatus.sent, InvoiceStatus.partial, InvoiceStatus.overdue] } },
      }),
      prisma.invoice.aggregate({
        _sum: { amountPaid: true },
        where: {
          status: InvoiceStatus.paid,
          updatedAt: { gte: startOfMonth, lte: endOfMonth },
        },
      }),
      prisma.invoice.aggregate({
        _count: { id: true },
        _sum: { balanceDue: true },
        where: { status: InvoiceStatus.overdue },
      }),
      prisma.invoice.count({ where: { status: InvoiceStatus.partial } }),
    ]);

    sendSuccess(res, {
      total_outstanding: outstanding._sum.balanceDue ?? 0,
      paid_this_month: paidThisMonth._sum.amountPaid ?? 0,
      overdue_count: overdueInvoices._count.id,
      overdue_amount: overdueInvoices._sum.balanceDue ?? 0,
      partial_count: partialInvoices,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get("/", requireAuth, validateQuery(listQuerySchema), async (req, res) => {
  try {
    const q = req.query as unknown as z.infer<typeof listQuerySchema>;

    const where: Prisma.InvoiceWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.client_id ? { clientId: q.client_id } : {}),
      ...(q.order_id ? { orderId: q.order_id } : {}),
      ...(q.sync_status ? { syncStatus: q.sync_status } : {}),
      ...(q.date_from || q.date_to
        ? {
            invoiceDate: {
              ...(q.date_from ? { gte: new Date(q.date_from) } : {}),
              ...(q.date_to ? { lte: new Date(q.date_to) } : {}),
            },
          }
        : {}),
    };

    const [total, invoices] = await Promise.all([
      prisma.invoice.count({ where }),
      prisma.invoice.findMany({
        where,
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        orderBy: { createdAt: "desc" },
        include: {
          client: { select: { id: true, firstName: true, lastName: true, email: true } },
          order: { select: { id: true, orderNumber: true } },
        },
      }),
    ]);

    sendPaginated(res, invoices, q.page, q.limit, total);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params["id"]! },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, email: true } },
        order: { select: { id: true, orderNumber: true, surveyType: true } },
        invoiceLineItems: { orderBy: { sortOrder: "asc" } },
        payments: { orderBy: { paymentDate: "desc" } },
        credits: { orderBy: { createdAt: "desc" } },
      },
    });

    if (!invoice) throw new NotFoundError("Invoice not found");
    sendSuccess(res, invoice);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST / ───────────────────────────────────────────────────────────────────

router.post("/", requireAuth, validateBody(createInvoiceSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof createInvoiceSchema>;

    const order = await prisma.order.findFirst({
      where: { id: body.orderId, deletedAt: null },
      include: {
        client: {
          include: { clientDeliveryPreferences: { select: { chargeForShipping: true } } },
        },
      },
    });
    if (!order) throw new NotFoundError("Order not found");

    const existingInvoice = await prisma.invoice.findFirst({ where: { orderId: body.orderId } });
    if (existingInvoice) {
      throw new ValidationError("An invoice already exists for this order");
    }

    const invoiceNumber = await getNextSequence("INV");
    const orderPrice = Number(order.price);

    const lineItems: Array<{ description: string; quantity: number; unitPrice: number; amount: number; sortOrder: number }> = [
      {
        description: "Survey Service Fee",
        quantity: 1,
        unitPrice: orderPrice,
        amount: orderPrice,
        sortOrder: 1,
      },
    ];

    if (order.isRush && !order.rushFeeWaived) {
      const rushFee = Math.round(orderPrice * RUSH_FEE_RATE * 100) / 100;
      lineItems.push({
        description: "Rush Fee",
        quantity: 1,
        unitPrice: rushFee,
        amount: rushFee,
        sortOrder: 2,
      });
    }

    const chargeShipping = order.client?.clientDeliveryPreferences?.chargeForShipping ?? false;
    if (chargeShipping) {
      lineItems.push({
        description: "Shipping & Handling",
        quantity: 1,
        unitPrice: SHIPPING_FEE,
        amount: SHIPPING_FEE,
        sortOrder: lineItems.length + 1,
      });
    }

    const subtotal = lineItems.reduce((sum, li) => sum + li.amount, 0);
    const taxAmount = body.taxExempt ? 0 : Math.round(subtotal * body.taxRate * 100) / 100;
    const totalAmount =
      Math.round((subtotal + taxAmount - body.discountAmount) * 100) / 100;

    const invoiceDate = new Date();
    const dueDate = new Date(invoiceDate);
    dueDate.setDate(dueDate.getDate() + 30);

    const invoice = await withTransaction(async (tx) => {
      return tx.invoice.create({
        data: {
          invoiceNumber,
          orderId: body.orderId,
          clientId: order.clientId!,
          status: InvoiceStatus.draft,
          invoiceDate,
          dueDate,
          subtotal,
          taxRate: body.taxRate,
          taxAmount,
          discountAmount: body.discountAmount,
          creditApplied: 0,
          totalAmount,
          amountPaid: 0,
          balanceDue: totalAmount,
          taxExempt: body.taxExempt,
          notes: body.notes,
          createdBy: req.user!.userId,
          invoiceLineItems: { create: lineItems },
        },
        include: { invoiceLineItems: { orderBy: { sortOrder: "asc" } } },
      });
    });

    logger.info("Invoice created", { invoiceId: invoice.id, invoiceNumber, orderId: body.orderId });
    sendSuccess(res, invoice, 201);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── PUT /:id/status ──────────────────────────────────────────────────────────

router.put("/:id/status", requireAuth, validateBody(statusUpdateSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof statusUpdateSchema>;

    const invoice = await prisma.invoice.findUnique({ where: { id: req.params["id"]! } });
    if (!invoice) throw new NotFoundError("Invoice not found");

    if (!canTransition("invoice", invoice.status, body.status)) {
      throw new ValidationError(
        `Cannot transition invoice from '${invoice.status}' to '${body.status}'`
      );
    }

    const updated = await prisma.invoice.update({
      where: { id: req.params["id"]! },
      data: {
        status: body.status,
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        updatedBy: req.user!.userId,
      },
    });

    logger.info("Invoice status updated", { invoiceId: updated.id, from: invoice.status, to: body.status });
    sendSuccess(res, updated);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /:id/payments ────────────────────────────────────────────────────────

router.get("/:id/payments", requireAuth, validateQuery(paginationSchema), async (req, res) => {
  try {
    const q = req.query as unknown as z.infer<typeof paginationSchema>;

    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params["id"]! },
      select: { id: true },
    });
    if (!invoice) throw new NotFoundError("Invoice not found");

    const [total, payments] = await Promise.all([
      prisma.payment.count({ where: { invoiceId: req.params["id"]! } }),
      prisma.payment.findMany({
        where: { invoiceId: req.params["id"]! },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        orderBy: { paymentDate: "desc" },
        include: {
          recordedByUser: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    sendPaginated(res, payments, q.page, q.limit, total);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /:id/payments ───────────────────────────────────────────────────────

router.post("/:id/payments", requireAuth, validateBody(recordPaymentSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof recordPaymentSchema>;

    const invoice = await prisma.invoice.findUnique({ where: { id: req.params["id"]! } });
    if (!invoice) throw new NotFoundError("Invoice not found");

    if (invoice.status === InvoiceStatus.cancelled || invoice.status === InvoiceStatus.refunded) {
      throw new ValidationError(`Cannot record payment on a ${invoice.status} invoice`);
    }

    const { getNextSequence } = await import("../lib/sequential-number");

    const result = await withTransaction(async (tx) => {
      const paymentNumber = await getNextSequence("PAY");
      const payment = await tx.payment.create({
        data: {
          paymentNumber,
          invoiceId: req.params["id"]!,
          amount: body.amount,
          paymentMethod: body.paymentMethod,
          paymentDate: new Date(body.paymentDate),
          paymentSource: "manual",
          transactionId: body.transactionId,
          notes: body.notes,
          recordedBy: req.user!.userId,
        },
      });

      const currentPaid = Number(invoice.amountPaid);
      const newAmountPaid = Math.round((currentPaid + body.amount) * 100) / 100;
      const totalAmount = Number(invoice.totalAmount);
      const newBalanceDue = Math.round((totalAmount - newAmountPaid) * 100) / 100;
      const newStatus = recalculateInvoiceStatus(totalAmount, newAmountPaid);

      const updatedInvoice = await tx.invoice.update({
        where: { id: req.params["id"]! },
        data: {
          amountPaid: newAmountPaid,
          balanceDue: Math.max(0, newBalanceDue),
          status: newStatus,
          updatedBy: req.user!.userId,
        },
      });

      return { payment, invoice: updatedInvoice };
    });

    logger.info("Payment recorded", {
      invoiceId: req.params["id"]!,
      amount: body.amount,
      paymentMethod: body.paymentMethod,
    });

    sendSuccess(res, result, 201);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /:id/credits ────────────────────────────────────────────────────────

router.post("/:id/credits", requireAuth, validateBody(applyCreditSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof applyCreditSchema>;

    const invoice = await prisma.invoice.findUnique({ where: { id: req.params["id"]! } });
    if (!invoice) throw new NotFoundError("Invoice not found");

    if (invoice.status === InvoiceStatus.cancelled || invoice.status === InvoiceStatus.refunded) {
      throw new ValidationError(`Cannot apply credit to a ${invoice.status} invoice`);
    }

    const result = await withTransaction(async (tx) => {
      const credit = await tx.credit.create({
        data: {
          clientId: invoice.clientId,
          invoiceId: req.params["id"]!,
          amount: body.amount,
          reason: body.reason,
          approvedBy: req.user!.userId,
          approvedAt: new Date(),
        },
      });

      const currentCredit = Number(invoice.creditApplied);
      const newCreditApplied = Math.round((currentCredit + body.amount) * 100) / 100;
      const totalAmount = Number(invoice.totalAmount);
      const newBalanceDue = Math.max(
        0,
        Math.round((totalAmount - Number(invoice.amountPaid) - newCreditApplied) * 100) / 100
      );

      const updatedInvoice = await tx.invoice.update({
        where: { id: req.params["id"]! },
        data: {
          creditApplied: newCreditApplied,
          balanceDue: newBalanceDue,
          status: newBalanceDue <= 0 ? InvoiceStatus.paid : invoice.status,
          updatedBy: req.user!.userId,
        },
      });

      return { credit, invoice: updatedInvoice };
    });

    logger.info("Credit applied to invoice", { invoiceId: req.params["id"]!, amount: body.amount, reason: body.reason });
    sendSuccess(res, result, 201);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
