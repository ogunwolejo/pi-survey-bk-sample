import { Router } from "express";
import { z } from "zod";
import type { Server as SocketServer } from "socket.io";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { sendSuccess, sendNoContent, sendError } from "../lib/response";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { orderLogger as logger } from "../lib/logger";
import * as fieldService from "../services/research-field.service";

const WRITE_ROLES = ["pls_reviewer", "super_admin", "admin", "office_manager"] as const;

const createFieldSchema = z.object({
  fieldName: z.string().min(1).max(100),
  fieldValue: z.string().min(1).max(1000),
});

const updateFieldSchema = z.object({
  fieldValue: z.string().min(1).max(1000),
});

export function createOrderResearchFieldRouter(io: SocketServer): Router {
  const router = Router({ mergeParams: true });

  // POST /:id/research-fields
  router.post(
    "/:id/research-fields",
    requireAuth,
    requireRole(...WRITE_ROLES),
    validateBody(createFieldSchema),
    async (req, res) => {
      try {
        const { fieldName, fieldValue } = req.body as z.infer<typeof createFieldSchema>;
        const field = await fieldService.createField(
          req.params["id"]!,
          fieldName,
          fieldValue,
          req.user!.userId,
        );

        logger.info("Research field created", { orderId: req.params["id"]!, fieldName });
        io.to(ROOM_PREFIXES.ORDER(req.params["id"]!)).emit("order:researchField:new", field);
        sendSuccess(res, field, 201);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // PATCH /:id/research-fields/:fieldId
  router.patch(
    "/:id/research-fields/:fieldId",
    requireAuth,
    requireRole(...WRITE_ROLES),
    validateBody(updateFieldSchema),
    async (req, res) => {
      try {
        const { fieldValue } = req.body as z.infer<typeof updateFieldSchema>;
        const field = await fieldService.updateField(
          req.params["fieldId"]!,
          fieldValue,
          req.user!.userId,
        );

        logger.info("Research field updated", { orderId: req.params["id"]!, fieldId: req.params["fieldId"]! });
        io.to(ROOM_PREFIXES.ORDER(req.params["id"]!)).emit("order:researchField:updated", field);
        sendSuccess(res, field);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // DELETE /:id/research-fields/:fieldId
  router.delete(
    "/:id/research-fields/:fieldId",
    requireAuth,
    requireRole(...WRITE_ROLES),
    async (req, res) => {
      try {
        await fieldService.deleteField(req.params["fieldId"]!, req.user!.userId);

        logger.info("Research field deleted", { orderId: req.params["id"]!, fieldId: req.params["fieldId"]! });
        io.to(ROOM_PREFIXES.ORDER(req.params["id"]!)).emit("order:researchField:deleted", {
          fieldId: req.params["fieldId"]!,
        });
        sendNoContent(res);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  return router;
}
