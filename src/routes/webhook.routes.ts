import crypto from "crypto";
import { Router, Request, Response } from "express";
import type { Server } from "socket.io";
import { InvoiceStatus, OrderStatus, QuoteStatus, type PaymentTerms, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { webhookLogger as logger } from "../lib/logger";
import { withTransaction } from "../lib/transaction";
import { getNextSequence } from "../lib/sequential-number";
import { emitDashboardEvent, emitPaymentEvent } from "../lib/socket-emitter";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { envStore } from "../env-store";
import { notifyHollyOrderCreated, notifyResearchLeader } from "../services/notification.service";
import { fireUnifiedEvent, CustomerIoEventsNames } from "../services/customerio.service";
import { tryTransitionToResearchQueued } from "../services/payment-gate.service";

// ---------------------------------------------------------------------------
// QuickBooks event payload shapes (loosely typed for webhook flexibility)
// ---------------------------------------------------------------------------
interface QBPaymentEvent {
  eventType: string;
  payload?: {
    Payment?: {
      Id?: string;
      TotalAmt?: number;
      PaymentMethod?: string;
      TransactionNum?: string;
      LinkedTxns?: Array<{ TxnId?: string; TxnType?: string }>;
    };
  };
}

interface SendGridEvent {
  event: string;
  email?: string;
  timestamp?: number;
  sg_message_id?: string;
  custom_args?: Record<string, string>;
}

export function createWebhookRouter(io: Server): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /quickbooks → QuickBooks webhook handler
  // -------------------------------------------------------------------------
  router.post("/quickbooks", async (req: Request, res: Response) => {
    res.status(200).json({ received: true });

    try {
      const signature = req.headers["x-intuit-signature"] as string | undefined;
      logger.info("[QB Webhook] Received", { signature: signature ?? "(none)", body: req.body });

      const verifierToken = envStore.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN;
      if (verifierToken) {
        if (!signature) {
          logger.warn("[QB Webhook] Missing x-intuit-signature, skipping event");
          return;
        }
        const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody
          ?? Buffer.from(JSON.stringify(req.body));
        const expectedSig = crypto
          .createHmac("sha256", verifierToken)
          .update(rawBody)
          .digest("base64");
        if (signature !== expectedSig) {
          logger.warn("[QB Webhook] Signature mismatch, skipping event", {
            expected: expectedSig.substring(0, 10) + "...",
            received: signature.substring(0, 10) + "...",
          });
          return;
        }
        logger.info("[QB Webhook] Signature verified");
      } else {
        logger.warn("[QB Webhook] QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN not configured, proceeding without verification");
      }

      const events: QBPaymentEvent[] = Array.isArray(req.body)
        ? (req.body as QBPaymentEvent[])
        : [req.body as QBPaymentEvent];

      for (const event of events) {
        const eventType = event.eventType ?? "";

        if (eventType === "payment.completed") {
          await handleQBPaymentCompleted(event, io);
        } else if (eventType === "payment.failed") {
          await handleQBPaymentFailed(event);
        } else if (eventType === "payment.refunded") {
          await handleQBPaymentRefunded(event);
        } else {
          logger.info("[QB Webhook] Unhandled event type", { eventType });
        }
      }
    } catch (err) {
      logger.error("[QB Webhook] Processing error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // -------------------------------------------------------------------------
  // POST /sendgrid → SendGrid delivery event handler
  // -------------------------------------------------------------------------
  router.post("/sendgrid", async (req: Request, res: Response) => {
    res.status(200).json({ received: true });

    try {
      const signature = req.headers["x-twilio-email-event-webhook-signature"] as string | undefined;
      logger.info("[SG Webhook] Received", { signature: signature ?? "(none)" });

      const events: SendGridEvent[] = Array.isArray(req.body)
        ? (req.body as SendGridEvent[])
        : [req.body as SendGridEvent];

      for (const event of events) {
        if (event.event === "delivered") {
          await handleSGDelivered(event);
        } else if (event.event === "bounce" || event.event === "bounced") {
          logger.warn("[SG Webhook] Email bounced", { email: event.email });
        } else {
          logger.info("[SG Webhook] Unhandled event", { event: event.event });
        }
      }
    } catch (err) {
      logger.error("[SG Webhook] Processing error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Handler: QuickBooks payment.completed
// ---------------------------------------------------------------------------
async function handleQBPaymentCompleted(event: QBPaymentEvent, io: Server): Promise<void> {
  const payment = event.payload?.Payment;
  if (!payment) {
    logger.warn("[QB Webhook] payment.completed missing Payment payload");
    return;
  }

  const transactionId = payment.TransactionNum ?? payment.Id;
  const qbInvoiceId = payment.LinkedTxns?.find((t) => t.TxnType === "Invoice")?.TxnId;

  if (!qbInvoiceId) {
    logger.warn("[QB Webhook] payment.completed: no linked Invoice found");
    return;
  }

  if (transactionId) {
    const existingPayment = await prisma.payment.findFirst({
      where: { transactionId },
    });
    if (existingPayment) {
      logger.info("[QB Webhook] Duplicate payment, skipping", { transactionId });
      return;
    }
  }

  const invoice = await prisma.invoice.findFirst({
    where: { quickbooksInvoiceId: qbInvoiceId },
    include: {
      invoiceLineItems: true,
    },
  });

  if (!invoice) {
    logger.warn("[QB Webhook] Invoice not found for QB id", { qbInvoiceId });
    return;
  }

  const amount = payment.TotalAmt ?? 0;
  const feeBreakdown = extractFeeBreakdown(invoice.invoiceLineItems, amount);

  if (invoice.quoteId) {
    await handleQuotePayment(invoice, feeBreakdown, transactionId, io);
  } else {
    await handleStandardPayment(invoice, amount, transactionId, io);
  }

  logger.info("[QB Webhook] Payment recorded", {
    invoiceId: invoice.id,
    amount,
    transactionId,
    quoteLinked: !!invoice.quoteId,
  });
}

// ---------------------------------------------------------------------------
// Standard payment (existing order-based invoices)
// ---------------------------------------------------------------------------
async function handleStandardPayment(
  invoice: { id: string; invoiceNumber: string; orderId: string | null; amountPaid: { toNumber: () => number }; balanceDue: { toNumber: () => number } },
  amount: number,
  transactionId: string | undefined,
  io: Server,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const pendingPayment = invoice.orderId
      ? await tx.payment.findFirst({
          where: { orderId: invoice.orderId, status: "pending", paymentSource: "quickbooks_payments" },
          orderBy: { createdAt: "desc" },
        })
      : null;

    if (pendingPayment) {
      await tx.payment.update({
        where: { id: pendingPayment.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          transactionId: transactionId ?? null,
          invoiceId: invoice.id,
          amount,
          paymentDate: new Date(),
        },
      });

      if (invoice.orderId) {
        const order = await tx.order.findUnique({
          where: { id: invoice.orderId },
          select: { price: true, amountPaid: true, balanceRemaining: true },
        });
        if (order) {
          const price = Number(order.price ?? 0);
          const newAmountPaid = Number(order.amountPaid) + amount;
          const newBalance = Math.max(0, Math.round((price - newAmountPaid) * 100) / 100);
          await tx.order.update({
            where: { id: invoice.orderId },
            data: { amountPaid: Math.round(newAmountPaid * 100) / 100, balanceRemaining: newBalance },
          });
        }
      }
    } else {
      const paymentNumber = await getNextSequence("PAY");
      await tx.payment.create({
        data: {
          paymentNumber,
          invoiceId: invoice.id,
          orderId: invoice.orderId,
          paymentDate: new Date(),
          amount,
          paymentMethod: "other",
          transactionId: transactionId ?? null,
          paymentSource: "quickbooks_payments",
          completedAt: new Date(),
          notes: `QuickBooks payment — Invoice ${invoice.invoiceNumber}`,
        },
      });
    }

    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: InvoiceStatus.paid,
        amountPaid: invoice.amountPaid.toNumber() + amount,
        balanceDue: Math.max(0, invoice.balanceDue.toNumber() - amount),
      },
    });
  });

  if (invoice.orderId) {
    const rooms = [ROOM_PREFIXES.ORDER(invoice.orderId)];
    emitPaymentEvent("payment:status_changed", rooms, {
      orderId: invoice.orderId,
      status: "completed",
      completedAt: new Date().toISOString(),
    });
  }

  io.emit("invoice:payment_received", {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    orderId: invoice.orderId,
    amount,
    transactionId,
  });

  io.emit("payment:received", {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    orderId: invoice.orderId,
    amount,
    transactionId,
  });

  if (invoice.orderId) {
    await advanceOrderOnPayment(invoice.orderId, io);
  }
}

async function advanceOrderOnPayment(
  orderId: string,
  io: Server,
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { client: true },
  });

  if (!order) {
    logger.warn("[QB Webhook] Order not found for payment advancement", { orderId });
    return;
  }

  if (order.status !== OrderStatus.pending_payment) {
    logger.info("[QB Webhook] Order not in pending_payment, skipping advancement", {
      orderId,
      currentStatus: order.status,
    });
    return;
  }

  const clientName = order.client
    ? `${order.client.firstName} ${order.client.lastName}`
    : "Client";

  fireUnifiedEvent({
    contactId: order.clientId ?? order.id,
    identifyAttributes: {
      email: order.client?.email ?? "",
      first_name: order.client?.firstName ?? "",
      last_name: order.client?.lastName ?? "",
    },
    unifiedEventName: CustomerIoEventsNames.PAYMENT_REMINDER_STOP,
    legacyEventName: CustomerIoEventsNames.ORDER_PAYMENT_REMINDER_STOP,
    attributes: {
      source_type: "order",
      source_id: order.id,
      source_number: order.orderNumber,
      client_name: clientName,
      client_email: order.client?.email ?? "",
      amount: String(Number(order.price)),
    },
  });

  const transitioned = await tryTransitionToResearchQueued(orderId, null, "QuickBooks Webhook", io);

  if (transitioned) {
    logger.info("[QB Webhook] Order advanced to research_queued after payment", {
      orderId,
      orderNumber: order.orderNumber,
    });
  } else {
    logger.info("[QB Webhook] Payment recorded but conditions not fully met for research_queued transition", {
      orderId,
      orderNumber: order.orderNumber,
    });
  }
}

// ---------------------------------------------------------------------------
// Quote-linked payment: creates Order from Quote on first payment
// ---------------------------------------------------------------------------
interface InvoiceWithQuote {
  id: string;
  invoiceNumber: string;
  quoteId: string | null;
  orderId: string | null;
  clientId: string;
  totalAmount: { toNumber: () => number };
  amountPaid: { toNumber: () => number };
  balanceDue: { toNumber: () => number };
}

async function handleQuotePayment(
  invoice: InvoiceWithQuote,
  feeBreakdown: FeeBreakdown,
  transactionId: string | undefined,
  io: Server,
): Promise<void> {
  const result = await withTransaction(async (tx) => {
    const quote = await tx.quote.findUnique({
      where: { id: invoice.quoteId! },
      include: { client: true },
    });

    if (!quote) {
      logger.error("[QB Webhook] Quote not found for invoice", {
        invoiceId: invoice.id,
        quoteId: invoice.quoteId,
      });
      return null;
    }

    const paymentMethod = feeBreakdown.processingFee > 0 ? "credit_card" as const : "ach" as const;
    const quotePrice = Number(quote.price);
    const paymentType = resolvePaymentType(feeBreakdown, quotePrice);

    const today = new Date();

    let order = await tx.order.findFirst({
      where: { quoteId: quote.id },
    });

    if (!order) {
      const orderNumber = await getNextSequence("ORDER");
      order = await tx.order.create({
        data: {
          orderNumber,
          quoteId: quote.id,
          clientId: quote.clientId,
          billingClientId: quote.billingClientId,
          status: OrderStatus.new,
          orderType: "standard",
          propertyAddressLine1: quote.propertyAddressLine1,
          propertyAddressLine2: quote.propertyAddressLine2,
          propertyCity: quote.propertyCity,
          propertyState: quote.propertyState,
          propertyZip: quote.propertyZip,
          propertyCounty: quote.propertyCounty,
          propertyType: quote.propertyType,
          pin: quote.pin,
          additionalPins: quote.additionalPins,
          surveyType: quote.surveyType!,
          price: quotePrice,
          paymentTerms: (quote.paymentTerms ?? "pre_pay") as PaymentTerms,
          closingDate: quote.closingDate,
          onsiteContactFirstName: quote.onsiteContactFirstName,
          onsiteContactLastName: quote.onsiteContactLastName,
          onsiteContactPhone: quote.onsiteContactPhone,
          lockedGates: quote.lockedGates,
          deliveryPreference: quote.deliveryPreference,
          legalDescription: quote.legalDescription,
          source: "quote_acceptance",
          priority: quote.priority,
          team: quote.team,
          referralSource: quote.referralSource,
          internalNotes: quote.internalNotes,
          dropDeadDate: today,
          internalClosingDate: today,
          dueDate: today,
          isRush: quote.rushFeeApplied,
          rushFeeWaived: quote.rushFeeWaived,
          rushFeeWaivedReason: quote.rushFeeWaivedReason,
        },
      });
    }

    const existingFullPayment = await tx.payment.findFirst({
      where: { orderId: order.id, paymentType: "full" },
    });
    if (existingFullPayment) {
      logger.warn("Full payment already exists for order, skipping duplicate", { orderId: order.id });
      return null;
    }

    const quotePaymentNumber = await getNextSequence("PAY");
    await tx.payment.create({
      data: {
        paymentNumber: quotePaymentNumber,
        invoiceId: invoice.id,
        quoteId: quote.id,
        orderId: order.id,
        paymentDate: today,
        amount: feeBreakdown.totalAmount,
        baseAmount: feeBreakdown.baseAmount,
        taxAmount: feeBreakdown.taxAmount,
        processingFee: feeBreakdown.processingFee,
        paymentMethod,
        paymentType,
        completedAt: today,
        transactionId: transactionId ?? null,
        paymentSource: "quickbooks_payments",
        notes: `QuickBooks payment for proposal ${quote.quoteNumber}`,
      },
    });

    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        orderId: order.id,
        status: InvoiceStatus.paid,
        amountPaid: invoice.amountPaid.toNumber() + feeBreakdown.totalAmount,
        balanceDue: Math.max(0, invoice.balanceDue.toNumber() - feeBreakdown.totalAmount),
      },
    });

    await tx.quote.update({
      where: { id: quote.id },
      data: { status: QuoteStatus.accepted },
    });

    await tx.quoteToken.updateMany({
      where: { quoteId: quote.id, tokenType: "proposal" },
      data: { usedAt: today },
    });

    return { order, quote };
  }, "Serializable");

  if (!result) return;

  emitDashboardEvent(io, "dashboard:quotes", "quote:updated", {
    quoteId: result.quote.id,
    status: QuoteStatus.accepted,
  });
  emitDashboardEvent(io, "dashboard:orders", "order:created", {
    orderId: result.order.id,
    orderNumber: result.order.orderNumber,
    status: OrderStatus.new,
  });

  // Fire-and-forget — notify Holly across all channels
  void notifyHollyOrderCreated(result.order, result.quote, io).catch((err) =>
    logger.error("[QB Webhook] notifyHollyOrderCreated failed", {
      error: err instanceof Error ? err.message : String(err),
      orderId: result.order.id,
    })
  );

  fireUnifiedEvent({
    contactId: result.quote.id,
    identifyAttributes: {
      email: result.quote.client.email,
      first_name: result.quote.client.firstName,
      last_name: result.quote.client.lastName,
    },
    unifiedEventName: CustomerIoEventsNames.PAYMENT_REMINDER_STOP,
    attributes: {
      source_type: "quote",
      source_id: result.quote.id,
      source_number: result.quote.quoteNumber,
      client_name: `${result.quote.client.firstName} ${result.quote.client.lastName}`,
      client_email: result.quote.client.email,
      amount: String(Number(result.quote.price)),
      order_number: result.order.orderNumber,
    },
  });

  const paymentAudit = await prisma.entityAuditLog.create({
    data: {
      entityType: "quote",
      entityId: result.quote.id,
      entityNumber: result.quote.quoteNumber,
      action: "updated",
      userName: "QuickBooks Webhook",
      changedAt: new Date(),
      changes: {
        amount: feeBreakdown.totalAmount,
        baseAmount: feeBreakdown.baseAmount,
        processingFee: feeBreakdown.processingFee,
        transactionId,
      } as Prisma.InputJsonValue,
      changeSummary: `Payment of $${feeBreakdown.totalAmount.toFixed(2)} received via QuickBooks`,
      source: "system",
    },
    include: { user: { select: { id: true, name: true } } },
  }).catch((err) => {
    logger.warn("Audit log for payment received failed", { err });
    return null;
  });

  if (paymentAudit) {
    io?.to(ROOM_PREFIXES.QUOTE(result.quote.id)).emit("quote:history:new", paymentAudit);
  }

  const orderAudit = await prisma.entityAuditLog.create({
    data: {
      entityType: "quote",
      entityId: result.quote.id,
      entityNumber: result.quote.quoteNumber,
      action: "created",
      userName: "QuickBooks Webhook",
      changedAt: new Date(),
      changes: {
        orderId: result.order.id,
        orderNumber: result.order.orderNumber,
      } as Prisma.InputJsonValue,
      changeSummary: `Order ${result.order.orderNumber} created from quote after payment`,
      source: "system",
    },
    include: { user: { select: { id: true, name: true } } },
  }).catch((err) => {
    logger.warn("Audit log for order creation failed", { err });
    return null;
  });

  if (orderAudit) {
    io?.to(ROOM_PREFIXES.QUOTE(result.quote.id)).emit("quote:history:new", orderAudit);
  }
}

// ---------------------------------------------------------------------------
// Resolve payment type from breakdown and quote price
// ---------------------------------------------------------------------------
function resolvePaymentType(
  breakdown: FeeBreakdown,
  quotePrice: number,
): "full" | "deposit" {
  if (breakdown.hasDiscount) return "full";
  return breakdown.baseAmount >= quotePrice ? "full" : "deposit";
}

// ---------------------------------------------------------------------------
// Fee breakdown extraction from invoice line items
// ---------------------------------------------------------------------------
interface FeeBreakdown {
  baseAmount: number;
  taxAmount: number;
  processingFee: number;
  discountAmount: number;
  hasDiscount: boolean;
  totalAmount: number;
}

function extractFeeBreakdown(
  lineItems: { description: string; amount: { toNumber: () => number } }[],
  totalAmount: number,
): FeeBreakdown {
  let processingFee = 0;
  let serviceAmount = 0;
  let discountAmount = 0;

  for (const item of lineItems) {
    const amt = item.amount.toNumber();
    if (/processing fee/i.test(item.description)) {
      processingFee += amt;
    } else if (/discount/i.test(item.description)) {
      discountAmount += Math.abs(amt);
    } else {
      serviceAmount += amt;
    }
  }

  const baseAmount = lineItems.length === 0
    ? totalAmount
    : serviceAmount - discountAmount;

  return {
    baseAmount,
    taxAmount: 0,
    processingFee,
    discountAmount,
    hasDiscount: discountAmount > 0,
    totalAmount,
  };
}

// ---------------------------------------------------------------------------
// Handler: QuickBooks payment.failed
// ---------------------------------------------------------------------------
async function handleQBPaymentFailed(event: QBPaymentEvent): Promise<void> {
  const payment = event.payload?.Payment;
  if (!payment) {
    logger.warn("[QB Webhook] payment.failed missing Payment payload");
    return;
  }

  const qbInvoiceId = payment.LinkedTxns?.find((t) => t.TxnType === "Invoice")?.TxnId;
  if (!qbInvoiceId) {
    logger.warn("[QB Webhook] payment.failed: no linked Invoice found");
    return;
  }

  const invoice = await prisma.invoice.findFirst({
    where: { quickbooksInvoiceId: qbInvoiceId },
  });
  if (!invoice) {
    logger.warn("[QB Webhook] Invoice not found for failed payment", { qbInvoiceId });
    return;
  }

  const pendingPayment = invoice.orderId
    ? await prisma.payment.findFirst({
        where: { orderId: invoice.orderId, status: "pending", paymentSource: "quickbooks_payments" },
        orderBy: { createdAt: "desc" },
      })
    : null;

  if (pendingPayment) {
    await prisma.payment.update({
      where: { id: pendingPayment.id },
      data: {
        status: "failed",
        failedAt: new Date(),
        failureReason: payment.TransactionNum ?? "Payment failed via QuickBooks",
      },
    });
    logger.info("[QB Webhook] Pending payment marked as failed", {
      paymentId: pendingPayment.id,
      invoiceId: invoice.id,
    });
  } else {
    logger.warn("[QB Webhook] No pending payment found to mark as failed", {
      invoiceId: invoice.id,
      orderId: invoice.orderId,
    });
  }
}

// ---------------------------------------------------------------------------
// Handler: QuickBooks payment.refunded
// ---------------------------------------------------------------------------
async function handleQBPaymentRefunded(event: QBPaymentEvent): Promise<void> {
  const payment = event.payload?.Payment;
  if (!payment) {
    logger.warn("[QB Webhook] payment.refunded missing Payment payload");
    return;
  }

  const qbInvoiceId = payment.LinkedTxns?.find((t) => t.TxnType === "Invoice")?.TxnId;
  if (!qbInvoiceId) {
    logger.warn("[QB Webhook] payment.refunded: no linked Invoice found");
    return;
  }

  const invoice = await prisma.invoice.findFirst({
    where: { quickbooksInvoiceId: qbInvoiceId },
    include: { client: { select: { id: true } } },
  });

  if (!invoice) {
    logger.warn("[QB Webhook] Invoice not found for refund", { qbInvoiceId });
    return;
  }

  const systemAdmin = await prisma.user.findFirst({
    where: { role: "super_admin", isActive: true },
    select: { id: true },
  });

  if (!systemAdmin) {
    logger.error("[QB Webhook] No super_admin found to record credit approver", { invoiceId: invoice.id });
    return;
  }

  const refundAmount = payment.TotalAmt ?? 0;

  await prisma.$transaction(async (tx) => {
    await tx.credit.create({
      data: {
        clientId: invoice.client.id,
        invoiceId: invoice.id,
        amount: refundAmount,
        reason: `QuickBooks refund — QB Invoice ID: ${qbInvoiceId}`,
        approvedBy: systemAdmin.id,
        approvedAt: new Date(),
      },
    });

    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.refunded },
    });
  });

  logger.info("[QB Webhook] Refund credit recorded", { invoiceId: invoice.id, refundAmount });
}

// ---------------------------------------------------------------------------
// Handler: SendGrid delivered
// ---------------------------------------------------------------------------
async function handleSGDelivered(event: SendGridEvent): Promise<void> {
  const orderId = event.custom_args?.["order_id"];

  if (!orderId) {
    logger.info("[SG Webhook] delivered event missing order_id custom_arg", {
      email: event.email,
      sg_message_id: event.sg_message_id,
    });
    return;
  }

  const tracking = await prisma.deliveryTracking.findFirst({
    where: { orderId },
  });

  if (!tracking) {
    logger.warn("[SG Webhook] No delivery tracking for order", { orderId });
    return;
  }

  const deliveredAt = event.timestamp ? new Date(event.timestamp * 1000) : new Date();

  await prisma.deliveryTracking.update({
    where: { id: tracking.id },
    data: { emailSentAt: deliveredAt },
  });

  const checklist = await prisma.deliveryChecklist.findUnique({
    where: { orderId },
    include: {
      items: {
        where: { stepKey: "email_sent" },
        select: { id: true, isConfirmed: true },
      },
    },
  });

  if (checklist) {
    const emailSentItem = checklist.items[0];
    if (emailSentItem && !emailSentItem.isConfirmed) {
      await prisma.deliveryChecklistItem.update({
        where: { id: emailSentItem.id },
        data: { isConfirmed: true, confirmedAt: deliveredAt },
      });
      logger.info("[SG Webhook] Auto-confirmed email_sent checklist item", { orderId });
    }
  }

  logger.info("[SG Webhook] Email delivered, tracking updated", { orderId, deliveredAt });
}
