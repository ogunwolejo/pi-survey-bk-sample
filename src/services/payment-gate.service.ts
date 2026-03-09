import type { Server as SocketServer } from "socket.io";
import { ChatEntityType, OrderStatus, JobStatus, AuditSource } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { canTransition } from "../lib/status-engine";
import { paymentLogger as logger } from "../lib/logger";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { emitDashboardEvent } from "../lib/socket-emitter";
import { notifyResearchLeader } from "./notification.service";
import { createSystemEvent as createChatSystemEvent } from "./chat.service";

const PAYMENT_TERMS_LABELS: Record<string, string> = {
  pre_pay: "Pre-Pay",
  fifty_fifty: "50/50",
  full_with_discount: "Full with Discount",
  post_closing: "After Completion",
};

export interface PaymentConditionResult {
  satisfied: boolean;
  totalPaid: number;
  baseAmount: number;
  percentage: number;
}

export interface PaymentInfo {
  status: "paid" | "partial" | "unpaid";
  amountPaid: number;
  totalAmount: number;
  percentage: number;
  paymentTermsLabel: string;
}

export async function evaluatePaymentCondition(
  orderId: string,
): Promise<PaymentConditionResult> {
  logger.info("Evaluating payment condition", { orderId });
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { price: true, paymentTerms: true, paymentRequired: true },
  });

  const terms = order.paymentTerms;
  const baseAmount = Number(order.price ?? 0);

  if (!order.paymentRequired || terms === "post_closing") {
    return { satisfied: true, totalPaid: 0, baseAmount, percentage: 0 };
  }

  const payments = await prisma.payment.aggregate({
    where: { orderId },
    _sum: { baseAmount: true },
  });
  const totalPaid = Number(payments._sum.baseAmount ?? 0);
  const percentage = baseAmount > 0 ? Math.round((totalPaid / baseAmount) * 100) : 0;

  let threshold: number;
  if (terms === "fifty_fifty") {
    threshold = baseAmount * 0.5;
  } else {
    threshold = baseAmount;
  }

  return {
    satisfied: totalPaid >= threshold,
    totalPaid,
    baseAmount,
    percentage: Math.min(percentage, 100),
  };
}

export async function tryTransitionToResearchQueued(
  orderId: string,
  userId: string | null,
  userName: string | null,
  io: SocketServer | undefined,
): Promise<boolean> {
  logger.info("[PaymentGate] Evaluating auto-transition to research_queued", { orderId, userId });
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { client: { select: { firstName: true, lastName: true } } },
  });

  if (!order || order.deletedAt) return false;

  const eligible =
    order.status === OrderStatus.pending_payment ||
    order.status === OrderStatus.pending_contract;

  if (!eligible) return false;
  if (!canTransition("order", order.status, OrderStatus.research_queued)) return false;

  const signatureCount = await prisma.orderContractSignature.count({
    where: { orderId },
  });
  if (signatureCount === 0) return false;

  const paymentResult = await evaluatePaymentCondition(orderId);
  if (!paymentResult.satisfied) return false;

  const previousStatus = order.status;

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.research_queued, updatedBy: userId },
    });

    await tx.entityAuditLog.create({
      data: {
        entityType: "orders",
        entityId: orderId,
        entityNumber: order.orderNumber,
        action: "updated",
        userId,
        userName: userName ?? "system",
        changedAt: new Date(),
        changeSummary: `Auto-transition to research_queued (payment: ${paymentResult.percentage}% paid, proposal signed)`,
        changes: { status: { old: previousStatus, new: "research_queued" } },
        source: AuditSource.web_portal,
      },
    });
  });

  await createChatSystemEvent({
    entityType: ChatEntityType.order,
    entityId: orderId,
    eventType: "order_research_queued",
    content: "Order automatically transitioned to Research Queued (payment + signature conditions met)",
    metadata: {
      previousStatus,
      totalPaid: paymentResult.totalPaid,
      percentage: paymentResult.percentage,
    },
    userId: userId ?? undefined,
    io,
  });

  io?.to(ROOM_PREFIXES.ORDER(orderId)).emit("order:status_changed", {
    orderId,
    status: OrderStatus.research_queued,
    orderNumber: order.orderNumber,
  });
  emitDashboardEvent(io, "dashboard:orders", "order:updated", {
    orderId,
    status: OrderStatus.research_queued,
  });

  const clientName = order.client
    ? `${order.client.firstName} ${order.client.lastName}`
    : "Unknown";
  notifyResearchLeader(order, clientName, io).catch(() => {});

  logger.info("[PaymentGate] Order auto-transitioned to research_queued", {
    orderId,
    orderNumber: order.orderNumber,
    previousStatus,
    paymentPercentage: paymentResult.percentage,
  });

  return true;
}

export async function computePaymentInfo(orderId: string): Promise<PaymentInfo> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { price: true, paymentTerms: true },
  });

  const totalAmount = Number(order.price ?? 0);
  const termsLabel = PAYMENT_TERMS_LABELS[order.paymentTerms ?? ""] ?? "—";

  const payments = await prisma.payment.aggregate({
    where: { orderId },
    _sum: { baseAmount: true },
  });
  const amountPaid = Number(payments._sum.baseAmount ?? 0);
  const percentage = totalAmount > 0 ? Math.min(Math.round((amountPaid / totalAmount) * 100), 100) : 0;

  let status: "paid" | "partial" | "unpaid";
  if (amountPaid <= 0) {
    status = "unpaid";
  } else if (percentage >= 100) {
    status = "paid";
  } else {
    status = "partial";
  }

  return { status, amountPaid, totalAmount, percentage, paymentTermsLabel: termsLabel };
}

export async function computePaymentInfoBatch(
  orderIds: string[],
): Promise<Map<string, PaymentInfo>> {
  if (orderIds.length === 0) return new Map();

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, price: true, paymentTerms: true },
  });

  const paymentAgg = await prisma.payment.groupBy({
    by: ["orderId"],
    where: { orderId: { in: orderIds } },
    _sum: { baseAmount: true },
  });

  const paymentMap = new Map<string, number>();
  for (const agg of paymentAgg) {
    if (agg.orderId) {
      paymentMap.set(agg.orderId, Number(agg._sum.baseAmount ?? 0));
    }
  }

  const result = new Map<string, PaymentInfo>();
  for (const order of orders) {
    const totalAmount = Number(order.price ?? 0);
    const amountPaid = paymentMap.get(order.id) ?? 0;
    const percentage = totalAmount > 0 ? Math.min(Math.round((amountPaid / totalAmount) * 100), 100) : 0;
    const termsLabel = PAYMENT_TERMS_LABELS[order.paymentTerms ?? ""] ?? "—";

    let status: "paid" | "partial" | "unpaid";
    if (amountPaid <= 0) {
      status = "unpaid";
    } else if (percentage >= 100) {
      status = "paid";
    } else {
      status = "partial";
    }

    result.set(order.id, { status, amountPaid, totalAmount, percentage, paymentTermsLabel: termsLabel });
  }

  return result;
}

// ─── Payment Collection Eligibility ──────────────────────────────────────────

const ELIGIBLE_JOB_STATUSES: Set<JobStatus> = new Set([
  JobStatus.field_complete,
  JobStatus.ready_for_drafting,
  JobStatus.drafting,
  JobStatus.drafted,
  JobStatus.pls_review,
  JobStatus.awaiting_corrections,
  JobStatus.ready_for_delivery,
  JobStatus.complete,
]);

export interface CollectionEligibility {
  eligible: boolean;
  reason?: string;
}

export async function canCollectPayment(
  orderId: string,
): Promise<CollectionEligibility> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { price: true, balanceRemaining: true },
  });

  if (!order) return { eligible: false, reason: "Order not found" };
  if (!order.price || Number(order.price) <= 0) {
    return { eligible: false, reason: "Order has no price set" };
  }
  if (Number(order.balanceRemaining) <= 0) {
    return { eligible: false, reason: "Order is fully paid" };
  }

  const jobs = await prisma.job.findMany({
    where: { orderId },
    select: { status: true },
  });

  const hasEligibleJob = jobs.some((j) => ELIGIBLE_JOB_STATUSES.has(j.status));
  if (!hasEligibleJob) {
    return {
      eligible: false,
      reason: "No jobs have reached field_complete status",
    };
  }

  return { eligible: true };
}
