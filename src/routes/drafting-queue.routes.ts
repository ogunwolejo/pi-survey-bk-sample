import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { getDraftingQueue, claimJob, unclaimJob, getDraftingThroughput } from "../services/drafting-queue.service";
import { jobLogger as logger } from "../lib/logger";

export function createDraftingQueueRouter() {
  const router = Router();

  // GET /api/jobs/drafting-queue
  router.get(
    "/drafting-queue",
    requireAuth,
    requireRole("office_manager", "pls_assistant", "drafter"),
    async (req, res) => {
      try {
        const { status } = req.query;
        const queue = await getDraftingQueue(status as string | undefined);
        sendSuccess(res, queue);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  // GET /api/jobs/drafting-throughput
  router.get(
    "/drafting-throughput",
    requireAuth,
    requireRole("office_manager", "pls_assistant", "drafter"),
    async (_req, res) => {
      try {
        const throughput = await getDraftingThroughput();
        sendSuccess(res, throughput);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  // POST /api/jobs/:jobId/claim
  router.post(
    "/:jobId/claim",
    requireAuth,
    requireRole("office_manager", "pls_assistant", "drafter"),
    async (req, res) => {
      try {
        const job = await claimJob(req.params["jobId"]!, req.user!.userId);
        logger.info("Drafting job claimed", { jobId: req.params["jobId"]!, userId: req.user!.userId });
        sendSuccess(res, job);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  // POST /api/jobs/:jobId/unclaim
  router.post(
    "/:jobId/unclaim",
    requireAuth,
    requireRole("office_manager", "pls_assistant", "drafter"),
    async (req, res) => {
      try {
        const job = await unclaimJob(req.params["jobId"]!, req.user!.userId);
        logger.info("Drafting job unclaimed", { jobId: req.params["jobId"]!, userId: req.user!.userId });
        sendSuccess(res, job);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  return router;
}
