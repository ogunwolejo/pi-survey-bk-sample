import { v4 as uuidv4 } from "uuid";
import { addDays } from "date-fns";
import { ChatEntityType, OrderStatus, type PaymentTerms } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { prisma } from "../lib/prisma";
import { withTransaction } from "../lib/transaction";
import { orderLogger as logger } from "../lib/logger";
import { envStore } from "../env-store";
import { NotFoundError, ValidationError, ConflictError } from "../lib/errors";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import {
  detectPaymentRequirement,
  type PaymentDetectionResult,
} from "./payment-detection.service";
import {
  fireUnifiedEvent,
  CustomerIoEventsNames,
} from "./customerio.service";
import { createSystemEvent as createChatSystemEvent } from "./chat.service";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PaymentOverrides {
  paymentRequired?: boolean;
  paymentTerms?: string;
  depositPercentage?: number;
}

interface SendOrderToClientOptions {
  orderId: string;
  userId: string;
  userName: string;
  overrides?: PaymentOverrides;
  io?: SocketServer;
}

const TOKEN_EXPIRY_DAYS = 30;
const CARD_FEE_RATE = 0.03;

// ─── Payment Detection ───────────────────────────────────────────────────────

export function resolveOrderPaymentRequirement(
  order: {
    price: unknown;
    customerType: string | null;
    paymentTerms: string | null;
    surveyType: string | null;
  },
  overrides?: PaymentOverrides,
): PaymentDetectionResult {
  const orderPrice = Number(order.price);

  const auto = detectPaymentRequirement({
    customerType: order.customerType ?? "homeowner",
    paymentTerms: order.paymentTerms,
    quotePrice: orderPrice,
    quoteCustomerType: order.customerType,
    surveyType: order.surveyType,
  });

  if (overrides?.paymentRequired === undefined) return auto;

  const required = overrides.paymentRequired;
  const pct = required
    ? (overrides.depositPercentage ?? auto.depositPercentage)
    : 0;

  return {
    paymentRequired: required,
    paymentTerms: overrides.paymentTerms ?? auto.paymentTerms,
    depositPercentage: pct,
    depositAmount: Math.round(orderPrice * (pct / 100) * 100) / 100,
    reason: "Manual override",
    needsSelection: false,
    detectionSource: "client_customer_type" as const,
  };
}

// ─── Token Helpers ───────────────────────────────────────────────────────────

export async function createOrderToken(
  orderId: string,
  expiresInDays = TOKEN_EXPIRY_DAYS,
) {
  return prisma.orderToken.create({
    data: {
      token: uuidv4(),
      orderId,
      tokenType: "proposal",
      expiresAt: addDays(new Date(), expiresInDays),
    },
  });
}

export async function loadAndValidateOrderToken(token: string) {
  const tokenRecord = await prisma.orderToken.findUnique({
    where: { token },
    include: {
      order: { include: { client: true } },
    },
  });

  if (!tokenRecord) {
    throw new NotFoundError("Order proposal link not found");
  }
  if (tokenRecord.expiresAt < new Date()) {
    throw new ValidationError("This order proposal link has expired");
  }

  const order = tokenRecord.order;
  if (!order || order.deletedAt) {
    throw new NotFoundError("Order not found");
  }

  return tokenRecord;
}

// ─── Address Helpers ──────────────────────────────────────────────────────────

function formatPropertyAddress(order: {
  propertyAddressLine1: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
}): string {
  return [order.propertyAddressLine1, order.propertyCity, order.propertyState]
    .filter(Boolean)
    .join(", ");
}

// ─── Send Order to Client ────────────────────────────────────────────────────

export async function sendOrderToClient(
  opts: SendOrderToClientOptions,
): Promise<object> {
  logger.info("Sending order to client", { orderId: opts.orderId, userId: opts.userId, hasOverrides: !!opts.overrides });
  const order = await prisma.order.findUnique({
    where: { id: opts.orderId },
    include: { client: true },
  });

  if (!order || order.deletedAt) {
    throw new NotFoundError(`Order ${opts.orderId} not found`);
  }
  if (order.quoteId) {
    throw new ValidationError("Cannot send to client — order is linked to a quote");
  }
  if (order.status !== OrderStatus.pending_review) {
    throw new ConflictError(
      `Order must be in 'pending_review' status (current: ${order.status})`,
    );
  }
  if (Number(order.price) <= 0) {
    throw new ValidationError("Order price must be greater than 0");
  }
  if (!order.client?.email) {
    throw new ValidationError("Order must have a client with an email address");
  }

  const detection = resolveOrderPaymentRequirement(
    {
      price: order.price,
      customerType: order.customerType,
      paymentTerms: order.paymentTerms,
      surveyType: order.surveyType,
    },
    opts.overrides,
  );

  const { updated, token } = await withTransaction(async (tx) => {
    const fresh = await tx.order.findUniqueOrThrow({
      where: { id: opts.orderId },
      select: { status: true },
    });
    if (fresh.status !== OrderStatus.pending_review) {
      throw new ConflictError("Order is no longer in 'pending_review' status");
    }

    const tk = await tx.orderToken.create({
      data: {
        token: uuidv4(),
        orderId: opts.orderId,
        tokenType: "proposal",
        expiresAt: addDays(new Date(), TOKEN_EXPIRY_DAYS),
      },
    });

    const upd = await tx.order.update({
      where: { id: opts.orderId },
      data: {
        status: OrderStatus.pending_contract,
        paymentRequired: detection.paymentRequired,
        paymentRequiredReason: detection.reason,
        paymentTerms: (detection.paymentTerms as PaymentTerms) ?? undefined,
        updatedBy: opts.userId,
      },
    });

    return { updated: upd, token: tk };
  }, "Serializable");

  await createChatSystemEvent({
    entityType: ChatEntityType.order,
    entityId: opts.orderId,
    eventType: "order_sent_to_client",
    content: `${opts.userName} sent order to client`,
    metadata: {
      paymentRequired: detection.paymentRequired,
      paymentTerms: detection.paymentTerms,
    },
    userId: opts.userId,
    io: opts.io,
  });

  const tokenUrl = `${envStore.FRONTEND_URL}/order-proposal/${token.token}`;
  const clientName = [order.client.firstName, order.client.lastName]
    .filter(Boolean)
    .join(" ");
  const propertyAddress = formatPropertyAddress(order);

  fireUnifiedEvent({
    contactId: order.clientId ?? order.id,
    identifyAttributes: {
      email: order.client.email,
      first_name: order.client.firstName,
      last_name: order.client.lastName,
    },
    unifiedEventName: CustomerIoEventsNames.PROPOSAL_SENT,
    legacyEventName: CustomerIoEventsNames.ORDER_PROPOSAL_SENT,
    attributes: {
      source_type: "order",
      source_id: order.id,
      source_number: order.orderNumber,
      client_name: clientName,
      client_email: order.client.email,
      property_address: propertyAddress,
      amount: String(Number(order.price)),
      payment_terms: detection.paymentTerms,
      payment_required: detection.paymentRequired,
      proposal_url: tokenUrl,
      card_fee_rate: `${CARD_FEE_RATE * 100}%`,
      ach_fee_rate: "0%",
    },
  });

  if (opts.io) {
    opts.io.to(ROOM_PREFIXES.ORDER(opts.orderId)).emit("order:status_changed", {
      orderId: opts.orderId,
      status: updated.status,
      orderNumber: updated.orderNumber,
    });
  }

  logger.info("Order sent to client", {
    orderId: opts.orderId,
    tokenId: token.id,
  });

  return {
    order: {
      id: updated.id,
      orderNumber: updated.orderNumber,
      status: updated.status,
    },
    orderToken: { id: token.id, token: token.token },
    paymentDetection: {
      autoDetected: opts.overrides?.paymentRequired === undefined,
      reason: detection.reason,
      paymentTerms: detection.paymentTerms,
      depositPercentage: detection.depositPercentage,
    },
  };
}

// ─── Resend Order to Client ──────────────────────────────────────────────────

export async function resendOrderToClient(
  opts: SendOrderToClientOptions,
): Promise<object> {
  logger.info("Resending order to client", { orderId: opts.orderId, userId: opts.userId });
  const order = await prisma.order.findUnique({
    where: { id: opts.orderId },
    include: { client: true },
  });

  if (!order || order.deletedAt) {
    throw new NotFoundError(`Order ${opts.orderId} not found`);
  }
  if (order.quoteId) {
    throw new ValidationError("Cannot resend — order is linked to a quote");
  }
  if (order.status !== OrderStatus.pending_contract) {
    throw new ConflictError(
      `Order must be in 'pending_contract' status to resend (current: ${order.status})`,
    );
  }
  if (Number(order.price) <= 0) {
    throw new ValidationError("Order price must be greater than 0");
  }
  if (!order.client?.email) {
    throw new ValidationError("Order must have a client with an email address");
  }

  const detection = resolveOrderPaymentRequirement(
    {
      price: order.price,
      customerType: order.customerType,
      paymentTerms: order.paymentTerms,
      surveyType: order.surveyType,
    },
    opts.overrides,
  );

  const token = await withTransaction(async (tx) => {
    const fresh = await tx.order.findUniqueOrThrow({
      where: { id: opts.orderId },
      select: { status: true },
    });
    if (fresh.status !== OrderStatus.pending_contract) {
      throw new ConflictError("Order is no longer in 'pending_contract' status");
    }

    await tx.orderToken.updateMany({
      where: { orderId: opts.orderId, tokenType: "proposal", usedAt: null },
      data: { usedAt: new Date() },
    });

    const tk = await tx.orderToken.create({
      data: {
        token: uuidv4(),
        orderId: opts.orderId,
        tokenType: "proposal",
        expiresAt: addDays(new Date(), TOKEN_EXPIRY_DAYS),
      },
    });

    await tx.order.update({
      where: { id: opts.orderId },
      data: {
        paymentRequired: detection.paymentRequired,
        paymentRequiredReason: detection.reason,
        paymentTerms: (detection.paymentTerms as PaymentTerms) ?? undefined,
        updatedBy: opts.userId,
      },
    });

    return tk;
  }, "Serializable");

  await createChatSystemEvent({
    entityType: ChatEntityType.order,
    entityId: opts.orderId,
    eventType: "order_resent_to_client",
    content: `${opts.userName} resent order proposal to client`,
    metadata: {
      paymentRequired: detection.paymentRequired,
      paymentTerms: detection.paymentTerms,
    },
    userId: opts.userId,
    io: opts.io,
  });

  const tokenUrl = `${envStore.FRONTEND_URL}/order-proposal/${token.token}`;
  const clientName = [order.client.firstName, order.client.lastName]
    .filter(Boolean)
    .join(" ");
  const propertyAddress = formatPropertyAddress(order);

  fireUnifiedEvent({
    contactId: order.clientId ?? order.id,
    identifyAttributes: {
      email: order.client.email,
      first_name: order.client.firstName,
      last_name: order.client.lastName,
    },
    unifiedEventName: CustomerIoEventsNames.PROPOSAL_SENT,
    legacyEventName: CustomerIoEventsNames.ORDER_PROPOSAL_SENT,
    attributes: {
      source_type: "order",
      source_id: order.id,
      source_number: order.orderNumber,
      client_name: clientName,
      client_email: order.client.email,
      property_address: propertyAddress,
      amount: String(Number(order.price)),
      payment_terms: detection.paymentTerms,
      payment_required: detection.paymentRequired,
      proposal_url: tokenUrl,
      card_fee_rate: `${CARD_FEE_RATE * 100}%`,
      ach_fee_rate: "0%",
    },
  });

  if (opts.io) {
    opts.io.to(ROOM_PREFIXES.ORDER(opts.orderId)).emit("order:resent_to_client", {
      orderId: opts.orderId,
      orderNumber: order.orderNumber,
    });
  }

  logger.info("Order resent to client", {
    orderId: opts.orderId,
    tokenId: token.id,
  });

  return {
    order: { id: order.id, orderNumber: order.orderNumber, status: order.status },
    orderToken: { id: token.id, token: token.token },
    paymentDetection: {
      autoDetected: opts.overrides?.paymentRequired === undefined,
      reason: detection.reason,
      paymentTerms: detection.paymentTerms,
      depositPercentage: detection.depositPercentage,
    },
  };
}
