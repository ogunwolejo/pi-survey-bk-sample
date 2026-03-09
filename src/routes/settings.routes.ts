import { Router, Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";
import { requireAdmin } from "../middleware/rbac.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { sendSuccess, sendError, sendNoContent } from "../lib/response";
import { NotFoundError } from "../lib/errors";
import { settingsLogger as logger } from "../lib/logger";

const router = Router();

// GET / → requireAdmin, return all system settings as { key: value } object
router.get("/", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const settings = await prisma.systemSetting.findMany();
    const result: Record<string, unknown> = {};
    for (const s of settings) {
      result[s.key] = s.value;
    }
    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error);
  }
});

// GET /holidays → requireAuth, list all holidays
// Defined before /:key to avoid that route swallowing it
router.get("/holidays", requireAuth, async (_req: Request, res: Response) => {
  try {
    const holidays = await prisma.holiday.findMany({
      orderBy: { date: "asc" },
    });
    sendSuccess(res, holidays);
  } catch (error) {
    sendError(res, error);
  }
});

// GET /:key → requireAuth, return single setting
router.get("/:key", requireAuth, async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const setting = await prisma.systemSetting.findUnique({ where: { key } });
    if (!setting) throw new NotFoundError(`Setting '${key}' not found`);
    sendSuccess(res, { key: setting.key, value: setting.value });
  } catch (error) {
    sendError(res, error);
  }
});

const updateSettingSchema = z.object({
  value: z.any(),
});

// PUT /:key → requireAdmin, update setting value (JSON), log to entity_audit_log
router.put(
  "/:key",
  requireAdmin,
  validateBody(updateSettingSchema),
  async (req: Request, res: Response) => {
    try {
      const { key } = req.params;
      const { value } = req.body as z.infer<typeof updateSettingSchema>;
      const user = req.user!;

      const existing = await prisma.systemSetting.findUnique({ where: { key } });
      if (!existing) throw new NotFoundError(`Setting '${key}' not found`);

      const updated = await prisma.systemSetting.update({
        where: { key },
        data: {
          value: value as Prisma.InputJsonValue,
          updatedBy: user.userId,
        },
      });

      await prisma.entityAuditLog.create({
        data: {
          entityType: "system_setting",
          entityId: updated.id,
          action: "updated",
          userId: user.userId,
          userName: user.email,
          changedAt: new Date(),
          changes: { key, oldValue: existing.value, newValue: value } as Prisma.InputJsonValue,
          changeSummary: `Updated system setting '${key}'`,
          source: "web_portal",
        },
      });

      logger.info("System setting updated", { key, userId: user.userId });
      sendSuccess(res, { key: updated.key, value: updated.value });
    } catch (error) {
      sendError(res, error);
    }
  }
);

const createHolidaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  name: z.string().min(1),
  recurring: z.boolean().optional().default(false),
});

// POST /holidays → requireAdmin, add holiday
router.post(
  "/holidays",
  requireAdmin,
  validateBody(createHolidaySchema),
  async (req: Request, res: Response) => {
    try {
      const { date, name, recurring } = req.body as z.infer<typeof createHolidaySchema>;
      const holiday = await prisma.holiday.create({
        data: {
          date: new Date(date),
          name,
          recurring,
        },
      });
      sendSuccess(res, holiday, 201);
    } catch (error) {
      sendError(res, error);
    }
  }
);

// DELETE /holidays/:id → requireAdmin, delete holiday
router.delete("/holidays/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const holiday = await prisma.holiday.findUnique({ where: { id } });
    if (!holiday) throw new NotFoundError("Holiday not found");
    await prisma.holiday.delete({ where: { id } });
    sendNoContent(res);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
