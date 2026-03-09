import { Router } from "express";
import type { Server as SocketServer } from "socket.io";
import { z } from "zod";
import { ChatEntityType } from "@prisma/client";
import { requireAuth } from "../middleware/auth.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { ValidationError } from "../lib/errors";
import { getMessages, postMessage } from "../services/chat.service";
import { chatLogger as logger } from "../lib/logger";

const chatPathSchema = z.object({
  entityType: z.enum(["quote", "order", "job"]),
  entityId: z.string().uuid(),
});

const chatQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});

const postMessageSchema = z.object({
  content: z.string().min(1).max(5000),
  mentions: z.array(
    z.union([z.string().uuid(), z.literal("everyone")])
  ).min(1, "At least one @mention is required"),
});

export function createChatRouter(io: SocketServer) {
  const router = Router({ mergeParams: true });

  router.get("/", requireAuth, async (req, res) => {
    try {
      const pathResult = chatPathSchema.safeParse(req.params);
      if (!pathResult.success) {
        sendError(res, new ValidationError(pathResult.error.errors[0]?.message ?? "Invalid path params"));
        return;
      }
      const { entityType, entityId } = pathResult.data;

      const queryResult = chatQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        sendError(res, new ValidationError(queryResult.error.errors[0]?.message ?? "Invalid query params"));
        return;
      }
      const { limit, before } = queryResult.data;

      const result = await getMessages(entityType as ChatEntityType, entityId, limit, before);
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/", requireAuth, async (req, res) => {
    try {
      const pathResult = chatPathSchema.safeParse(req.params);
      if (!pathResult.success) {
        sendError(res, new ValidationError(pathResult.error.errors[0]?.message ?? "Invalid path params"));
        return;
      }
      const { entityType, entityId } = pathResult.data;

      const bodyResult = postMessageSchema.safeParse(req.body);
      if (!bodyResult.success) {
        sendError(res, new ValidationError(bodyResult.error.errors[0]?.message ?? "Validation error"));
        return;
      }
      const { content, mentions } = bodyResult.data;

      logger.info("Chat message posted", { entityType, entityId, userId: req.user!.userId });

      const message = await postMessage(
        entityType as ChatEntityType,
        entityId,
        req.user!.userId,
        content,
        mentions,
        io,
      );

      sendSuccess(res, message, 201);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
