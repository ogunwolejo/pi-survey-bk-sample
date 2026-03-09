import { prisma } from "../lib/prisma";
import { NotFoundError } from "../lib/errors";
import { ChatEntityType, type Prisma } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { createSystemEvent as createChatSystemEvent } from "./chat.service";
import { quoteLogger as logger } from "../lib/logger";

export interface AltaTableASelections {
  items: Record<string, boolean>;
  item19InsuranceAmount?: number;
  customItems?: Array<{ id: string; description: string; selected: boolean }>;
  notes?: string;
}

export interface AltaUpdateData {
  altaTableASelections: AltaTableASelections;
}

export async function updateAltaTableA(
  quoteId: string,
  data: AltaUpdateData,
  userId: string,
  userName: string,
  io?: SocketServer,
): Promise<object> {
  logger.info("Updating ALTA Table A selections", { quoteId, userId });
  const existing = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { id: true, quoteNumber: true, altaTableASelections: true },
  });

  if (!existing) throw new NotFoundError(`Quote ${quoteId} not found`);

  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: {
      altaTableASelections: data.altaTableASelections as unknown as Prisma.InputJsonValue,
      updatedBy: userId,
    },
    select: {
      id: true,
      altaTableASelections: true,
      updatedAt: true,
    },
  });

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
        altaTableASelections: {
          old: existing.altaTableASelections,
          new: data.altaTableASelections,
        },
      } as unknown as Prisma.InputJsonValue,
      changeSummary: "Updated ALTA Table A selections",
      source: "web_portal",
    },
    include: { user: { select: { id: true, name: true } } },
  });

  io?.to(ROOM_PREFIXES.QUOTE(quoteId)).emit("quote:history:new", auditEntry);

  await createChatSystemEvent({
    entityType: ChatEntityType.quote,
    entityId: quoteId,
    eventType: "field_update",
    content: "Updated ALTA/NSPS Table A selections",
    userId,
    io,
  });

  return updated;
}

export interface PreferenceFormAction {
  action: "sent" | "received";
}

export async function updatePreferenceForm(
  quoteId: string,
  data: PreferenceFormAction,
  userId: string,
  userName: string,
  io?: SocketServer,
): Promise<object> {
  const existing = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { id: true, quoteNumber: true },
  });

  if (!existing) throw new NotFoundError(`Quote ${quoteId} not found`);

  const now = new Date();
  const updateData: Prisma.QuoteUncheckedUpdateInput =
    data.action === "sent"
      ? { preferenceFormSentAt: now, updatedBy: userId }
      : { preferenceFormReceivedAt: now, updatedBy: userId };

  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: updateData,
    select: {
      id: true,
      preferenceFormSentAt: true,
      preferenceFormReceivedAt: true,
      updatedAt: true,
    },
  });

  const eventType =
    data.action === "sent" ? "preference_form_sent" : "preference_form_received";
  const content =
    data.action === "sent"
      ? "Preference form / Table A checklist sent to client"
      : "Client returned preference form / Table A checklist";

  const prefAudit = await prisma.entityAuditLog.create({
    data: {
      entityType: "quote",
      entityId: quoteId,
      entityNumber: existing.quoteNumber,
      action: "updated",
      userId,
      userName,
      changedAt: now,
      changes: { action: data.action } as Prisma.InputJsonValue,
      changeSummary: content,
      source: "web_portal",
    },
    include: { user: { select: { id: true, name: true } } },
  });

  io?.to(ROOM_PREFIXES.QUOTE(quoteId)).emit("quote:history:new", prefAudit);

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
