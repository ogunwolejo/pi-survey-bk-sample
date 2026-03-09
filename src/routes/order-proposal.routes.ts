import { Router } from "express";
import { z } from "zod";
import { ChatEntityType, OrderStatus, InvoiceStatus, SyncStatus } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { prisma } from "../lib/prisma";
import { validateBody } from "../middleware/validate.middleware";
import {
  proposalGetRateLimit,
  proposalPostRateLimit,
} from "../middleware/rate-limit.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { withTransaction } from "../lib/transaction";
import { getNextSequence } from "../lib/sequential-number";
import {
  NotFoundError,
  ValidationError,
  ConflictError,
} from "../lib/errors";
import { orderLogger as logger } from "../lib/logger";
import { createSystemEvent as createChatSystemEvent } from "../services/chat.service";
import { envStore } from "../env-store";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import {
  loadAndValidateOrderToken,
} from "../services/order-proposal.service";
import { detectPaymentRequirement } from "../services/payment-detection.service";
import {
  fireUnifiedEvent,
  CustomerIoEventsNames,
} from "../services/customerio.service";
import { notifyResearchLeader } from "../services/notification.service";
import { tryTransitionToResearchQueued } from "../services/payment-gate.service";
import {
  findOrCreateCustomer,
  createInvoice as createQBInvoice,
  sendInvoice,
  getInvoicePaymentUrl,
} from "../services/quickbooks.service";

const CARD_FEE_RATE = 0.03;
const EARLY_PAY_DISCOUNT_RATE = 0.05;

const TERMS_AND_CONDITIONS = [
  "By signing this proposal, you agree to the scope of work described herein.",
  "Payment is due per the terms stated. Late payments may incur a 1.5% monthly finance charge.",
  "Pi Surveying PLLC will complete the survey within the estimated timeframe, subject to weather, access, and title document availability.",
  "The client is responsible for providing clear access to the property and marking any known boundary features.",
  "This proposal is valid for 30 days from the date of issue.",
  "Cancellation after work has commenced may result in charges for work performed to date.",
  "All survey work is performed in accordance with the Illinois Minimum Standards for boundary surveys.",
  "Pi Surveying PLLC maintains professional liability insurance. Liability is limited to the fee paid for the survey.",
].join(" ");

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assembleAddress(
  line1: string | null,
  line2: string | null,
  city: string | null,
  state: string | null,
  zip: string | null,
): string {
  const parts: string[] = [];
  if (line1) parts.push(line1);
  if (line2) parts.push(line2);
  const cityStateZip = [city, state].filter(Boolean).join(", ");
  if (zip) {
    parts.push(cityStateZip ? `${cityStateZip} ${zip}` : zip);
  } else if (cityStateZip) {
    parts.push(cityStateZip);
  }
  return parts.join(", ");
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

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

interface InvoiceAmounts {
  orderPrice: number;
  depositBase: number;
  discountAmount: number;
  processingFee: number;
  totalAmount: number;
}

function calculateInvoiceAmounts(
  order: {
    price: unknown;
    paymentTerms: string | null;
    paymentRequired: boolean | null;
    customerType: string | null;
  },
  paymentMethod: "credit_card" | "ach",
  payFullWithDiscount: boolean,
): InvoiceAmounts {
  const orderPrice = Number(order.price);

  let resolvedTerms: string;
  let depositPct: number;

  if (order.paymentRequired !== null && order.paymentTerms) {
    resolvedTerms = order.paymentTerms;
    depositPct = order.paymentRequired
      ? getDepositPercentageForTerms(resolvedTerms)
      : 0;
  } else {
    const detection = detectPaymentRequirement({
      customerType: order.customerType ?? "homeowner",
      paymentTerms: order.paymentTerms,
      quotePrice: orderPrice,
    });
    resolvedTerms = detection.paymentTerms;
    depositPct = detection.depositPercentage;
  }

  const depositAmount = roundCents(orderPrice * (depositPct / 100));

  let depositBase: number;
  let discountAmount = 0;

  if (payFullWithDiscount && resolvedTerms === "full_with_discount") {
    discountAmount = roundCents(orderPrice * EARLY_PAY_DISCOUNT_RATE);
    depositBase = roundCents(orderPrice - discountAmount);
  } else {
    depositBase = depositAmount;
  }

  const processingFee =
    paymentMethod === "credit_card"
      ? roundCents(depositBase * CARD_FEE_RATE)
      : 0;

  return {
    orderPrice,
    depositBase,
    discountAmount,
    processingFee,
    totalAmount: roundCents(depositBase + processingFee),
  };
}

// ─── Router Factory ──────────────────────────────────────────────────────────

export function createOrderProposalRouter(io: SocketServer): Router {
  const router = Router();

  // ─── GET /:token — load order proposal data ─────────────────────────────────

  router.get("/:token", proposalGetRateLimit, async (req, res): Promise<void> => {
    try {
      const tokenRecord = await loadAndValidateOrderToken(req.params["token"]!);
      const order = tokenRecord.order;

      if (tokenRecord.usedAt) {
        const alreadySigned = await prisma.orderContractSignature.findFirst({
          where: { orderId: order.id },
          select: { id: true },
        });
        if (alreadySigned) {
          res.status(409).json({
            error: {
              code: "ALREADY_SIGNED",
              message: "This order proposal has already been signed",
            },
          });
          return;
        }
      }

      const client = order.client;
      const orderPrice = Number(order.price);
      const propertyAddress = assembleAddress(
        order.propertyAddressLine1,
        order.propertyAddressLine2,
        order.propertyCity,
        order.propertyState,
        order.propertyZip,
      );

      let paymentInfo: {
        required: boolean;
        terms: string;
        depositPercentage: number;
        depositAmount: number;
      };

      if (order.paymentRequired !== null) {
        const terms = order.paymentTerms ?? "post_closing";
        const pct = order.paymentRequired
          ? getDepositPercentageForTerms(terms)
          : 0;
        paymentInfo = {
          required: order.paymentRequired,
          terms,
          depositPercentage: pct,
          depositAmount: roundCents(orderPrice * (pct / 100)),
        };
      } else {
        const detection = detectPaymentRequirement({
          customerType: order.customerType ?? client?.customerType ?? "homeowner",
          paymentTerms: order.paymentTerms,
          quotePrice: orderPrice,
        });
        paymentInfo = {
          required: detection.paymentRequired,
          terms: detection.paymentTerms,
          depositPercentage: detection.depositPercentage,
          depositAmount: detection.depositAmount,
        };
      }

      sendSuccess(res, {
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          propertyAddress,
          surveyType: order.surveyType,
          price: orderPrice,
          priceBreakdown: order.priceBreakdown,
          estimatedTimeframe: null,
          county: order.propertyCounty,
        },
        client: {
          name: client
            ? `${client.firstName} ${client.lastName}`
            : "Client",
          email: client?.email ?? "",
        },
        payment: {
          ...paymentInfo,
          processingFee: { cardRate: CARD_FEE_RATE, achRate: 0 },
        },
        proposal: {
          companyName: "Pi Surveying PLLC",
          companyPhone: "(312) 555-0100",
          companyEmail: "info@pisurveying.com",
          companyAddress: "123 S Michigan Ave, Chicago, IL 60603",
          termsAndConditions: TERMS_AND_CONDITIONS,
        },
        token: {
          expiresAt: tokenRecord.expiresAt.toISOString(),
          alreadyAccepted: tokenRecord.usedAt !== null,
        },
      });
    } catch (err) {
      if (err instanceof ValidationError && /expired/i.test(err.message)) {
        res.status(410).json({
          error: { code: "TOKEN_EXPIRED", message: (err as Error).message },
        });
        return;
      }
      if (err instanceof ConflictError) {
        res.status(409).json({
          error: { code: "ALREADY_SIGNED", message: (err as Error).message },
        });
        return;
      }
      sendError(res, err);
    }
  });

  // ─── GET /:token/payment-status — payment state for direct payment page ──────

  router.get("/:token/payment-status", proposalGetRateLimit, async (req, res): Promise<void> => {
    try {
      const tokenRecord = await loadAndValidateOrderToken(req.params["token"]!);
      const order = tokenRecord.order;

      const sig = await prisma.orderContractSignature.findFirst({
        where: { orderId: order.id },
        select: { id: true },
      });
      if (!sig) {
        sendSuccess(res, {
          status: "unsigned" as const,
          redirectUrl: `/order-proposal/${req.params["token"]!}`,
        });
        return;
      }

      const propertyAddress = assembleAddress(
        order.propertyAddressLine1,
        order.propertyAddressLine2,
        order.propertyCity,
        order.propertyState,
        order.propertyZip,
      );
      const orderPrice = Number(order.price);
      const orderSummary = {
        id: order.id,
        orderNumber: order.orderNumber,
        propertyAddress,
        surveyType: order.surveyType,
        price: orderPrice,
      };

      const unpaidInvoice = await prisma.invoice.findFirst({
        where: { orderId: order.id, status: InvoiceStatus.sent },
        select: { id: true, invoiceNumber: true, totalAmount: true, quickbooksInvoiceId: true },
      });

      if (unpaidInvoice && unpaidInvoice.quickbooksInvoiceId) {
        const payNowUrl = await getInvoicePaymentUrl(unpaidInvoice.quickbooksInvoiceId);
        sendSuccess(res, {
          status: "awaiting_payment" as const,
          payNowUrl,
          order: orderSummary,
          invoice: {
            id: unpaidInvoice.id,
            invoiceNumber: unpaidInvoice.invoiceNumber,
            totalAmount: Number(unpaidInvoice.totalAmount),
          },
        });
        return;
      }

      const paidInvoice = await prisma.invoice.findFirst({
        where: { orderId: order.id, status: InvoiceStatus.paid },
        select: { id: true },
      });
      if (paidInvoice || order.status !== OrderStatus.pending_payment) {
        sendSuccess(res, { status: "paid" as const, order: orderSummary });
        return;
      }

      const detection = detectPaymentRequirement({
        customerType: order.customerType ?? "homeowner",
        paymentTerms: order.paymentTerms,
        quotePrice: orderPrice,
      });

      let paymentInfo: {
        required: boolean;
        terms: string;
        depositPercentage: number;
        depositAmount: number;
        processingFee: { cardRate: number; achRate: number };
      };

      if (order.paymentRequired !== null) {
        const terms = order.paymentTerms ?? "post_closing";
        const pct = order.paymentRequired
          ? getDepositPercentageForTerms(terms)
          : 0;
        paymentInfo = {
          required: order.paymentRequired,
          terms,
          depositPercentage: pct,
          depositAmount: roundCents(orderPrice * (pct / 100)),
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
        order: orderSummary,
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

  // ─── POST /:token/sign — sign order proposal ─────────────────────────────────

  router.post(
    "/:token/sign",
    proposalPostRateLimit,
    validateBody(signSchema),
    async (req, res): Promise<void> => {
      try {
        const body = req.body as z.infer<typeof signSchema>;
        const token = req.params["token"]!;

        const tokenRecord = await loadAndValidateOrderToken(token);
        const order = tokenRecord.order;

        if (tokenRecord.usedAt) {
          throw new ConflictError("This proposal has already been signed");
        }

        const paymentRequired = order.paymentRequired ?? false;

        const newStatus = paymentRequired
          ? OrderStatus.pending_payment
          : OrderStatus.research_queued;

        const result = await withTransaction(async (tx) => {
          await tx.orderContractSignature.create({
            data: {
              orderId: order.id,
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
              ipAddress: (req.ip ?? req.headers["x-forwarded-for"] as string) || null,
            },
          });

          await tx.orderToken.update({
            where: { id: tokenRecord.id },
            data: { usedAt: new Date() },
          });

          const updated = await tx.order.update({
            where: { id: order.id },
            data: { status: newStatus },
            include: { client: true },
          });

          return updated;
        }, "Serializable");

        await createChatSystemEvent({
          entityType: ChatEntityType.order,
          entityId: order.id,
          eventType: "order_proposal_signed",
          content: `${body.signerName} signed the order proposal`,
          metadata: {
            signerEmail: body.signerEmail,
            paymentRequired,
            newStatus,
          },
          io,
        });

        const clientName = result.client
          ? `${result.client.firstName} ${result.client.lastName}`
          : body.signerName;
        const propertyAddress = assembleAddress(
          order.propertyAddressLine1,
          order.propertyAddressLine2,
          order.propertyCity,
          order.propertyState,
          order.propertyZip,
        );

        fireUnifiedEvent({
          contactId: order.clientId ?? order.id,
          identifyAttributes: {
            email: body.signerEmail,
            first_name: result.client?.firstName ?? "",
            last_name: result.client?.lastName ?? "",
          },
          unifiedEventName: CustomerIoEventsNames.PROPOSAL_SIGNED,
          legacyEventName: CustomerIoEventsNames.ORDER_PROPOSAL_SIGNED,
          attributes: {
            source_type: "order",
            source_id: order.id,
            source_number: order.orderNumber,
            signer_name: body.signerName,
            signer_email: body.signerEmail,
            property_address: propertyAddress,
            amount: String(Number(order.price)),
          },
        });

        if (paymentRequired) {
          fireUnifiedEvent({
            contactId: order.clientId ?? order.id,
            identifyAttributes: {
              email: body.signerEmail,
              first_name: result.client?.firstName ?? "",
              last_name: result.client?.lastName ?? "",
            },
            unifiedEventName: CustomerIoEventsNames.PAYMENT_REMINDER_START,
            legacyEventName: CustomerIoEventsNames.ORDER_PAYMENT_REMINDER_START,
            attributes: {
              source_type: "order",
              source_id: order.id,
              source_number: order.orderNumber,
              client_name: clientName,
              client_email: body.signerEmail,
              property_address: propertyAddress,
              amount: String(Number(order.price)),
              proposal_url: `${envStore.FRONTEND_URL}/order-proposal/${token}/pay`,
            },
          });
        }

        if (!paymentRequired) {
          notifyResearchLeader(result, clientName, io).catch(() => {});
        }

        io.to(ROOM_PREFIXES.ORDER(order.id)).emit("order:status_changed", {
          orderId: order.id,
          status: newStatus,
          orderNumber: order.orderNumber,
        });

        if (paymentRequired) {
          tryTransitionToResearchQueued(order.id, null, body.signerName, io).catch((err) => {
            logger.error("[OrderProposal] tryTransitionToResearchQueued failed after signature", {
              orderId: order.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        logger.info("Order proposal signed", {
          orderId: order.id,
          paymentRequired,
          newStatus,
        });

        if (paymentRequired) {
          sendSuccess(
            res,
            { signed: true, paymentRequired: true, awaitingPayment: true },
            201,
          );
        } else {
          sendSuccess(
            res,
            {
              signed: true,
              paymentRequired: false,
              order: {
                id: result.id,
                orderNumber: result.orderNumber,
                status: result.status,
              },
            },
            201,
          );
        }
      } catch (err) {
        if (err instanceof ValidationError && /expired/i.test(err.message)) {
          res.status(410).json({
            error: { code: "TOKEN_EXPIRED", message: (err as Error).message },
          });
          return;
        }
        if (err instanceof ConflictError) {
          res.status(409).json({
            error: { code: "ALREADY_SIGNED", message: (err as Error).message },
          });
          return;
        }
        sendError(res, err);
      }
    },
  );

  // ─── POST /:token/create-invoice — create QB invoice for payment ────────────

  router.post(
    "/:token/create-invoice",
    proposalPostRateLimit,
    validateBody(createInvoiceSchema),
    async (req, res): Promise<void> => {
      try {
        const body = req.body as z.infer<typeof createInvoiceSchema>;
        const token = req.params["token"]!;

        const tokenRecord = await loadAndValidateOrderToken(token);
        const order = tokenRecord.order;

        if (order.status !== OrderStatus.pending_payment) {
          throw new ConflictError(
            `Order must be in 'pending_payment' status (current: ${order.status})`,
          );
        }

        const sig = await prisma.orderContractSignature.findFirst({
          where: { orderId: order.id },
          select: { id: true },
        });
        if (!sig) {
          throw new ValidationError(
            "Proposal must be signed before creating an invoice",
          );
        }

        const amounts = calculateInvoiceAmounts(
          order,
          body.paymentMethod,
          body.payFullWithDiscount,
        );

        const client = order.client;
        const clientEmail = client?.email ?? "";
        const clientName = client
          ? `${client.firstName} ${client.lastName}`
          : "Client";

        const qbCustomerRef = await findOrCreateCustomer(
          clientEmail,
          clientName,
        );

        const lineItems: { description: string; amount: number }[] = [];
        if (amounts.discountAmount > 0) {
          lineItems.push({
            description: `Survey Service — ${order.surveyType ?? "Land Survey"} (${order.orderNumber})`,
            amount: amounts.orderPrice,
          });
          lineItems.push({
            description: "Early Payment Discount (5%)",
            amount: -amounts.discountAmount,
          });
        } else {
          lineItems.push({
            description: `Survey Service — ${order.surveyType ?? "Land Survey"} (${order.orderNumber})`,
            amount: amounts.depositBase,
          });
        }
        if (amounts.processingFee > 0) {
          lineItems.push({
            description: "Credit Card Processing Fee (3%)",
            amount: amounts.processingFee,
          });
        }

        const qbInvoice = await createQBInvoice({
          customerRef: qbCustomerRef,
          billEmail: clientEmail,
          lineItems,
          allowCreditCard: body.paymentMethod === "credit_card",
          allowACH: body.paymentMethod === "ach",
        });

        await sendInvoice(qbInvoice.Id, clientEmail);
        const payNowUrl = await getInvoicePaymentUrl(qbInvoice.Id);

        const invoiceNumber = await getNextSequence("INV");
        const today = new Date();
        const subtotal =
          amounts.discountAmount > 0
            ? amounts.orderPrice
            : amounts.depositBase;

        const localInvoice = await prisma.invoice.create({
          data: {
            invoiceNumber,
            orderId: order.id,
            clientId: order.clientId!,
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
            quickbooksInvoiceId: qbInvoice.Id,
            syncStatus: SyncStatus.synced,
            notes: `Auto-created for order proposal ${order.orderNumber}`,
            invoiceLineItems: {
              create: lineItems.map((item, i) => ({
                description: item.description,
                quantity: 1,
                unitPrice: item.amount,
                amount: item.amount,
                sortOrder: i + 1,
              })),
            },
          },
          select: { id: true, invoiceNumber: true },
        });

        logger.info("Order proposal invoice created", {
          orderId: order.id,
          invoiceId: localInvoice.id,
          qbInvoiceId: qbInvoice.Id,
        });

        sendSuccess(
          res,
          {
            quickbooksInvoiceId: qbInvoice.Id,
            payNowUrl,
            invoice: {
              id: localInvoice.id,
              invoiceNumber: localInvoice.invoiceNumber,
              totalAmount: amounts.totalAmount,
              baseAmount: amounts.depositBase,
              processingFee: amounts.processingFee,
              taxAmount: 0,
            },
          },
          201,
        );
      } catch (err) {
        if (err instanceof ValidationError && /expired/i.test(err.message)) {
          res.status(410).json({
            error: { code: "TOKEN_EXPIRED", message: (err as Error).message },
          });
          return;
        }
        sendError(res, err);
      }
    },
  );

  return router;
}
