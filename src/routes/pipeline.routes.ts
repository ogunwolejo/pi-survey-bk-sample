import { Router } from "express";
import type { Server as SocketServer } from "socket.io";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { getPipelineBoard } from "../services/pipeline.service";
import { pipelineLogger as logger } from "../lib/logger";

export function createPipelineRouter(_io: SocketServer) {
  const router = Router();

  // GET /api/pipeline/board
  router.get(
    "/board",
    requireAuth,
    requireRole("office_manager", "pls_reviewer", "pls_assistant", "drafter"),
    async (req, res) => {
      try {
        const { team, isAlta } = req.query;
        const board = await getPipelineBoard(
          team as string | undefined,
          isAlta === "true" ? true : isAlta === "false" ? false : undefined
        );
        logger.info("Pipeline board fetched", { team, isAlta });
        sendSuccess(res, board);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  return router;
}
