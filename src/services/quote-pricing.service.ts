import { prisma } from "../lib/prisma";
import { NotFoundError } from "../lib/errors";
import { ChatEntityType, type Prisma } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { quoteLogger as logger } from "../lib/logger";
import { createSystemEvent as createChatSystemEvent } from "./chat.service";
import {
  COUNTY_BASE_PRICES,
  DEFAULT_BASE_PRICE,
  buildDefaultLineItems,
  getRushFeeSetting,
  type PriceBreakdown,
  type PriceLineItem,
  type ManualPriceInput,
} from "./pricing-shared";

export type { PriceBreakdown, PriceLineItem, ManualPriceInput };

export interface GeneratePriceResult {
  breakdown: PriceBreakdown;
  quote: {
    id: string;
    price: number;
    basePriceAtCreation: number;
    updatedAt: Date;
  };
}

export async function previewPrice(quoteId: string): Promise<PriceBreakdown & { saved: boolean }> {
  logger.info("Previewing quote price", { quoteId });
  const existing = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: {
      propertyCounty: true,
      lotSizeAcres: true,
      lotShape: true,
      drivewayType: true,
      waterFeatures: true,
      vegetationDensity: true,
      subdivisionStatus: true,
      structuresOnProperty: true,
      accessIssues: true,
      rushFeeApplied: true,
      rushFeeAmount: true,
      rushFeeWaived: true,
      priority: true,
      priceBreakdown: true,
    },
  });

  if (!existing) throw new NotFoundError(`Quote ${quoteId} not found`);

  if (existing.priceBreakdown) {
    const saved = existing.priceBreakdown as unknown as PriceBreakdown;
    return { ...saved, saved: true };
  }

  const county = existing.propertyCounty?.toLowerCase();
  const basePrice = county ? (COUNTY_BASE_PRICES[county] ?? DEFAULT_BASE_PRICE) : DEFAULT_BASE_PRICE;
  const lineItems = buildDefaultLineItems(existing);

  const rushFeeSetting = await getRushFeeSetting();
  const isRush = existing.priority === "urgent" || existing.priority === "high";
  const rushFee = (existing.rushFeeApplied && !existing.rushFeeWaived)
    ? Number(existing.rushFeeAmount ?? rushFeeSetting)
    : isRush ? rushFeeSetting : 0;

  return {
    basePrice,
    lineItems,
    rushFee,
    totalPrice: basePrice + rushFee,
    saved: false,
  };
}

export async function generatePrice(
  quoteId: string,
  userId: string,
  userName: string,
  input: ManualPriceInput,
  io?: SocketServer,
): Promise<GeneratePriceResult> {
  logger.info("Generating quote price", { quoteId, userId, basePrice: input.basePrice, rushFee: input.rushFee });
  const existing = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: {
      id: true,
      quoteNumber: true,
      price: true,
      basePriceAtCreation: true,
    },
  });

  if (!existing) throw new NotFoundError(`Quote ${quoteId} not found`);

  const adjustmentTotal = input.lineItems.reduce((sum, item) => sum + item.amount, 0);
  const totalPrice = input.basePrice + adjustmentTotal + input.rushFee;

  const breakdown: PriceBreakdown = {
    basePrice: input.basePrice,
    lineItems: input.lineItems,
    rushFee: input.rushFee,
    totalPrice,
  };

  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: {
      price: totalPrice,
      priceBreakdown: breakdown as unknown as Prisma.InputJsonValue,
      priceOverrideReason: null,
      updatedBy: userId,
    },
    select: {
      id: true,
      price: true,
      basePriceAtCreation: true,
      updatedAt: true,
    },
  });

  const oldPrice = Number(existing.price);

  const adjustmentSummary = input.lineItems
    .filter((li) => li.amount > 0)
    .map((li) => `${li.label}: +$${li.amount.toFixed(2)}`)
    .join(", ");

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
        price: { old: oldPrice, new: totalPrice },
        breakdown,
      } as unknown as Prisma.InputJsonValue,
      changeSummary: `Quote price ${oldPrice > 0 ? "updated" : "generated"}: $${oldPrice.toFixed(2)} → $${totalPrice.toFixed(2)}`,
      source: "web_portal",
    },
    include: { user: { select: { id: true, name: true } } },
  });

  io?.to(ROOM_PREFIXES.QUOTE(quoteId)).emit("quote:history:new", auditEntry);

  await createChatSystemEvent({
    entityType: ChatEntityType.quote,
    entityId: quoteId,
    eventType: "price_generated",
    content: `Quote price ${oldPrice > 0 ? "updated" : "generated"}: $${totalPrice.toFixed(2)} (base $${input.basePrice.toFixed(2)}${adjustmentSummary ? `, ${adjustmentSummary}` : ""}${input.rushFee > 0 ? `, rush +$${input.rushFee.toFixed(2)}` : ""})`,
    metadata: { breakdown },
    userId,
    io,
  });

  return {
    breakdown,
    quote: {
      id: updated.id,
      price: Number(updated.price),
      basePriceAtCreation: Number(updated.basePriceAtCreation),
      updatedAt: updated.updatedAt,
    },
  };
}
