import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { prisma } from "../lib/prisma";
import { StakingRequestStatus } from "@prisma/client";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { sendPushToUser } from "../lib/web-push";
import type { Server as SocketServer } from "socket.io";
import { jobLogger as logger } from "../lib/logger";

const DEFAULT_ESCALATION_THRESHOLD_MINS = 30;

async function getEscalationThresholdMins(): Promise<number> {
  try {
    const setting = await prisma.systemSetting.findFirst({
      where: { key: "staking_escalation_threshold_mins" },
    });
    if (setting?.value) return parseInt(String(setting.value), 10) || DEFAULT_ESCALATION_THRESHOLD_MINS;
  } catch {
    // fall through to default
  }
  return DEFAULT_ESCALATION_THRESHOLD_MINS;
}

export function createStakingRouter(io: SocketServer) {
  const router = Router();

  // GET /api/staking/queue — prioritized pending staking requests
  router.get(
    "/queue",
    requireAuth,
    requireRole("office_manager", "pls_assistant"),
    async (_req, res) => {
      try {
        const escalationThresholdMins = await getEscalationThresholdMins();

        const requests = await prisma.stakingRequest.findMany({
          where: { status: StakingRequestStatus.pending },
          include: {
            requestedByUser: { select: { id: true, name: true, email: true } },
            job: {
              select: {
                id: true,
                jobNumber: true,
                internalDueDate: true,
                isAlta: true,
                team: true,
                assignedCrewId: true,
                order: {
                  select: {
                    propertyAddressLine1: true,
                    propertyCity: true,
                    propertyState: true,
                  },
                },
              },
            },
          },
          orderBy: { requestedAt: "asc" },
        });

        const now = Date.now();
        const enriched = requests.map((r) => {
          const minutesPending = Math.floor((now - r.requestedAt.getTime()) / 60000);
          const isEscalated = minutesPending >= escalationThresholdMins;
          const daysToDeadline = r.job.internalDueDate
            ? Math.max(0, Math.ceil((r.job.internalDueDate.getTime() - now) / 86400000))
            : 99;
          const urgency: "critical" | "high" | "normal" =
            isEscalated ? "critical" : daysToDeadline <= 1 ? "high" : "normal";
          const urgencyScore = daysToDeadline - minutesPending * 0.1;

          return {
            id: r.id,
            jobId: r.job.id,
            requestedAt: r.requestedAt.toISOString(),
            status: r.status,
            urgency,
            minutesPending,
            isEscalated,
            requestedBy: { name: r.requestedByUser?.name ?? "Unknown" },
            job: {
              id: r.job.id,
              jobNumber: r.job.jobNumber,
              propertyAddress: [
                r.job.order?.propertyAddressLine1,
                r.job.order?.propertyCity,
                r.job.order?.propertyState,
              ].filter(Boolean).join(", "),
              isAlta: r.job.isAlta ?? false,
            },
            urgencyScore,
          };
        });

        enriched.sort((a, b) => a.urgencyScore - b.urgencyScore);

        const pendingCount = enriched.length;
        const escalatedCount = enriched.filter((r) => r.isEscalated).length;

        logger.info("Staking queue fetched", { pendingCount, escalatedCount });
        sendSuccess(res, { requests: enriched, pendingCount, escalatedCount });
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  // POST /api/staking/:requestId/complete — mark request complete + send push to crew
  router.post(
    "/:requestId/complete",
    requireAuth,
    requireRole("office_manager", "pls_assistant"),
    async (req, res) => {
      try {
        const request = await prisma.stakingRequest.findUnique({
          where: { id: req.params["requestId"]! },
          include: { job: { select: { id: true, assignedCrewId: true, jobNumber: true } } },
        });
        if (!request) { sendSuccess(res, { error: "Not found" }, 404); return; }

        const updated = await prisma.stakingRequest.update({
          where: { id: request.id },
          data: {
            status: StakingRequestStatus.completed,
            respondedAt: new Date(),
            respondedBy: req.user!.userId,
          },
        });

        logger.info("Staking request completed", { requestId: request.id, jobId: request.job.id });

        // Send push notification to the requesting crew member
        if (request.requestedBy) {
          await sendPushToUser(request.requestedBy, {
            title: "Staking Points Ready",
            body: `Staking points for job ${request.job.jobNumber} have been uploaded. Check the job files.`,
            url: `/jobs/${request.job.id}`,
          }).catch(() => null);
        }

        // Notify job room
        io.to(ROOM_PREFIXES.JOB(request.job.id)).emit("staking:responded", {
          requestId: request.id,
          status: "completed",
        });

        sendSuccess(res, updated);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  return router;
}
