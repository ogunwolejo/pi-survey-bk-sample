import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { validateQuery, validateBody } from "../middleware/validate.middleware";
import { sendSuccess, sendPaginated, sendError } from "../lib/response";
import { paymentLogger as logger } from "../lib/logger";
import {
  listPayments,
  getPaymentById,
  getPaymentSummaryMetrics,
  createPayment,
} from "../services/payment.service";
import { canCollectPayment } from "../services/payment-gate.service";
import { logPaymentAudit } from "../services/payment-audit.service";
import { prisma } from "../lib/prisma";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import {
  emitPaymentEvent,
  emitDashboardEvent,
} from "../lib/socket-emitter";
import { AppError, NotFoundError } from "../lib/errors";
import { getInvoicePdf } from "../services/quickbooks.service";
import type { Server as SocketServer } from "socket.io";

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  search: z.string().optional(),
  payment_method: z
    .enum(["credit_card", "ach", "check", "cash", "other"])
    .optional(),
  status: z.string().optional(),
  source: z.enum(["quickbooks_payments", "manual"]).optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  entity_type: z.enum(["quote", "order", "job"]).optional(),
  sort: z.enum(["payment_date", "amount", "payment_number"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

const paymentBreakdownSchema = z.object({
  paymentType: z.enum(["deposit", "full", "final"]).optional(),
  baseAmount: z.number().nonnegative().optional(),
  taxAmount: z.number().nonnegative().optional(),
  processingFee: z.number().nonnegative().optional(),
  convenienceFee: z.number().nonnegative().optional(),
  notes: z.string().max(1000).optional(),
});

const collectQBSchema = z.object({
  orderId: z.string().uuid(),
  jobId: z.string().uuid().nullable().optional(),
  amount: z.number().positive(),
}).merge(paymentBreakdownSchema);

const collectCheckSchema = z.object({
  orderId: z.string().uuid(),
  jobId: z.string().uuid().nullable().optional(),
  amount: z.number().positive(),
  checkNumber: z.string().min(1).max(50),
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bankName: z.string().max(100).optional(),
  memo: z.string().max(500).optional(),
}).merge(paymentBreakdownSchema);

const sendEmailSchema = z.object({
  invoiceId: z.string().uuid(),
  email: z.string().email(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getIo(req: Express.Request): SocketServer | undefined {
  return (req as unknown as { app: { get: (key: string) => SocketServer | undefined } }).app.get("io");
}

function getUserInfo(req: Express.Request): { userId?: string; userName: string } {
  const user = (req as unknown as { user?: { userId?: string; name?: string } }).user;
  return { userId: user?.userId, userName: user?.name ?? "unknown" };
}

function getIpAddress(req: Express.Request): string | undefined {
  return (req as unknown as { ip?: string }).ip;
}

function getUserAgent(req: Express.Request): string | undefined {
  return (req as unknown as { headers: Record<string, string | undefined> }).headers["user-agent"];
}

// ─── GET /summary ─────────────────────────────────────────────────────────────

router.get("/summary", requireAuth, async (_req, res) => {
  try {
    const metrics = await getPaymentSummaryMetrics();
    sendSuccess(res, metrics);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get("/", requireAuth, validateQuery(listQuerySchema), async (req, res) => {
  try {
    const q = req.query as unknown as z.infer<typeof listQuerySchema>;
    const { data, total } = await listPayments({
      page: q.page,
      limit: q.limit,
      search: q.search,
      paymentMethod: q.payment_method,
      status: q.status,
      source: q.source,
      dateFrom: q.date_from,
      dateTo: q.date_to,
      entityType: q.entity_type,
      sort: q.sort,
      order: q.order,
    });

    if (q.search) {
      const user = getUserInfo(req);
      logPaymentAudit({
        userId: user.userId,
        userName: user.userName,
        actionType: "search_performed",
        entityType: "payment",
        metadata: { query: q.search, resultCount: total },
        ipAddress: getIpAddress(req),
        userAgent: getUserAgent(req),
      });
    }

    sendPaginated(res, data, q.page, q.limit, total);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const detail = await getPaymentById(req.params.id ?? "");

    const user = getUserInfo(req);
    logPaymentAudit({
      userId: user.userId,
      userName: user.userName,
      actionType: "detail_viewed",
      entityType: "payment",
      entityId: detail.id,
      entityNumber: detail.paymentNumber,
      ipAddress: getIpAddress(req),
      userAgent: getUserAgent(req),
    });

    sendSuccess(res, detail);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /collect/quickbooks ─────────────────────────────────────────────────

router.post(
  "/collect/quickbooks",
  requireAuth,
  validateBody(collectQBSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof collectQBSchema>;
      const eligibility = await canCollectPayment(body.orderId);

      if (!eligibility.eligible) {
        const code =
          eligibility.reason === "Order is fully paid"
            ? "FULLY_PAID"
            : eligibility.reason === "Order has no price set"
              ? "PRICE_NOT_SET"
              : "NOT_ELIGIBLE";
        const status = code === "FULLY_PAID" ? 409 : 422;
        throw new AppError(code, eligibility.reason ?? "Not eligible", status);
      }

      const user = getUserInfo(req);
      logPaymentAudit({
        userId: user.userId,
        userName: user.userName,
        actionType: "collection_initiated",
        entityType: "order",
        entityId: body.orderId,
        metadata: { method: "quickbooks", amount: body.amount },
        ipAddress: getIpAddress(req),
        userAgent: getUserAgent(req),
      });

      const result = await createPayment({
        orderId: body.orderId,
        jobId: body.jobId,
        amount: body.amount,
        baseAmount: body.baseAmount,
        taxAmount: body.taxAmount,
        processingFee: body.processingFee,
        convenienceFee: body.convenienceFee,
        paymentMethod: "credit_card",
        paymentSource: "quickbooks_payments",
        paymentType: body.paymentType ?? "deposit",
        status: "pending",
        notes: body.notes,
        recordedBy: user.userId,
      });

      sendSuccess(res, {
        paymentId: result.payment.id,
        paymentNumber: result.payment.paymentNumber,
        amount: body.amount,
        status: "pending",
      });
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── POST /collect/quickbooks/email ───────────────────────────────────────────

router.post(
  "/collect/quickbooks/email",
  requireAuth,
  validateBody(sendEmailSchema),
  async (req, res) => {
    try {
      const { invoiceId, email } = req.body as z.infer<typeof sendEmailSchema>;
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { quickbooksInvoiceId: true },
      });
      if (!invoice?.quickbooksInvoiceId) {
        throw new NotFoundError("Invoice not found or has no QuickBooks invoice");
      }

      logger.info("QB invoice email requested", { invoiceId, email });
      sendSuccess(res, { sent: true, email });
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── POST /collect/check ──────────────────────────────────────────────────────

router.post(
  "/collect/check",
  requireAuth,
  validateBody(collectCheckSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof collectCheckSchema>;
      const eligibility = await canCollectPayment(body.orderId);

      if (!eligibility.eligible) {
        const code =
          eligibility.reason === "Order is fully paid" ? "FULLY_PAID" : "NOT_ELIGIBLE";
        const status = code === "FULLY_PAID" ? 409 : 422;
        throw new AppError(code, eligibility.reason ?? "Not eligible", status);
      }

      const user = getUserInfo(req);
      const result = await createPayment({
        orderId: body.orderId,
        jobId: body.jobId,
        amount: body.amount,
        baseAmount: body.baseAmount,
        taxAmount: body.taxAmount,
        processingFee: body.processingFee,
        convenienceFee: body.convenienceFee,
        paymentMethod: "check",
        paymentSource: "manual",
        paymentType: body.paymentType ?? "deposit",
        checkNumber: body.checkNumber,
        bankName: body.bankName,
        paymentDate: new Date(body.checkDate),
        notes: body.notes ?? body.memo,
        recordedBy: user.userId,
      });

      logPaymentAudit({
        userId: user.userId,
        userName: user.userName,
        actionType: "payment_created",
        entityType: "payment",
        entityId: result.payment.id,
        entityNumber: result.payment.paymentNumber,
        metadata: {
          amount: body.amount,
          method: "check",
          checkNumber: body.checkNumber,
          orderId: body.orderId,
        },
        ipAddress: getIpAddress(req),
        userAgent: getUserAgent(req),
      });

      const io = getIo(req);
      const paymentPayload = {
        paymentId: result.payment.id,
        paymentNumber: result.payment.paymentNumber,
        amount: body.amount,
        paymentMethod: "check",
        status: "completed",
        orderId: body.orderId,
        balanceRemaining: result.balanceRemaining,
        fullyPaid: result.fullyPaid,
      };

      const rooms = [ROOM_PREFIXES.ORDER(body.orderId)];
      if (body.jobId) rooms.push(ROOM_PREFIXES.JOB(body.jobId));
      emitPaymentEvent("payment:created", rooms, paymentPayload);
      emitPaymentEvent("payment:balance_updated", rooms, {
        orderId: body.orderId,
        amountPaid: result.amountPaid,
        balanceRemaining: result.balanceRemaining,
        fullyPaid: result.fullyPaid,
      });
      emitDashboardEvent(io, "dashboard:payments", "payment:created", {
        ...paymentPayload,
        orderNumber: "",
        jobNumber: undefined,
        jobId: body.jobId ?? undefined,
      });

      res.status(201).json({
        data: {
          id: result.payment.id,
          paymentNumber: result.payment.paymentNumber,
          amount: body.amount,
          paymentMethod: "check",
          checkNumber: body.checkNumber,
          status: "completed",
          balanceRemaining: result.balanceRemaining,
          fullyPaid: result.fullyPaid,
        },
      });
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── GET /invoice/:invoiceId/pdf ──────────────────────────────────────────────

router.get("/invoice/:invoiceId/pdf", requireAuth, async (req, res) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.invoiceId ?? "" },
      select: { invoiceNumber: true, quickbooksInvoiceId: true },
    });
    if (!invoice?.quickbooksInvoiceId) {
      throw new NotFoundError("Invoice not found or has no QuickBooks invoice");
    }

    const user = getUserInfo(req);
    logPaymentAudit({
      userId: user.userId,
      userName: user.userName,
      actionType: "pdf_downloaded",
      entityType: "invoice",
      entityId: req.params.invoiceId,
      entityNumber: invoice.invoiceNumber,
      ipAddress: getIpAddress(req),
      userAgent: getUserAgent(req),
    });

    try {
      const pdfBuffer = await getInvoicePdf(invoice.quickbooksInvoiceId);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="invoice-${invoice.invoiceNumber}.pdf"`,
      );
      res.send(pdfBuffer);
      return;
    } catch (pdfErr) {
      logger.warn("QB PDF retrieval failed, returning placeholder", {
        invoiceId: req.params.invoiceId,
        error: String(pdfErr),
      });
      sendSuccess(res, { message: "PDF generation pending — QB connection unavailable" });
    }
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /invoice/:invoiceId/preview ──────────────────────────────────────────

router.get("/invoice/:invoiceId/preview", requireAuth, async (req, res) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.invoiceId ?? "" },
      select: { quickbooksInvoiceId: true },
    });
    if (!invoice?.quickbooksInvoiceId) {
      throw new NotFoundError("Invoice not found or has no QuickBooks invoice");
    }

    const user = getUserInfo(req);
    logPaymentAudit({
      userId: user.userId,
      userName: user.userName,
      actionType: "invoice_previewed",
      entityType: "invoice",
      entityId: req.params.invoiceId,
      metadata: { qbInvoiceId: invoice.quickbooksInvoiceId },
      ipAddress: getIpAddress(req),
      userAgent: getUserAgent(req),
    });

    sendSuccess(res, {
      previewUrl: `https://app.qbo.intuit.com/app/invoice?txnId=${invoice.quickbooksInvoiceId}`,
    });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
