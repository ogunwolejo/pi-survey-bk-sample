import { Router } from "express";
import type { Server as SocketServer } from "socket.io";
import { requireAuth } from "../middleware/auth.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { z } from "zod";
import { ValidationError, NotFoundError } from "../lib/errors";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { getMessages, postMessage } from "../services/job-chat.service";
import { prisma } from "../lib/prisma";
import { jobLogger as logger } from "../lib/logger";

const postMessageSchema = z.object({
  content: z.string().min(1).max(5000),
  attachmentId: z.string().uuid().optional(),
});

export function createJobChatRouter(io: SocketServer) {
  const router = Router({ mergeParams: true });

  // GET /api/jobs/:jobId/chat
  router.get("/", requireAuth, async (req, res) => {
    try {
      const { jobId } = req.params as { jobId: string };
      const page = parseInt((req.query["page"] as string) ?? "1", 10);
      const limit = parseInt((req.query["limit"] as string) ?? "50", 10);

      const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
      if (!job) { sendError(res, new NotFoundError("Job")); return; }

      const result = await getMessages(jobId, page, limit);
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/jobs/:jobId/chat
  router.post("/", requireAuth, async (req, res) => {
    try {
      const { jobId } = req.params as { jobId: string };
      const { content, attachmentId } = postMessageSchema.parse(req.body);

      const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
      if (!job) { sendError(res, new NotFoundError("Job")); return; }

      const message = await postMessage(jobId, req.user!.userId, content, attachmentId);

      logger.info("Job chat message posted", { jobId, userId: req.user!.userId });
      io.to(ROOM_PREFIXES.JOB_CHAT(jobId)).emit("job:chat:message", message);

      sendSuccess(res, message, 201);
    } catch (err) {
      if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
      else sendError(res, err);
    }
  });

  return router;
}
