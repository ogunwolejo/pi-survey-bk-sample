import { prisma } from "../lib/prisma";
import { NotFoundError, ValidationError } from "../lib/errors";
import { ChatEntityType, type Prisma } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { createSystemEvent as createChatSystemEvent } from "./chat.service";
import { orderLogger as logger } from "../lib/logger";
import {
  COUNTY_BASE_PRICES,
  DEFAULT_BASE_PRICE,
  buildDefaultLineItems,
  getRushFeeSetting,
  type PriceBreakdown,
  type ManualPriceInput,
} from "./pricing-shared";

export interface GeneratePriceResult {
  breakdown: PriceBreakdown;
  order: {
    id: string;
    price: number;
    basePriceAtCreation: number;
    updatedAt: Date;
  };
}

export async function previewPrice(orderId: string): Promise<PriceBreakdown & { saved: boolean }> {
  logger.info("Previewing order price", { orderId });
  const existing = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      quoteId: true,
      propertyCounty: true,
      lotSizeAcres: true,
      lotShape: true,
      drivewayType: true,
      waterFeatures: true,
      vegetationDensity: true,
      subdivisionStatus: true,
      structuresOnProperty: true,
      accessIssues: true,
      isRush: true,
      rushFeeAmount: true,
      rushFeeWaived: true,
      priority: true,
      priceBreakdown: true,
    },
  });

  if (!existing) throw new NotFoundError(`Order ${orderId} not found`);
  if (existing.quoteId) throw new ValidationError("Pricing cannot be managed on orders linked to a quote");

  if (existing.priceBreakdown) {
    const saved = existing.priceBreakdown as unknown as PriceBreakdown;
    return { ...saved, saved: true };
  }

  const county = existing.propertyCounty?.toLowerCase();
  const basePrice = county ? (COUNTY_BASE_PRICES[county] ?? DEFAULT_BASE_PRICE) : DEFAULT_BASE_PRICE;
  const lineItems = buildDefaultLineItems(existing);

  const rushFeeSetting = await getRushFeeSetting();
  const isRush = existing.priority === "urgent" || existing.priority === "high";
  const rushFee = (existing.isRush && !existing.rushFeeWaived)
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
  orderId: string,
  userId: string,
  userName: string,
  input: ManualPriceInput,
  io?: SocketServer,
): Promise<GeneratePriceResult> {
  logger.info("Generating order price", { orderId, userId, basePrice: input.basePrice, rushFee: input.rushFee });
  const existing = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      quoteId: true,
      price: true,
      basePriceAtCreation: true,
    },
  });

  if (!existing) throw new NotFoundError(`Order ${orderId} not found`);
  if (existing.quoteId) throw new ValidationError("Pricing cannot be managed on orders linked to a quote");

  const adjustmentTotal = input.lineItems.reduce((sum, item) => sum + item.amount, 0);
  const totalPrice = input.basePrice + adjustmentTotal + input.rushFee;

  const breakdown: PriceBreakdown = {
    basePrice: input.basePrice,
    lineItems: input.lineItems,
    rushFee: input.rushFee,
    totalPrice,
  };

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      price: totalPrice,
      basePriceAtCreation: input.basePrice,
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
      entityType: "order",
      entityId: orderId,
      entityNumber: existing.orderNumber,
      action: "updated",
      userId,
      userName,
      changedAt: new Date(),
      changes: {
        price: { old: oldPrice, new: totalPrice },
        breakdown,
      } as unknown as Prisma.InputJsonValue,
      changeSummary: `Order price ${oldPrice > 0 ? "updated" : "generated"}: $${oldPrice.toFixed(2)} → $${totalPrice.toFixed(2)}`,
      source: "web_portal",
    },
    include: { user: { select: { id: true, name: true } } },
  });

  io?.to(ROOM_PREFIXES.ORDER(orderId)).emit("order:history:new", auditEntry);

  await createChatSystemEvent({
    entityType: ChatEntityType.order,
    entityId: orderId,
    eventType: "price_generated",
    content: `Order price ${oldPrice > 0 ? "updated" : "generated"}: $${totalPrice.toFixed(2)} (base $${input.basePrice.toFixed(2)}${adjustmentSummary ? `, ${adjustmentSummary}` : ""}${input.rushFee > 0 ? `, rush +$${input.rushFee.toFixed(2)}` : ""})`,
    metadata: { breakdown },
    userId,
    io,
  });

  return {
    breakdown,
    order: {
      id: updated.id,
      price: Number(updated.price),
      basePriceAtCreation: Number(updated.basePriceAtCreation),
      updatedAt: updated.updatedAt,
    },
  };
}
