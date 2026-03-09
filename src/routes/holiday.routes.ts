import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { prisma } from "../lib/prisma";
import { z } from "zod";
import { ValidationError, NotFoundError } from "../lib/errors";
import { invalidateHolidayCache } from "../services/internal-due-date.service";
import { settingsLogger as logger } from "../lib/logger";

const createHolidaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: z.string().min(1).max(100),
  recurring: z.boolean().default(false),
});

const holidayRouter = Router();

// GET /api/holidays
holidayRouter.get("/", requireAuth, async (req, res) => {
  try {
    const { year } = req.query;
    const where: Record<string, unknown> = {};
    if (year) {
      const y = parseInt(year as string, 10);
      where.date = {
        gte: new Date(`${y}-01-01`),
        lte: new Date(`${y}-12-31`),
      };
    }
    const holidays = await prisma.holiday.findMany({ where, orderBy: { date: "asc" } });
    sendSuccess(res, holidays);
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/holidays
holidayRouter.post(
  "/",
  requireAuth,
  requireRole("office_manager"),
  async (req, res) => {
    try {
      const data = createHolidaySchema.parse(req.body);
      const holiday = await prisma.holiday.create({
        data: { date: new Date(data.date), name: data.name, recurring: data.recurring },
      });
      await invalidateHolidayCache();
      logger.info("Holiday created", { holidayId: holiday.id, name: data.name, date: data.date });
      sendSuccess(res, holiday, 201);
    } catch (err) {
      if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
      else sendError(res, err);
    }
  }
);

// DELETE /api/holidays/:id
holidayRouter.delete(
  "/:id",
  requireAuth,
  requireRole("office_manager"),
  async (req, res) => {
    try {
      const existing = await prisma.holiday.findUnique({ where: { id: req.params["id"] } });
      if (!existing) { sendError(res, new NotFoundError("Holiday")); return; }
      await prisma.holiday.delete({ where: { id: req.params["id"] } });
      await invalidateHolidayCache();
      logger.info("Holiday deleted", { holidayId: req.params["id"] });
      sendSuccess(res, { message: "Holiday deleted" });
    } catch (err) {
      sendError(res, err);
    }
  }
);

export default holidayRouter;
