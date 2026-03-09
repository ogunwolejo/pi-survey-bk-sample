import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { getCapacityData } from "../services/capacity.service";
import { getMetrics } from "../services/metrics.service";
import { getFieldTrackingData } from "../services/field-tracking.service";
import { generalLogger as logger } from "../lib/logger";

export function createDashboardRouter() {
  const router = Router();

  // GET /api/dashboard/field-tracking
  router.get(
    "/field-tracking",
    requireAuth,
    requireRole("office_manager"),
    async (_req, res) => {
      try {
        const data = await getFieldTrackingData();
        logger.info("Field tracking data fetched");
        sendSuccess(res, data);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  // GET /api/dashboard/capacity
  router.get(
    "/capacity",
    requireAuth,
    requireRole("crew_manager", "office_manager"),
    async (_req, res) => {
      try {
        const data = await getCapacityData();
        logger.info("Capacity data fetched");
        sendSuccess(res, data);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  // GET /api/dashboard/metrics
  router.get(
    "/metrics",
    requireAuth,
    requireRole("office_manager", "pls_reviewer"),
    async (req, res) => {
      try {
        const { period, team, isAlta } = req.query;
        const data = await getMetrics(
          (period as string) ?? "month",
          team as string | undefined,
          isAlta === "true" ? true : undefined
        );
        logger.info("Metrics data fetched", { period, team });
        sendSuccess(res, data);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  return router;
}
