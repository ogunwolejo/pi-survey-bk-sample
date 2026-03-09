import { prisma } from "../lib/prisma";
import { NotFoundError } from "../lib/errors";
import { ChatEntityType, type Prisma } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { createSystemEvent as createChatSystemEvent } from "./chat.service";
import { quoteLogger as logger } from "../lib/logger";
import { getRushFeeSetting } from "./pricing-shared";

export interface RushFeeUpdateData {
  rushFeeApplied: boolean;
  rushFeeAmount?: number | null;
  rushFeeWaived: boolean;
  rushFeeWaivedReason?: string | null;
}

export async function updateRushFee(
  quoteId: string,
  data: RushFeeUpdateData,
  userId: string,
  userName: string,
  io?: SocketServer,
): Promise<object> {
  logger.info("Updating quote rush fee", { quoteId, userId, applied: data.rushFeeApplied, waived: data.rushFeeWaived });
  const existing = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: {
      id: true,
      quoteNumber: true,
      rushFeeApplied: true,
      rushFeeAmount: true,
      rushFeeWaived: true,
      rushFeeWaivedReason: true,
    },
  });

  if (!existing) throw new NotFoundError(`Quote ${quoteId} not found`);

  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: {
      rushFeeApplied: data.rushFeeApplied,
      rushFeeAmount: data.rushFeeAmount,
      rushFeeWaived: data.rushFeeWaived,
      rushFeeWaivedReason: data.rushFeeWaivedReason,
      updatedBy: userId,
    },
    select: {
      id: true,
      rushFeeApplied: true,
      rushFeeAmount: true,
      rushFeeWaived: true,
      rushFeeWaivedReason: true,
      updatedAt: true,
    },
  });

  const eventType = data.rushFeeWaived
    ? "rush_fee_waived"
    : data.rushFeeApplied
    ? "rush_fee_applied"
    : "rush_fee_removed";

  const rushFeeFallback = await getRushFeeSetting();
  const content = data.rushFeeWaived
    ? `Rush fee waived${data.rushFeeWaivedReason ? `: ${data.rushFeeWaivedReason}` : ""}`
    : data.rushFeeApplied
    ? `Rush fee applied: $${data.rushFeeAmount ?? rushFeeFallback}`
    : "Rush fee removed";

  const auditEntry = await prisma.entityAuditLog.create({
    data: {
      entityType: "quote",
      entityId: quoteId,
      entityNumber: existing.quoteNumber,
      action: "updated",
      userId,
      userName,
      changedAt: new Date(),
      changes: {
        rushFeeApplied: { old: existing.rushFeeApplied, new: data.rushFeeApplied },
        rushFeeWaived: { old: existing.rushFeeWaived, new: data.rushFeeWaived },
      } as Prisma.InputJsonValue,
      changeSummary: content,
      source: "web_portal",
    },
    include: { user: { select: { id: true, name: true } } },
  });

  io?.to(ROOM_PREFIXES.QUOTE(quoteId)).emit("quote:history:new", auditEntry);

  await createChatSystemEvent({
    entityType: ChatEntityType.quote,
    entityId: quoteId,
    eventType,
    content,
    userId,
    io,
  });

  return updated;
}
