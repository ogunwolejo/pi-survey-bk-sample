import { Router } from "express";
import { z } from "zod";
import { QuoteStatus, OrderStatus, InvoiceStatus, SyncStatus, type PaymentTerms, type County, type PropertyType, type SurveyType, type LockedGates, type DeliveryPreference, type Priority, type Team } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { prisma } from "../lib/prisma";
import { validateBody } from "../middleware/validate.middleware";
import { proposalGetRateLimit, proposalPostRateLimit } from "../middleware/rate-limit.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { withTransaction } from "../lib/transaction";
import { getNextSequence } from "../lib/sequential-number";
import { NotFoundError, ValidationError, ConflictError } from "../lib/errors";
import { quoteLogger as logger } from "../lib/logger";
import { envStore } from "../env-store";
import { emitDashboardEvent } from "../lib/socket-emitter";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { getProposalData } from "../services/proposal.service";
import { detectPaymentRequirement } from "../services/payment-detection.service";
import { notifyHollyOrderCreated } from "../services/notification.service";
import { fireUnifiedEvent, CustomerIoEventsNames } from "../services/customerio.service";
import {
  findOrCreateCustomer,
  createInvoice,
  sendInvoice,
  getInvoicePaymentUrl,
} from "../services/quickbooks.service";

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const signSchema = z.object({
  signerName: z.string().min(1),
  signerEmail: z.string().email(),
  signatureType: z.enum(["type", "draw"]),
  signatureText: z.string().min(1),
  signatureImageData: z.string().optional(),
});

const createInvoiceSchema = z.object({
  paymentMethod: z.enum(["credit_card", "ach"]),
  payFullWithDiscount: z.boolean().optional().default(false),
});

// ─── GET /:token — load proposal data ─────────────────────────────────────────

router.get("/:token", proposalGetRateLimit, async (req, res): Promise<void> => {
  try {
    const data = await getProposalData(req.params["token"]!);
    sendSuccess(res, data);
  } catch (err) {
    if (err instanceof ValidationError && /expired/i.test(err.message)) {
      res.status(410).json({
        error: { code: "TOKEN_EXPIRED", message: err.message },
      });
      return;
    }
    if (err instanceof ConflictError) {
      res.status(409).json({
        error: { code: "ALREADY_ACCEPTED", message: err.message },
      });
      return;
    }
    sendError(res, err);
  }
});

// ─── GET /:token/payment-status — payment state for direct payment page ──────

router.get("/:token/payment-status", proposalGetRateLimit, async (req, res): Promise<void> => {
  try {
    const token = req.params["token"]!;
    const tokenRecord = await loadTokenRelaxed(token);
    const quote = tokenRecord.quote;

    const sig = await prisma.contractSignature.findFirst({
      where: { quoteId: quote.id },
      select: { id: true },
    });
    if (!sig) {
      sendSuccess(res, {
        status: "unsigned" as const,
        redirectUrl: `/proposal/${token}`,
      });
      return;
    }

    const quotePrice = Number(quote.price);
    const propertyAddress = [
      quote.propertyAddressLine1,
      quote.propertyCity,
      quote.propertyState,
    ].filter(Boolean).join(", ");
    const quoteSummary = {
      id: quote.id,
      quoteNumber: quote.quoteNumber,
      propertyAddress,
      surveyType: quote.surveyType,
      price: quotePrice,
    };

    const unpaidInvoice = await prisma.invoice.findFirst({
      where: { quoteId: quote.id, status: InvoiceStatus.sent },
      select: { id: true, invoiceNumber: true, totalAmount: true, quickbooksInvoiceId: true },
    });

    if (unpaidInvoice && unpaidInvoice.quickbooksInvoiceId) {
      const payNowUrl = await getInvoicePaymentUrl(unpaidInvoice.quickbooksInvoiceId);
      sendSuccess(res, {
        status: "awaiting_payment" as const,
        payNowUrl,
        quote: quoteSummary,
        invoice: {
          id: unpaidInvoice.id,
          invoiceNumber: unpaidInvoice.invoiceNumber,
          totalAmount: Number(unpaidInvoice.totalAmount),
        },
      });
      return;
    }

    const paidInvoice = await prisma.invoice.findFirst({
      where: { quoteId: quote.id, status: InvoiceStatus.paid },
      select: { id: true },
    });
    if (paidInvoice || quote.status === QuoteStatus.accepted) {
      sendSuccess(res, { status: "paid" as const, quote: quoteSummary });
      return;
    }

    const detection = detectPaymentRequirement({
      customerType: quote.client.customerType,
      paymentTerms: quote.paymentTerms,
      quotePrice,
    });

    let paymentInfo: {
      required: boolean;
      terms: string;
      depositPercentage: number;
      depositAmount: number;
      processingFee: { cardRate: number; achRate: number };
    };

    if (quote.paymentRequired !== null && quote.paymentTerms) {
      const pct = quote.paymentRequired
        ? getDepositPercentageForTerms(quote.paymentTerms)
        : 0;
      paymentInfo = {
        required: quote.paymentRequired,
        terms: quote.paymentTerms,
        depositPercentage: pct,
        depositAmount: roundCents(quotePrice * (pct / 100)),
        processingFee: { cardRate: CARD_FEE_RATE, achRate: 0 },
      };
    } else {
      paymentInfo = {
        required: detection.paymentRequired,
        terms: detection.paymentTerms,
        depositPercentage: detection.depositPercentage,
        depositAmount: detection.depositAmount,
        processingFee: { cardRate: CARD_FEE_RATE, achRate: 0 },
      };
    }

    sendSuccess(res, {
      status: "awaiting_method" as const,
      quote: quoteSummary,
      payment: paymentInfo,
    });
  } catch (err) {
    if (err instanceof ValidationError && /expired/i.test(err.message)) {
      res.status(410).json({
        error: { code: "TOKEN_EXPIRED", message: (err as Error).message },
      });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: (err as Error).message },
      });
      return;
    }
    sendError(res, err);
  }
});

// ─── POST /:token/sign — sign proposal and optionally create order ────────────

router.post(
  "/:token/sign",
  proposalPostRateLimit,
  validateBody(signSchema),
  async (req, res): Promise<void> => {
    try {
      const body = req.body as z.infer<typeof signSchema>;
      const token = req.params["token"]!;

      const tokenRecord = await loadAndValidateToken(token);
      const quote = tokenRecord.quote;

      await prisma.contractSignature.create({
        data: {
          quoteId: quote.id,
          signerName: body.signerName,
          signerEmail: body.signerEmail,
          s3Key: "",
          signatureData: {
            type: body.signatureType,
            text: body.signatureText,
            imageData: body.signatureImageData ?? null,
            signedAt: new Date().toISOString(),
            userAgent: req.headers["user-agent"] ?? null,
          },
          signedAt: new Date(),
          ipAddress: req.ip ?? null,
        },
      });

      const signAudit = await prisma.entityAuditLog.create({
        data: {
          entityType: "quote",
          entityId: quote.id,
          entityNumber: quote.quoteNumber,
          action: "updated",
          userName: body.signerEmail,
          changedAt: new Date(),
          changes: { signerName: body.signerName, signerEmail: body.signerEmail } as Prisma.InputJsonValue,
          changeSummary: `Proposal signed by ${body.signerName} (${body.signerEmail})`,
          source: "api",
        },
        include: { user: { select: { id: true, name: true } } },
      }).catch((err) => {
        logger.warn("Audit log for proposal sign failed", { err, quoteId: quote.id });
        return null;
      });

      const proposalIo = req.app.get("io") as SocketServer | undefined;
      if (signAudit) {
        proposalIo?.to(ROOM_PREFIXES.QUOTE(quote.id)).emit("quote:history:new", signAudit);
      }

      fireUnifiedEvent({
        contactId: quote.id,
        identifyAttributes: {
          email: quote.client.email,
          first_name: quote.client.firstName,
          last_name: quote.client.lastName,
        },
        unifiedEventName: CustomerIoEventsNames.PROPOSAL_SIGNED,
        legacyEventName: CustomerIoEventsNames.QUOTE_PROPOSAL_SIGNED,
        attributes: {
          source_type: "quote",
          source_id: quote.id,
          source_number: quote.quoteNumber,
          signer_name: body.signerName,
          signer_email: body.signerEmail,
          property_address: [quote.propertyAddressLine1, quote.propertyCity, quote.propertyState].filter(Boolean).join(", "),
          amount: Number(quote.price).toFixed(2),
        },
      });

      const paymentRequired = resolvePaymentRequired(quote);

      if (!paymentRequired) {
        const result = await createOrderFromProposal(token, quote);

        const orderAudit = await prisma.entityAuditLog.create({
          data: {
            entityType: "quote",
            entityId: quote.id,
            entityNumber: quote.quoteNumber,
            action: "created",
            userName: body.signerEmail,
            changedAt: new Date(),
            changes: { orderId: result.order.id, orderNumber: result.order.orderNumber } as Prisma.InputJsonValue,
            changeSummary: `Order ${result.order.orderNumber} created from signed proposal (no payment required)`,
            source: "api",
          },
          include: { user: { select: { id: true, name: true } } },
        }).catch((err) => {
          logger.warn("Audit log for order creation failed", { err, quoteId: quote.id });
          return null;
        });

        if (orderAudit) {
          proposalIo?.to(ROOM_PREFIXES.QUOTE(quote.id)).emit("quote:history:new", orderAudit);
        }

        const io = req.app.get("io") as SocketServer | undefined;
        emitDashboardEvent(io, "dashboard:quotes", "quote:updated", {
          quoteId: quote.id,
          status: QuoteStatus.accepted,
        });
        emitDashboardEvent(io, "dashboard:orders", "order:created", {
          orderId: result.order.id,
          orderNumber: result.order.orderNumber,
          status: OrderStatus.new,
        });

        logger.info("Proposal signed, order created (no payment required)", {
          quoteId: quote.id,
          orderId: result.order.id,
        });

        void notifyHollyOrderCreated(result.order, quote, io).catch((err) =>
          logger.error("[Proposal] notifyHollyOrderCreated failed", {
            error: err instanceof Error ? err.message : String(err),
            orderId: result.order.id,
          })
        );

        return sendSuccess(res, {
          signed: true,
          paymentRequired: false,
          order: result.order,
          contact: result.contact,
        }, 201);
      }

      logger.info("Proposal signed, awaiting payment", { quoteId: quote.id });

      fireUnifiedEvent({
        contactId: quote.id,
        identifyAttributes: {
          email: quote.client.email,
          first_name: quote.client.firstName,
          last_name: quote.client.lastName,
        },
        unifiedEventName: CustomerIoEventsNames.PAYMENT_REMINDER_START,
        attributes: {
          source_type: "quote",
          source_id: quote.id,
          source_number: quote.quoteNumber,
          client_name: `${quote.client.firstName} ${quote.client.lastName}`,
          client_email: quote.client.email,
          property_address: [quote.propertyAddressLine1, quote.propertyCity, quote.propertyState].filter(Boolean).join(", "),
          amount: Number(quote.price).toFixed(2),
          proposal_url: `${envStore.FRONTEND_URL}/proposal/${token}/pay`,
        },
      });

      sendSuccess(res, {
        signed: true,
        paymentRequired: true,
        awaitingPayment: true,
      }, 201);
    } catch (err) {
      if (err instanceof ValidationError && /expired/i.test(err.message)) {
        res.status(410).json({
          error: { code: "TOKEN_EXPIRED", message: err.message },
        });
        return;
      }
      if (err instanceof ConflictError) {
        res.status(409).json({
          error: { code: "ALREADY_ACCEPTED", message: err.message },
        });
        return;
      }
      sendError(res, err);
    }
  },
);

// ─── POST /:token/create-invoice — create QB invoice for signed proposal ──────

router.post(
  "/:token/create-invoice",
  proposalPostRateLimit,
  validateBody(createInvoiceSchema),
  async (req, res): Promise<void> => {
    try {
      const body = req.body as z.infer<typeof createInvoiceSchema>;
      const token = req.params["token"]!;

      const tokenRecord = await loadAndValidateToken(token);
      const quote = tokenRecord.quote;

      await validateSignatureExists(quote.id);

      const amounts = calculateInvoiceAmounts(quote, body.paymentMethod, body.payFullWithDiscount);

      let qbInvoiceId: string;
      let payNowUrl: string;

      try {
        const qbCustomerId = await findOrCreateCustomer(
          quote.client.email,
          `${quote.client.firstName} ${quote.client.lastName}`,
        );

        const lineItems = buildQBLineItems(quote, amounts);
        const qbInvoice = await createInvoice({
          customerRef: qbCustomerId,
          billEmail: quote.client.email,
          lineItems,
          docNumber: quote.quoteNumber,
          allowCreditCard: body.paymentMethod === "credit_card",
          allowACH: body.paymentMethod === "ach",
        });

        qbInvoiceId = qbInvoice.Id;
        await sendInvoice(qbInvoiceId, quote.client.email);
        payNowUrl = await getInvoicePaymentUrl(qbInvoiceId);
      } catch (qbErr) {
        logger.error("QuickBooks invoice creation failed", {
          quoteId: quote.id,
          clientId: quote.clientId,
          amount: amounts.totalAmount,
          paymentMethod: body.paymentMethod,
          error: qbErr instanceof Error ? qbErr.message : String(qbErr),
          stack: qbErr instanceof Error ? qbErr.stack : undefined,
        });

        const io = req.app.get("io") as SocketServer | undefined;
        if (io) {
          io.emit("invoice:creation-failed", {
            quoteId: quote.id,
            quoteNumber: quote.quoteNumber,
            clientEmail: quote.client.email,
            amount: amounts.totalAmount,
            error: qbErr instanceof Error ? qbErr.message : "Unknown error",
          });
        }

        res.status(500).json({
          error: {
            code: "INVOICE_CREATION_FAILED",
            message: "Payment processing is temporarily unavailable. Please try again or contact Pi Surveying.",
          },
        });
        return;
      }

      const invoice = await createLocalInvoice(quote, amounts, qbInvoiceId);

      const invoiceAudit = await prisma.entityAuditLog.create({
        data: {
          entityType: "quote",
          entityId: quote.id,
          entityNumber: quote.quoteNumber,
          action: "created",
          userName: quote.client.email,
          changedAt: new Date(),
          changes: {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            qbInvoiceId: qbInvoiceId,
            totalAmount: amounts.totalAmount,
            paymentMethod: body.paymentMethod,
          } as Prisma.InputJsonValue,
          changeSummary: `Invoice ${invoice.invoiceNumber} created for proposal (${body.paymentMethod}, ${amounts.totalAmount.toFixed(2)})`,
          source: "api",
        },
        include: { user: { select: { id: true, name: true } } },
      }).catch((err) => {
        logger.warn("Audit log for invoice creation failed", { err, quoteId: quote.id });
        return null;
      });

      const invoiceIo = req.app.get("io") as SocketServer | undefined;
      if (invoiceAudit) {
        invoiceIo?.to(ROOM_PREFIXES.QUOTE(quote.id)).emit("quote:history:new", invoiceAudit);
      }

      logger.info("Invoice created for proposal", {
        quoteId: quote.id,
        invoiceId: invoice.id,
        qbInvoiceId,
      });

      sendSuccess(res, {
        quickbooksInvoiceId: qbInvoiceId,
        payNowUrl,
        invoice: {
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          totalAmount: amounts.totalAmount,
          baseAmount: amounts.depositBase,
          processingFee: amounts.processingFee,
          taxAmount: 0,
        },
      }, 201);
    } catch (err) {
      if (err instanceof ValidationError && /expired/i.test(err.message)) {
        res.status(410).json({
          error: { code: "TOKEN_EXPIRED", message: err.message },
        });
        return;
      }
      if (err instanceof ConflictError) {
        res.status(409).json({
          error: { code: "ALREADY_ACCEPTED", message: err.message },
        });
        return;
      }
      sendError(res, err);
    }
  },
);

// ─── Token validation helpers ─────────────────────────────────────────────────

async function loadTokenRelaxed(token: string) {
  const tokenRecord = await prisma.quoteToken.findUnique({
    where: { token },
    include: {
      quote: { include: { client: true } },
    },
  });

  if (!tokenRecord) {
    throw new NotFoundError("Proposal link not found");
  }
  if (tokenRecord.expiresAt < new Date()) {
    throw new ValidationError("This proposal link has expired");
  }

  const quote = tokenRecord.quote;
  if (!quote || quote.deletedAt) {
    throw new NotFoundError("Quote not found");
  }

  return tokenRecord;
}

async function loadAndValidateToken(token: string) {
  const tokenRecord = await prisma.quoteToken.findUnique({
    where: { token },
    include: {
      quote: { include: { client: true } },
    },
  });

  if (!tokenRecord) {
    throw new NotFoundError("Proposal link not found");
  }
  if (tokenRecord.expiresAt < new Date()) {
    throw new ValidationError("This proposal link has expired");
  }

  const quote = tokenRecord.quote;
  if (!quote || quote.deletedAt) {
    throw new NotFoundError("Quote not found");
  }
  if (quote.status === QuoteStatus.accepted) {
    throw new ConflictError("This quote has already been accepted");
  }

  return tokenRecord;
}

// ─── Resolve whether payment is required ──────────────────────────────────────

function resolvePaymentRequired(
  quote: { paymentRequired: boolean | null; client: { customerType: string; paymentTerms: string | null }; paymentTerms: string | null; price: unknown },
): boolean {
  if (quote.paymentRequired !== null) {
    return quote.paymentRequired;
  }
  const detection = detectPaymentRequirement({
    customerType: quote.client.customerType,
    paymentTerms: quote.paymentTerms,
    quotePrice: Number(quote.price),
  });
  return detection.paymentRequired;
}

// ─── Quote shape for order creation ──────────────────────────────────────────

interface QuoteForOrder {
  id: string;
  clientId: string;
  billingClientId: string | null;
  propertyAddressLine1: string;
  propertyAddressLine2: string | null;
  propertyCity: string;
  propertyState: string;
  propertyZip: string;
  propertyCounty: string | null;
  propertyType: string | null;
  pin: string;
  additionalPins: string[];
  surveyType: string | null;
  price: unknown;
  paymentTerms: string | null;
  closingDate: Date | null;
  onsiteContactFirstName: string | null;
  onsiteContactLastName: string | null;
  onsiteContactPhone: string | null;
  lockedGates: string | null;
  deliveryPreference: string | null;
  legalDescription: string | null;
  priority: string;
  referralSource: string | null;
  internalNotes: string | null;
  rushFeeApplied: boolean;
  rushFeeWaived: boolean;
  rushFeeWaivedReason: string | null;
  team: string;
  client: { id: string; firstName: string; lastName: string; email: string };
}

// ─── Create order from signed proposal (no payment) ──────────────────────────

async function createOrderFromProposal(token: string, quote: QuoteForOrder) {
  return withTransaction(
    async (tx) => {
      const orderNumber = await getNextSequence("ORDER");
      const today = new Date();

      const order = await tx.order.create({
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
          propertyCounty: quote.propertyCounty as County | null,
          propertyType: quote.propertyType as PropertyType | null,
          pin: quote.pin,
          additionalPins: quote.additionalPins,
          surveyType: quote.surveyType as SurveyType,
          price: quote.price as unknown as number,
          paymentTerms: (quote.paymentTerms ?? "pre_pay") as PaymentTerms,
          closingDate: quote.closingDate,
          onsiteContactFirstName: quote.onsiteContactFirstName,
          onsiteContactLastName: quote.onsiteContactLastName,
          onsiteContactPhone: quote.onsiteContactPhone,
          lockedGates: quote.lockedGates as LockedGates | null,
          deliveryPreference: quote.deliveryPreference as DeliveryPreference | null,
          legalDescription: quote.legalDescription,
          source: "quote_acceptance",
          priority: quote.priority as Priority,
          team: quote.team as Team,
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

      await tx.payment.updateMany({
        where: { quoteId: quote.id },
        data: { orderId: order.id },
      });

      const contact = await tx.client.findUnique({
        where: { email: quote.client.email },
        select: { id: true, firstName: true, lastName: true, email: true },
      });

      await tx.quote.update({
        where: { id: quote.id },
        data: { status: QuoteStatus.accepted },
      });

      await tx.quoteToken.update({
        where: { token },
        data: { usedAt: new Date() },
      });

      return { order, contact };
    },
    "Serializable",
  );
}

// ─── Invoice helpers ──────────────────────────────────────────────────────────

const CARD_FEE_RATE = 0.03;
const EARLY_PAY_DISCOUNT_RATE = 0.05;

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

interface InvoiceAmounts {
  quotePrice: number;
  depositBase: number;
  discountAmount: number;
  processingFee: number;
  totalAmount: number;
}

function getDepositPercentageForTerms(terms: string): number {
  switch (terms) {
    case "pre_pay":
    case "full_with_discount":
      return 100;
    case "fifty_fifty":
      return 50;
    case "post_closing":
      return 0;
    default:
      return 100;
  }
}

function calculateInvoiceAmounts(
  quote: { price: unknown; paymentTerms: string | null; paymentRequired: boolean | null; client: { customerType: string } },
  paymentMethod: "credit_card" | "ach",
  payFullWithDiscount: boolean,
): InvoiceAmounts {
  const quotePrice = Number(quote.price);

  let resolvedTerms: string;
  let depositPct: number;

  if (quote.paymentRequired !== null && quote.paymentTerms) {
    resolvedTerms = quote.paymentTerms;
    depositPct = quote.paymentRequired ? getDepositPercentageForTerms(resolvedTerms) : 0;
  } else {
    const detection = detectPaymentRequirement({
      customerType: quote.client.customerType,
      paymentTerms: quote.paymentTerms,
      quotePrice,
    });
    resolvedTerms = detection.paymentTerms;
    depositPct = detection.depositPercentage;
  }

  const depositAmount = roundCents(quotePrice * (depositPct / 100));

  let depositBase: number;
  let discountAmount = 0;

  if (payFullWithDiscount && resolvedTerms === "full_with_discount") {
    discountAmount = roundCents(quotePrice * EARLY_PAY_DISCOUNT_RATE);
    depositBase = roundCents(quotePrice - discountAmount);
  } else {
    depositBase = depositAmount;
  }

  const processingFee = paymentMethod === "credit_card"
    ? roundCents(depositBase * CARD_FEE_RATE)
    : 0;

  return {
    quotePrice,
    depositBase,
    discountAmount,
    processingFee,
    totalAmount: roundCents(depositBase + processingFee),
  };
}

async function validateSignatureExists(quoteId: string): Promise<void> {
  const sig = await prisma.contractSignature.findFirst({
    where: { quoteId },
    select: { id: true },
  });
  if (!sig) {
    throw new ValidationError("Proposal must be signed before creating an invoice");
  }
}

function buildQBLineItems(
  quote: { surveyType: string | null; quoteNumber: string },
  amounts: InvoiceAmounts,
): { description: string; amount: number }[] {
  const items: { description: string; amount: number }[] = [];

  if (amounts.discountAmount > 0) {
    items.push({
      description: `Survey Service — ${quote.surveyType ?? "Land Survey"} (${quote.quoteNumber})`,
      amount: amounts.quotePrice,
    });
    items.push({
      description: "Early Payment Discount (5%)",
      amount: -amounts.discountAmount,
    });
  } else {
    items.push({
      description: `Survey Service — ${quote.surveyType ?? "Land Survey"} (${quote.quoteNumber})`,
      amount: amounts.depositBase,
    });
  }

  if (amounts.processingFee > 0) {
    items.push({
      description: "Credit Card Processing Fee (3%)",
      amount: amounts.processingFee,
    });
  }

  return items;
}

async function createLocalInvoice(
  quote: { id: string; clientId: string; quoteNumber: string; surveyType: string | null },
  amounts: InvoiceAmounts,
  qbInvoiceId: string,
) {
  const invoiceNumber = await getNextSequence("INV");
  const today = new Date();

  const subtotal = amounts.discountAmount > 0
    ? amounts.quotePrice
    : amounts.depositBase;

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber,
      quoteId: quote.id,
      clientId: quote.clientId,
      status: InvoiceStatus.sent,
      invoiceDate: today,
      dueDate: today,
      subtotal,
      taxRate: 0,
      taxAmount: 0,
      discountAmount: amounts.discountAmount,
      creditApplied: 0,
      totalAmount: amounts.totalAmount,
      amountPaid: 0,
      balanceDue: amounts.totalAmount,
      quickbooksInvoiceId: qbInvoiceId,
      syncStatus: SyncStatus.synced,
      notes: `Auto-created for proposal ${quote.quoteNumber}`,
      invoiceLineItems: {
        create: buildLocalLineItems(quote, amounts),
      },
    },
    select: { id: true, invoiceNumber: true },
  });

  return invoice;
}

function buildLocalLineItems(
  quote: { surveyType: string | null; quoteNumber: string },
  amounts: InvoiceAmounts,
) {
  type LineItem = {
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    sortOrder: number;
  };

  const items: LineItem[] = [];
  let sortOrder = 1;

  if (amounts.discountAmount > 0) {
    items.push({
      description: `Survey Service — ${quote.surveyType ?? "Land Survey"} (${quote.quoteNumber})`,
      quantity: 1,
      unitPrice: amounts.quotePrice,
      amount: amounts.quotePrice,
      sortOrder: sortOrder++,
    });
    items.push({
      description: "Early Payment Discount (5%)",
      quantity: 1,
      unitPrice: -amounts.discountAmount,
      amount: -amounts.discountAmount,
      sortOrder: sortOrder++,
    });
  } else {
    items.push({
      description: `Survey Service — ${quote.surveyType ?? "Land Survey"} (${quote.quoteNumber})`,
      quantity: 1,
      unitPrice: amounts.depositBase,
      amount: amounts.depositBase,
      sortOrder: sortOrder++,
    });
  }

  if (amounts.processingFee > 0) {
    items.push({
      description: "Credit Card Processing Fee (3%)",
      quantity: 1,
      unitPrice: amounts.processingFee,
      amount: amounts.processingFee,
      sortOrder: sortOrder,
    });
  }

  return items;
}

export default router;
