import { prisma } from "../lib/prisma";
import { NotFoundError } from "../lib/errors";
import { humanizeChangeSummary } from "../lib/field-labels";
import { quoteLogger as logger } from "../lib/logger";
import { ChatEntityType, type Prisma, type LotShape, type DrivewayType, type WaterFeatures, type VegetationDensity, type SubdivisionStatus } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { createSystemEvent as createChatSystemEvent } from "./chat.service";

export interface ResearchUpdateData {
  lotSizeAcres?: number | null;
  lotShape?: string | null;
  drivewayType?: string | null;
  waterFeatures?: string | null;
  vegetationDensity?: string | null;
  subdivisionStatus?: string | null;
  structuresOnProperty?: string[];
  structuresOther?: string | null;
  accessIssues?: string | null;
}

export async function updateResearch(
  quoteId: string,
  data: ResearchUpdateData,
  userId: string,
  userName: string,
  io?: SocketServer,
): Promise<object> {
  logger.info("Updating quote research", { quoteId, userId, fields: Object.keys(data) });
  const existing = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: {
      id: true,
      quoteNumber: true,
      lotSizeAcres: true,
      lotShape: true,
      drivewayType: true,
      waterFeatures: true,
      vegetationDensity: true,
      subdivisionStatus: true,
      structuresOnProperty: true,
      structuresOther: true,
      accessIssues: true,
    },
  });

  if (!existing) throw new NotFoundError(`Quote ${quoteId} not found`);

  const changes: Record<string, { old: unknown; new: unknown }> = {};
  const updateData: Prisma.QuoteUncheckedUpdateInput = { updatedBy: userId };

  if (data.lotSizeAcres !== undefined && String(data.lotSizeAcres) !== String(existing.lotSizeAcres)) {
    changes["lotSizeAcres"] = { old: existing.lotSizeAcres, new: data.lotSizeAcres };
    updateData.lotSizeAcres = data.lotSizeAcres;
  }
  if (data.lotShape !== undefined && data.lotShape !== existing.lotShape) {
    changes["lotShape"] = { old: existing.lotShape, new: data.lotShape };
    updateData.lotShape = data.lotShape as unknown as LotShape | null;
  }
  if (data.drivewayType !== undefined && data.drivewayType !== existing.drivewayType) {
    changes["drivewayType"] = { old: existing.drivewayType, new: data.drivewayType };
    updateData.drivewayType = data.drivewayType as unknown as DrivewayType | null;
  }
  if (data.waterFeatures !== undefined && data.waterFeatures !== existing.waterFeatures) {
    changes["waterFeatures"] = { old: existing.waterFeatures, new: data.waterFeatures };
    updateData.waterFeatures = data.waterFeatures as unknown as WaterFeatures | null;
  }
  if (data.vegetationDensity !== undefined && data.vegetationDensity !== existing.vegetationDensity) {
    changes["vegetationDensity"] = { old: existing.vegetationDensity, new: data.vegetationDensity };
    updateData.vegetationDensity = data.vegetationDensity as unknown as VegetationDensity | null;
  }
  if (data.subdivisionStatus !== undefined && data.subdivisionStatus !== existing.subdivisionStatus) {
    changes["subdivisionStatus"] = { old: existing.subdivisionStatus, new: data.subdivisionStatus };
    updateData.subdivisionStatus = data.subdivisionStatus as unknown as SubdivisionStatus | null;
  }
  if (data.structuresOnProperty !== undefined) {
    changes["structuresOnProperty"] = { old: existing.structuresOnProperty, new: data.structuresOnProperty };
    updateData.structuresOnProperty = { set: data.structuresOnProperty };
  }
  if (data.structuresOther !== undefined && data.structuresOther !== existing.structuresOther) {
    changes["structuresOther"] = { old: existing.structuresOther, new: data.structuresOther };
    updateData.structuresOther = data.structuresOther;
  }
  if (data.accessIssues !== undefined && data.accessIssues !== existing.accessIssues) {
    changes["accessIssues"] = { old: existing.accessIssues, new: data.accessIssues };
    updateData.accessIssues = data.accessIssues;
  }

  if (Object.keys(changes).length === 0) {
    return existing;
  }

  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: updateData,
    select: {
      id: true,
      lotSizeAcres: true,
      lotShape: true,
      drivewayType: true,
      waterFeatures: true,
      vegetationDensity: true,
      subdivisionStatus: true,
      structuresOnProperty: true,
      structuresOther: true,
      accessIssues: true,
      updatedAt: true,
      updatedBy: true,
    },
  });

  const changeSummary = humanizeChangeSummary(changes, "Updated property research");

  const auditEntry = await prisma.entityAuditLog.create({
    data: {
      entityType: "quote",
      entityId: quoteId,
      entityNumber: existing.quoteNumber,
      action: "updated",
      userId,
      userName,
      changedAt: new Date(),
      changes: changes as Prisma.InputJsonValue,
      changeSummary,
      source: "web_portal",
    },
    include: { user: { select: { id: true, name: true } } },
  });

  io?.to(ROOM_PREFIXES.QUOTE(quoteId)).emit("quote:history:new", auditEntry);

  await createChatSystemEvent({
    entityType: ChatEntityType.quote,
    entityId: quoteId,
    eventType: "research_update",
    content: changeSummary,
    metadata: { fields: Object.keys(changes) },
    userId,
    io,
  });

  return updated;
}
