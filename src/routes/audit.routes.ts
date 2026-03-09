import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";
import { requireAdmin } from "../middleware/rbac.middleware";
import { validateQuery } from "../middleware/validate.middleware";
import { sendPaginated, sendSuccess, sendError } from "../lib/response";
import { generalLogger as logger } from "../lib/logger";

const router = Router();

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// GET /recent → requireAdmin, recent changes across all entities (last 100)
// Must be defined before /:entityType/:entityId to avoid route conflict
router.get("/recent", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const logs = await prisma.entityAuditLog.findMany({
      orderBy: { changedAt: "desc" },
      take: 100,
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });
    logger.info("Recent audit logs fetched", { count: logs.length });
    sendSuccess(res, logs);
  } catch (error) {
    sendError(res, error);
  }
});

// GET /users/:userId → requireAdmin, all audit entries by a specific user (paginated)
// Must be defined before /:entityType/:entityId
router.get(
  "/users/:userId",
  requireAdmin,
  validateQuery(paginationSchema),
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const { page, limit } = req.query as unknown as z.infer<typeof paginationSchema>;

      const [logs, total] = await Promise.all([
        prisma.entityAuditLog.findMany({
          where: { userId },
          orderBy: { changedAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.entityAuditLog.count({ where: { userId } }),
      ]);

      sendPaginated(res, logs, page, limit, total);
    } catch (error) {
      sendError(res, error);
    }
  }
);

// GET /:entityType/:entityId → requireAuth, paginated audit history for entity
router.get(
  "/:entityType/:entityId",
  requireAuth,
  validateQuery(paginationSchema),
  async (req: Request, res: Response) => {
    try {
      const { entityType, entityId } = req.params;
      const { page, limit } = req.query as unknown as z.infer<typeof paginationSchema>;

      const [logs, total] = await Promise.all([
        prisma.entityAuditLog.findMany({
          where: { entityType, entityId },
          orderBy: { changedAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.entityAuditLog.count({ where: { entityType, entityId } }),
      ]);

      sendPaginated(res, logs, page, limit, total);
    } catch (error) {
      sendError(res, error);
    }
  }
);

export default router;
