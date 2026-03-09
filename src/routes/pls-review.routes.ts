import { Router } from "express";
import type { Server as SocketServer } from "socket.io";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { z } from "zod";
import { ValidationError } from "../lib/errors";
import { getReviewQueue, approveJob, requestCorrections } from "../services/pls-review.service";
import { jobLogger as logger } from "../lib/logger";

const approveSchema = z.object({
  notes: z.string().max(2000).optional(),
});

const correctionsSchema = z.object({
  correctionNotes: z.string().min(1).max(2000),
});

export function createPLSReviewRouter(io: SocketServer) {
  const router = Router();

  // GET /api/jobs/pls-review-queue
  router.get(
    "/pls-review-queue",
    requireAuth,
    requireRole("office_manager", "pls_reviewer"),
    async (req, res) => {
      try {
        const { team } = req.query;
        const queue = await getReviewQueue(team as string | undefined);
        sendSuccess(res, queue);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  // POST /api/jobs/:jobId/pls-approve
  router.post(
    "/:jobId/pls-approve",
    requireAuth,
    requireRole("pls_reviewer"),
    async (req, res) => {
      try {
        const { notes } = approveSchema.parse(req.body);
        const job = await approveJob(req.params["jobId"]!, req.user!.userId, notes);
        logger.info("Job PLS approved", { jobId: req.params["jobId"]! });
        sendSuccess(res, job);
      } catch (err) {
        if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
        else sendError(res, err);
      }
    }
  );

  // POST /api/jobs/:jobId/pls-request-corrections
  router.post(
    "/:jobId/pls-request-corrections",
    requireAuth,
    requireRole("pls_reviewer"),
    async (req, res) => {
      try {
        const { correctionNotes } = correctionsSchema.parse(req.body);
        const job = await requestCorrections(req.params["jobId"]!, req.user!.userId, correctionNotes);
        logger.info("Job PLS corrections requested", { jobId: req.params["jobId"]! });
        sendSuccess(res, job);
      } catch (err) {
        if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
        else sendError(res, err);
      }
    }
  );

  return router;
}
