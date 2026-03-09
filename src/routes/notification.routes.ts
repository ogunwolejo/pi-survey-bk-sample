import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";
import { validateQuery } from "../middleware/validate.middleware";
import { sendPaginated, sendSuccess, sendNoContent, sendError } from "../lib/response";
import { NotFoundError, AuthorizationError } from "../lib/errors";
import { generalLogger as logger } from "../lib/logger";

const router = Router();

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  is_read: z.enum(["true", "false"]).optional(),
});

// GET / → requireAuth, paginated notifications for current user (unread first)
router.get("/", requireAuth, validateQuery(listQuerySchema), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { page, limit, is_read } = req.query as unknown as z.infer<typeof listQuerySchema>;

    const where: { userId: string; isRead?: boolean } = { userId };
    if (is_read !== undefined) {
      where.isRead = is_read === "true";
    }

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: [{ isRead: "asc" }, { createdAt: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.notification.count({ where }),
    ]);

    sendPaginated(res, notifications, page, limit, total);
  } catch (error) {
    sendError(res, error);
  }
});

// GET /unread-count → requireAuth, return { count: number }
// Defined before /:id/read to avoid conflict
router.get("/unread-count", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const count = await prisma.notification.count({ where: { userId, isRead: false } });
    sendSuccess(res, { count });
  } catch (error) {
    sendError(res, error);
  }
});

// PUT /read-all → requireAuth, mark all notifications as read for current user
// Defined before /:id/read to avoid conflict
router.put("/read-all", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    logger.info("All notifications marked as read", { userId });
    sendNoContent(res);
  } catch (error) {
    sendError(res, error);
  }
});

// PUT /:id/read → requireAuth, mark single notification as read
router.put("/:id/read", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    const notification = await prisma.notification.findUnique({ where: { id } });
    if (!notification) throw new NotFoundError("Notification not found");
    if (notification.userId !== userId) throw new AuthorizationError("Cannot access this notification");

    const updated = await prisma.notification.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });

    sendSuccess(res, updated);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
