import { Router } from "express";
import { z } from "zod";
import type { Server as SocketServer } from "socket.io";
import { DeliveryChecklistStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { withTransaction } from "../lib/transaction";
import { sendSuccess, sendError } from "../lib/response";
import { NotFoundError } from "../lib/errors";
import { requireAuth } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { orderLogger as logger } from "../lib/logger";

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const confirmItemSchema = z.object({
  notes: z.string().optional(),
});

// ─── GET /:orderId ────────────────────────────────────────────────────────────

router.get("/:orderId", requireAuth, async (req, res) => {
  try {
    const checklist = await prisma.deliveryChecklist.findUnique({
      where: { orderId: req.params["orderId"]! },
      include: {
        items: { orderBy: { sortOrder: "asc" } },
        completedByUser: { select: { id: true, name: true, email: true } },
      },
    });

    if (!checklist) throw new NotFoundError("Delivery checklist not found for this order");
    sendSuccess(res, checklist);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── PUT /:orderId/items/:itemId/confirm ──────────────────────────────────────

router.put(
  "/:orderId/items/:itemId/confirm",
  requireAuth,
  validateBody(confirmItemSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof confirmItemSchema>;
      const orderId = req.params["orderId"]!;
      const itemId = req.params["itemId"]!;

      const checklist = await prisma.deliveryChecklist.findUnique({
        where: { orderId },
        include: { items: true },
      });
      if (!checklist) throw new NotFoundError("Delivery checklist not found");

      const item = checklist.items.find((i) => i.id === itemId);
      if (!item) throw new NotFoundError("Checklist item not found");

      const updatedItem = await withTransaction(async (tx) => {
        const confirmed = await tx.deliveryChecklistItem.update({
          where: { id: itemId },
          data: {
            isConfirmed: true,
            confirmedBy: req.user!.userId,
            confirmedAt: new Date(),
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
          },
        });

        const isFirstConfirmation =
          checklist.status === DeliveryChecklistStatus.not_started &&
          checklist.items.every((i) => !i.isConfirmed);

        if (isFirstConfirmation) {
          await tx.deliveryChecklist.update({
            where: { id: checklist.id },
            data: { status: DeliveryChecklistStatus.in_progress, startedAt: new Date() },
          });
        }

        const allItems = await tx.deliveryChecklistItem.findMany({
          where: { checklistId: checklist.id },
        });
        const requiredItems = allItems.filter((i) => i.isRequired);
        const allRequiredDone =
          requiredItems.length > 0 && requiredItems.every((i) => i.isConfirmed || i.id === itemId);

        if (allRequiredDone) {
          await tx.deliveryChecklist.update({
            where: { id: checklist.id },
            data: {
              status: DeliveryChecklistStatus.complete,
              completedAt: new Date(),
              completedBy: req.user!.userId,
            },
          });
        }

        return confirmed;
      });

      logger.info("Delivery checklist item confirmed", { orderId, itemId, stepKey: item.stepKey });

      const io = req.app.get("io") as SocketServer | undefined;
      io?.to(`delivery:${orderId}`).emit("checklist:item_confirmed", {
        orderId,
        itemId,
        stepKey: item.stepKey,
        confirmedBy: req.user!.userId,
      });

      sendSuccess(res, updatedItem);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── PUT /:orderId/items/:itemId/undo ─────────────────────────────────────────

router.put("/:orderId/items/:itemId/undo", requireAuth, async (req, res) => {
  try {
    const orderId = req.params["orderId"]!;
    const itemId = req.params["itemId"]!;

    const checklist = await prisma.deliveryChecklist.findUnique({
      where: { orderId },
      include: { items: true },
    });
    if (!checklist) throw new NotFoundError("Delivery checklist not found");

    const item = checklist.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundError("Checklist item not found");

    const updatedItem = await withTransaction(async (tx) => {
      const undone = await tx.deliveryChecklistItem.update({
        where: { id: itemId },
        data: { isConfirmed: false, confirmedBy: null, confirmedAt: null },
      });

      const remainingConfirmed = checklist.items.filter(
        (i) => i.id !== itemId && i.isConfirmed
      ).length;

      const newStatus =
        remainingConfirmed === 0 ? DeliveryChecklistStatus.not_started : DeliveryChecklistStatus.in_progress;

      await tx.deliveryChecklist.update({
        where: { id: checklist.id },
        data: {
          status: newStatus,
          ...(newStatus === DeliveryChecklistStatus.not_started ? { startedAt: null } : {}),
          completedAt: null,
          completedBy: null,
        },
      });

      return undone;
    });

    sendSuccess(res, updatedItem);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /:orderId/tracking ───────────────────────────────────────────────────

router.get("/:orderId/tracking", requireAuth, async (req, res) => {
  try {
    const tracking = await prisma.deliveryTracking.findUnique({
      where: { orderId: req.params["orderId"]! },
      include: {
        events: { orderBy: { occurredAt: "desc" } },
        order: {
          select: {
            id: true,
            orderNumber: true,
            deliveryPreference: true,
            client: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
      },
    });

    if (!tracking) throw new NotFoundError("Delivery tracking not found for this order");
    sendSuccess(res, tracking);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
