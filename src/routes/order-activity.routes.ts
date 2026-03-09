import { Router, Request, Response } from "express";
import { z } from "zod";
import type { Server as SocketServer } from "socket.io";
import { requireAuth } from "../middleware/auth.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { orderLogger as logger } from "../lib/logger";
import * as orderActivity from "../services/order-activity.service";

function createOrderActivityRouter(io: SocketServer | undefined) {
  const router = Router({ mergeParams: true });

  const feedQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  const postMessageSchema = z.object({
    content: z.string().min(1).max(5000),
    mentions: z.array(z.string().uuid()).default([]),
  });

  router.get(
    "/",
    requireAuth,
    validateQuery(feedQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { page, limit } = req.query as unknown as z.infer<typeof feedQuerySchema>;
        const orderId = req.params["id"]!;
        const result = await orderActivity.getActivityFeed(orderId, page, limit);
        sendSuccess(res, { data: result.data, meta: { page, limit, total: result.total } });
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  router.post(
    "/",
    requireAuth,
    validateBody(postMessageSchema),
    async (req: Request, res: Response) => {
      try {
        const { content, mentions } = req.body as z.infer<typeof postMessageSchema>;
        const userId = req.user!.userId;
        const orderId = req.params["id"]!;
        const entry = await orderActivity.postMessage(orderId, userId, content, mentions, io);
        logger.info("Order activity message posted", { orderId, userId });
        sendSuccess(res, entry, 201);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  return router;
}

export { createOrderActivityRouter };
