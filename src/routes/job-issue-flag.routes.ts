import { Router } from "express";
import type { Server as SocketServer } from "socket.io";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { z } from "zod";
import { ValidationError, NotFoundError } from "../lib/errors";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { getFlags, raiseFlag, resolveFlag } from "../services/job-issue-flag.service";
import { prisma } from "../lib/prisma";
import { IssueFlagCategory, IssueFlagSeverity } from "@prisma/client";
import { jobLogger as logger } from "../lib/logger";

const raiseFlagSchema = z.object({
  category: z.nativeEnum(IssueFlagCategory),
  severity: z.nativeEnum(IssueFlagSeverity),
  description: z.string().min(1).max(2000),
});

const resolveFlagSchema = z.object({
  resolutionNote: z.string().min(1).max(2000),
});

export function createJobIssueFlagRouter(io: SocketServer) {
  const router = Router({ mergeParams: true });

  // GET /api/jobs/:jobId/flags
  router.get("/", requireAuth, async (req, res) => {
    try {
      const { jobId } = req.params as { jobId: string };
      const flags = await getFlags(jobId);
      sendSuccess(res, flags);
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/jobs/:jobId/flags
  router.post(
    "/",
    requireAuth,
    requireRole("office_manager", "pls_reviewer", "pls_assistant", "drafter"),
    async (req, res) => {
      try {
        const { jobId } = req.params as { jobId: string };
        const data = raiseFlagSchema.parse(req.body);

        const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
        if (!job) { sendError(res, new NotFoundError("Job")); return; }

        const flag = await raiseFlag(jobId, req.user!.userId, data.category, data.severity, data.description);

        logger.info("Issue flag raised", { jobId, flagId: flag.id, category: data.category, severity: data.severity });
        io.to(ROOM_PREFIXES.JOB(jobId)).emit("job:flag-raised", flag);
        io.to(ROOM_PREFIXES.PIPELINE_BOARD).emit("job:flag-raised", { jobId, flagId: flag.id, severity: flag.severity });

        sendSuccess(res, flag, 201);
      } catch (err) {
        if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
        else sendError(res, err);
      }
    }
  );

  // POST /api/jobs/:jobId/flags/:flagId/resolve
  router.post(
    "/:flagId/resolve",
    requireAuth,
    requireRole("office_manager", "pls_reviewer", "pls_assistant", "drafter"),
    async (req, res) => {
      try {
        const { flagId } = req.params as { flagId: string; jobId: string };
        const { resolutionNote } = resolveFlagSchema.parse(req.body);

        const flag = await resolveFlag(flagId, req.user!.userId, resolutionNote);

        logger.info("Issue flag resolved", { jobId: flag.jobId, flagId: flag.id });
        io.to(ROOM_PREFIXES.JOB(flag.jobId)).emit("job:flag-resolved", flag);
        io.to(ROOM_PREFIXES.PIPELINE_BOARD).emit("job:flag-resolved", { jobId: flag.jobId, flagId: flag.id });

        sendSuccess(res, flag);
      } catch (err) {
        if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
        else sendError(res, err);
      }
    }
  );

  return router;
}
