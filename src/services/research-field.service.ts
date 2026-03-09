import { prisma } from "../lib/prisma";
import { ConflictError, NotFoundError } from "../lib/errors";
import { orderLogger as logger } from "../lib/logger";

export async function createField(
  orderId: string,
  fieldName: string,
  fieldValue: string,
  userId: string,
) {
  const existing = await prisma.orderResearchField.findUnique({
    where: { orderId_fieldName: { orderId, fieldName } },
  });

  if (existing) {
    throw new ConflictError(`Field "${fieldName}" already exists on this order`);
  }

  const field = await prisma.orderResearchField.create({
    data: {
      orderId,
      fieldName,
      fieldValue,
      createdBy: userId,
    },
    include: {
      createdByUser: { select: { id: true, name: true } },
    },
  });

  logger.info("[ResearchField] Field created", {
    fieldId: field.id,
    orderId,
    fieldName,
  });

  return field;
}

export async function updateField(
  fieldId: string,
  fieldValue: string,
  userId: string,
) {
  const existing = await prisma.orderResearchField.findUnique({
    where: { id: fieldId },
  });

  if (!existing) {
    throw new NotFoundError(`Research field ${fieldId} not found`);
  }

  const updated = await prisma.orderResearchField.update({
    where: { id: fieldId },
    data: { fieldValue },
    include: {
      createdByUser: { select: { id: true, name: true } },
    },
  });

  logger.info("[ResearchField] Field updated", {
    fieldId,
    orderId: existing.orderId,
    fieldName: existing.fieldName,
  });

  return updated;
}

export async function deleteField(
  fieldId: string,
  userId: string,
) {
  const existing = await prisma.orderResearchField.findUnique({
    where: { id: fieldId },
    select: { id: true, orderId: true, fieldName: true },
  });

  if (!existing) {
    throw new NotFoundError(`Research field ${fieldId} not found`);
  }

  await prisma.orderResearchField.delete({ where: { id: fieldId } });

  logger.info("[ResearchField] Field deleted", {
    fieldId,
    orderId: existing.orderId,
    fieldName: existing.fieldName,
    deletedBy: userId,
  });

  return { orderId: existing.orderId };
}
