import { prisma } from "../lib/prisma";
import { NotFoundError, ValidationError } from "../lib/errors";
import { ChatEntityType, type Prisma } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { orderLogger as logger } from "../lib/logger";
import { getRushFeeSetting } from "./pricing-shared";
import { createSystemEvent as createChatSystemEvent } from "./chat.service";

export interface RushFeeUpdateData {
  isRush: boolean;
  rushFeeAmount?: number | null;
  rushFeeWaived: boolean;
  rushFeeWaivedReason?: string | null;
}

export async function updateRushFee(
  orderId: string,
  data: RushFeeUpdateData,
  userId: string,
  userName: string,
  io?: SocketServer,
): Promise<object> {
  logger.info("Updating order rush fee", { orderId, userId, isRush: data.isRush, waived: data.rushFeeWaived });
  const existing = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      quoteId: true,
      isRush: true,
      rushFeeAmount: true,
      rushFeeWaived: true,
      rushFeeWaivedReason: true,
    },
  });

  if (!existing) throw new NotFoundError(`Order ${orderId} not found`);
  if (existing.quoteId) throw new ValidationError("Rush fee cannot be managed on orders linked to a quote");

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      isRush: data.isRush,
      rushFeeAmount: data.rushFeeAmount,
      rushFeeWaived: data.rushFeeWaived,
      rushFeeWaivedReason: data.rushFeeWaivedReason,
      updatedBy: userId,
    },
    select: {
      id: true,
      isRush: true,
      rushFeeAmount: true,
      rushFeeWaived: true,
      rushFeeWaivedReason: true,
      updatedAt: true,
    },
  });

  const eventType = data.rushFeeWaived
    ? "rush_fee_waived"
    : data.isRush
    ? "rush_fee_applied"
    : "rush_fee_removed";

  const rushFeeFallback = await getRushFeeSetting();
  const content = data.rushFeeWaived
    ? `Rush fee waived${data.rushFeeWaivedReason ? `: ${data.rushFeeWaivedReason}` : ""}`
    : data.isRush
    ? `Rush fee applied: $${data.rushFeeAmount ?? rushFeeFallback}`
    : "Rush fee removed";

  const auditEntry = await prisma.entityAuditLog.create({
    data: {
      entityType: "order",
      entityId: orderId,
      entityNumber: existing.orderNumber,
      action: "updated",
      userId,
      userName,
      changedAt: new Date(),
      changes: {
        isRush: { old: existing.isRush, new: data.isRush },
        rushFeeWaived: { old: existing.rushFeeWaived, new: data.rushFeeWaived },
      } as Prisma.InputJsonValue,
      changeSummary: content,
      source: "web_portal",
    },
    include: { user: { select: { id: true, name: true } } },
  });

  io?.to(ROOM_PREFIXES.ORDER(orderId)).emit("order:history:new", auditEntry);

  await createChatSystemEvent({
    entityType: ChatEntityType.order,
    entityId: orderId,
    eventType,
    content,
    userId,
    io,
  });

  return updated;
}
