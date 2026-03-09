import { Router, Request, Response } from "express";
import { z } from "zod";
import type { Server } from "socket.io";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";
import { requireAdmin, requireRole } from "../middleware/rbac.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import { sendSuccess, sendPaginated, sendError } from "../lib/response";
import { NotFoundError, ConflictError } from "../lib/errors";
import { withTransaction } from "../lib/transaction";
import { redis, permissionsKey } from "../lib/redis";
import { sendEmail } from "../services/email.service";
import { envStore } from "../env-store";
import { v4 as uuidv4 } from "uuid";
import { pipelineLogger as logger } from "../lib/logger";
import { JobStatus } from "@prisma/client";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  is_active: z.enum(["true", "false"]).optional(),
});

const updateCrewSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  starting_location_lat: z.number().min(-90).max(90).nullish(),
  starting_location_lng: z.number().min(-180).max(180).nullish(),
  capability_tags: z.array(z.string()).optional(),
  is_active: z.boolean().optional(),
});

const addMemberSchema = z.object({
  user_id: z.string().uuid(),
});

const inviteToCrewSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
});

const updateLocationSchema = z.object({
  current_lat: z.number().min(-90).max(90),
  current_lng: z.number().min(-180).max(180),
});

export function createCrewRouter(io: Server): Router {
  const router = Router();

  // GET / → requireAuth, list crews with member count and pending invite count
  router.get(
    "/",
    requireAuth,
    validateQuery(listQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { page, limit, is_active } = req.query as unknown as z.infer<typeof listQuerySchema>;
        const where: { isActive?: boolean } = {};
        if (is_active !== undefined) {
          where.isActive = is_active === "true";
        }

        const [crews, total] = await Promise.all([
          prisma.crew.findMany({
            where,
            select: {
              id: true,
              crewNumber: true,
              name: true,
              capabilityTags: true,
              isActive: true,
              currentLat: true,
              currentLng: true,
              gpsUpdatedAt: true,
              startingLocationLat: true,
              startingLocationLng: true,
              createdAt: true,
              updatedAt: true,
              _count: { select: { members: true } },
            },
            orderBy: { crewNumber: "asc" },
            skip: (page - 1) * limit,
            take: limit,
          }),
          prisma.crew.count({ where }),
        ]);

        const now = new Date();
        const crewIds = crews.map((c) => c.id);
        const pendingCounts = crewIds.length > 0
          ? await prisma.invitation.groupBy({
              by: ["crewId"],
              where: {
                crewId: { in: crewIds },
                usedAt: null,
                expiresAt: { gt: now },
              },
              _count: { id: true },
            })
          : [];

        const pendingMap = new Map(
          pendingCounts.map((p) => [p.crewId, p._count.id])
        );

        const mapped = crews.map(({ _count, ...crew }) => ({
          ...crew,
          memberCount: _count.members,
          pendingInviteCount: pendingMap.get(crew.id) ?? 0,
        }));

        sendPaginated(res, mapped, page, limit, total);
      } catch (error) {
        sendError(res, error);
      }
    }
  );

  // GET /:id → requireAuth, crew detail with members, pending invitations, and active jobs
  router.get("/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const now = new Date();

      const [crew, pendingInvitations] = await Promise.all([
        prisma.crew.findUnique({
          where: { id },
          include: {
            members: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
                platformAccess: true,
                isActive: true,
              },
              orderBy: { name: "asc" },
            },
            jobs: {
              where: {
                status: { in: [JobStatus.assigned, JobStatus.in_progress] },
                deletedAt: null,
              },
              include: {
                order: {
                  select: {
                    orderNumber: true,
                    propertyAddressLine1: true,
                    propertyAddressLine2: true,
                    propertyCity: true,
                    propertyState: true,
                    propertyZip: true,
                    surveyType: true,
                    priority: true,
                  },
                },
              },
              orderBy: { fieldDate: "asc" },
            },
          },
        }),
        prisma.invitation.findMany({
          where: {
            crewId: id,
            usedAt: null,
            expiresAt: { gt: now },
          },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            expiresAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        }),
      ]);

      if (!crew) throw new NotFoundError("Crew not found");
      sendSuccess(res, { ...crew, pendingInvitations });
    } catch (error) {
      sendError(res, error);
    }
  });

  // POST / → requireAdmin, create crew with auto-generated sequential name
  router.post(
    "/",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const crew = await withTransaction(async (tx) => {
          const maxResult = await tx.crew.aggregate({ _max: { crewNumber: true } });
          const nextNumber = (maxResult._max.crewNumber ?? 0) + 1;

          return tx.crew.create({
            data: {
              crewNumber: nextNumber,
              name: `Crew ${nextNumber}`,
              capabilityTags: [],
            },
            select: {
              id: true,
              crewNumber: true,
              name: true,
              isActive: true,
              capabilityTags: true,
              startingLocationLat: true,
              startingLocationLng: true,
              createdAt: true,
              updatedAt: true,
            },
          });
        }, "Serializable");

        logger.info("Crew created", { crewId: crew.id, crewNumber: crew.crewNumber });
        sendSuccess(res, { ...crew, memberCount: 0 }, 201);
      } catch (error) {
        sendError(res, error);
      }
    }
  );

  // PUT /:id → requireRole('crew_manager'), update crew fields (with deactivation guard)
  router.put(
    "/:id",
    requireAuth,
    requireRole("crew_manager"),
    validateBody(updateCrewSchema),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const body = req.body as z.infer<typeof updateCrewSchema>;

        const existing = await prisma.crew.findUnique({ where: { id } });
        if (!existing) throw new NotFoundError("Crew not found");

        if (body.is_active === false && existing.isActive) {
          const activeJobCount = await prisma.job.count({
            where: {
              assignedCrewId: id,
              status: { in: [JobStatus.assigned, JobStatus.in_progress] },
              deletedAt: null,
            },
          });
          if (activeJobCount > 0) {
            throw new ConflictError(
              `Cannot deactivate crew with ${activeJobCount} active job(s). Reassign them first.`,
              { activeJobCount }
            );
          }
        }

        const crew = await prisma.crew.update({
          where: { id },
          data: {
            ...(body.name !== undefined && { name: body.name }),
            ...(body.starting_location_lat !== undefined && {
              startingLocationLat: body.starting_location_lat,
            }),
            ...(body.starting_location_lng !== undefined && {
              startingLocationLng: body.starting_location_lng,
            }),
            ...(body.capability_tags !== undefined && { capabilityTags: body.capability_tags }),
            ...(body.is_active !== undefined && { isActive: body.is_active }),
          },
        });

        logger.info("Crew updated", { crewId: crew.id, name: crew.name });
        sendSuccess(res, crew);
      } catch (error) {
        sendError(res, error);
      }
    }
  );

  // POST /:id/members → requireAdmin, add existing user to crew
  router.post(
    "/:id/members",
    requireAdmin,
    validateBody(addMemberSchema),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { user_id } = req.body as z.infer<typeof addMemberSchema>;

        const crew = await prisma.crew.findUnique({ where: { id } });
        if (!crew) throw new NotFoundError("Crew not found");

        const user = await prisma.user.findUnique({ where: { id: user_id } });
        if (!user) throw new NotFoundError("User not found");

        if (user.crewId) {
          const existingCrew = await prisma.crew.findUnique({
            where: { id: user.crewId },
            select: { name: true },
          });
          throw new ConflictError(
            `User is already assigned to ${existingCrew?.name ?? "a crew"}`,
            { crewName: existingCrew?.name }
          );
        }

        await prisma.user.update({
          where: { id: user_id },
          data: { crewId: id, platformAccess: "mobile" },
        });

        await redis.del(permissionsKey(user_id));

        const updatedCrew = await prisma.crew.findUnique({
          where: { id },
          include: {
            members: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
                platformAccess: true,
                isActive: true,
              },
              orderBy: { name: "asc" },
            },
          },
        });

        sendSuccess(res, updatedCrew);
      } catch (error) {
        sendError(res, error);
      }
    }
  );

  // DELETE /:id/members/:userId → requireAdmin, remove user from crew
  router.delete(
    "/:id/members/:userId",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const userId = req.params["userId"]!;

        const crew = await prisma.crew.findUnique({ where: { id } });
        if (!crew) throw new NotFoundError("Crew not found");

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || user.crewId !== id) {
          throw new NotFoundError("User not found or not a member of this crew");
        }

        await prisma.user.update({
          where: { id: userId },
          data: { crewId: null },
        });

        await redis.del(permissionsKey(userId));

        const updatedCrew = await prisma.crew.findUnique({
          where: { id },
          include: {
            members: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
                platformAccess: true,
                isActive: true,
              },
              orderBy: { name: "asc" },
            },
          },
        });

        sendSuccess(res, updatedCrew);
      } catch (error) {
        sendError(res, error);
      }
    }
  );

  // POST /:id/invite → requireAdmin, invite new person directly to crew
  router.post(
    "/:id/invite",
    requireAdmin,
    validateBody(inviteToCrewSchema),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { email, name } = req.body as z.infer<typeof inviteToCrewSchema>;
        const createdBy = req.user!.userId;

        const crew = await prisma.crew.findUnique({ where: { id } });
        if (!crew) throw new NotFoundError("Crew not found");

        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
          throw new ConflictError(
            "A user with this email already exists. Use the \"Add Member\" option instead.",
            { existingUserId: existingUser.id }
          );
        }

        const existingInvite = await prisma.invitation.findFirst({
          where: { email, usedAt: null, expiresAt: { gt: new Date() } },
        });
        if (existingInvite) {
          throw new ConflictError("A pending invitation already exists for this email");
        }

        const token = uuidv4();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        const invitation = await prisma.invitation.create({
          data: {
            token,
            email,
            name,
            role: "field_crew",
            platformAccess: "mobile",
            team: "residential",
            expiresAt,
            createdBy,
            crewId: id,
          },
        });

        const inviteUrl = `${envStore.FRONTEND_URL}/setup/${token}`;

        await sendEmail({
          to: email,
          subject: `You've been invited to join ${crew.name} at Pi Surveying`,
          html: [
            `<p>Hi ${name},</p>`,
            `<p>You've been invited to join <strong>${crew.name}</strong> at Pi Surveying Portal as a <strong>Field Crew</strong> member.</p>`,
            `<p><a href="${inviteUrl}">Accept your invitation</a></p>`,
            `<p>This invitation expires on ${expiresAt.toLocaleDateString()}.</p>`,
            `<p>— Pi Surveying</p>`,
          ].join("\n"),
        }).catch((err) => {
          logger.error("Failed to send crew invitation email", {
            error: String(err),
            invitationId: invitation.id,
          });
        });

        sendSuccess(res, {
          id: invitation.id,
          email,
          name,
          role: "field_crew",
          crewId: id,
          crewName: crew.name,
          expiresAt,
        }, 201);
      } catch (error) {
        sendError(res, error);
      }
    }
  );

  // PUT /:id/location → requireAuth, update GPS location and emit Socket.io event
  router.put(
    "/:id/location",
    requireAuth,
    validateBody(updateLocationSchema),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { current_lat, current_lng } = req.body as z.infer<typeof updateLocationSchema>;

        const existing = await prisma.crew.findUnique({ where: { id } });
        if (!existing) throw new NotFoundError("Crew not found");

        const now = new Date();
        const crew = await prisma.crew.update({
          where: { id },
          data: {
            currentLat: current_lat,
            currentLng: current_lng,
            gpsUpdatedAt: now,
          },
          select: {
            id: true,
            name: true,
            currentLat: true,
            currentLng: true,
            gpsUpdatedAt: true,
          },
        });

        io.to("dashboard:jobs").emit("crew:gps_update", {
          crewId: crew.id,
          crewName: crew.name,
          lat: crew.currentLat,
          lng: crew.currentLng,
          updatedAt: crew.gpsUpdatedAt,
        });

        sendSuccess(res, crew);
      } catch (error) {
        sendError(res, error);
      }
    }
  );

  return router;
}
