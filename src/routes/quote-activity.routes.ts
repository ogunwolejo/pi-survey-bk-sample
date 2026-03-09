import { Router, Request, Response } from "express";
import { z } from "zod";
import type { Server as SocketServer } from "socket.io";
import { requireAuth } from "../middleware/auth.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { quoteLogger as logger } from "../lib/logger";
import * as quoteActivity from "../services/quote-activity.service";

function createQuoteActivityRouter(io: SocketServer | undefined) {
  const router = Router({ mergeParams: true });

  const feedQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  const postMessageSchema = z.object({
    content: z.string().min(1).max(5000),
    mentions: z.array(z.string().uuid()).default([]),
  });

  // GET /api/quotes/:id/activity
  router.get(
    "/",
    requireAuth,
    validateQuery(feedQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { page, limit } = req.query as unknown as z.infer<typeof feedQuerySchema>;
        const quoteId = req.params["id"]!;
        const result = await quoteActivity.getActivityFeed(quoteId, page, limit);
        sendSuccess(res, { data: result.data, meta: { page, limit, total: result.total } });
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  // POST /api/quotes/:id/activity
  router.post(
    "/",
    requireAuth,
    validateBody(postMessageSchema),
    async (req: Request, res: Response) => {
      try {
        const { content, mentions } = req.body as z.infer<typeof postMessageSchema>;
        const userId = req.user!.userId;
        const quoteId = req.params["id"]!;
        const entry = await quoteActivity.postMessage(quoteId, userId, content, mentions, io);
        logger.info("Quote activity message posted", { quoteId, userId });
        sendSuccess(res, entry, 201);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  return router;
}

export { createQuoteActivityRouter };
