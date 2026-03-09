import { Router, Request, Response } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { envStore } from "../env-store";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";
import { requireAdmin, canEditUser } from "../middleware/rbac.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import { sendSuccess, sendPaginated, sendError, sendNoContent } from "../lib/response";
import { NotFoundError, AuthorizationError, ConflictError } from "../lib/errors";
import { redis, permissionsKey } from "../lib/redis";
import { settingsLogger as logger } from "../lib/logger";
import { sendEmail } from "../services/email.service";

const router = Router();

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  role: z.string().optional(),
  team: z.string().optional(),
  is_active: z.enum(["true", "false"]).optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  role: z
    .enum([
      "super_admin",
      "admin",
      "office_manager",
      "crew_manager",
      "pls_reviewer",
      "field_crew",
      "drafter",
      "shipping_admin",
    ])
    .optional(),
  team: z.enum(["residential", "public", "both"]).optional(),
  platform_access: z.enum(["web", "mobile", "both"]).optional(),
  is_active: z.boolean().optional(),
});

const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
  role: z.enum([
    "super_admin",
    "admin",
    "office_manager",
    "crew_manager",
    "pls_reviewer",
    "pls_assistant",
    "field_crew",
    "drafter",
    "shipping_admin",
  ]),
  platform_access: z.enum(["web", "mobile", "both"]).default("web"),
  team: z.enum(["residential", "public", "both"]).default("residential"),
});

const invitationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// GET /invitations → requireAdmin, list pending (unused, non-expired) invitations
// Defined before /:id to prevent route conflict
router.get(
  "/invitations",
  requireAdmin,
  validateQuery(invitationsQuerySchema),
  async (req: Request, res: Response) => {
    try {
      const { page, limit } = req.query as unknown as z.infer<typeof invitationsQuerySchema>;
      const where = {
        usedAt: null,
        expiresAt: { gt: new Date() },
      };
      const [invitations, total] = await Promise.all([
        prisma.invitation.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            createdByUser: { select: { id: true, name: true, email: true } },
          },
        }),
        prisma.invitation.count({ where }),
      ]);
      sendPaginated(res, invitations, page, limit, total);
    } catch (error) {
      sendError(res, error);
    }
  }
);

// GET / → requireAdmin, list users (paginated, filterable by role/team/is_active)
router.get(
  "/",
  requireAdmin,
  validateQuery(listQuerySchema),
  async (req: Request, res: Response) => {
    try {
      const { page, limit, role, team, is_active } =
        req.query as unknown as z.infer<typeof listQuerySchema>;

      const where: Record<string, unknown> = {};
      if (role) where["role"] = role;
      if (team) where["team"] = team;
      if (is_active !== undefined) where["isActive"] = is_active === "true";

      const [rawUsers, total] = await Promise.all([
        prisma.user.findMany({
          where,
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            team: true,
            platformAccess: true,
            isActive: true,
            emailVerified: true,
            crewId: true,
            crew: { select: { name: true } },
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.user.count({ where }),
      ]);

      const users = rawUsers.map(({ crew, ...user }) => ({
        ...user,
        crewName: crew?.name ?? null,
      }));

      sendPaginated(res, users, page, limit, total);
    } catch (error) {
      sendError(res, error);
    }
  }
);

const searchQuerySchema = z.object({
  q: z.string().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

// GET /search → requireAuth, search active staff users for @mention autocomplete
router.get(
  "/search",
  requireAuth,
  validateQuery(searchQuerySchema),
  async (req: Request, res: Response) => {
    try {
      const { q, limit } = req.query as unknown as z.infer<typeof searchQuerySchema>;

      const where: Record<string, unknown> = {
        isActive: true,
        platformAccess: { in: ["web", "both"] },
      };
      if (q.length > 0) {
        where.OR = [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ];
      }

      const users = await prisma.user.findMany({
        where,
        select: { id: true, name: true, email: true, role: true },
        take: limit,
        orderBy: { name: "asc" },
      });

      sendSuccess(res, users);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// GET /:id → requireAuth (own profile or admin)
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const requestingUser = req.user!;

    const isAdmin = ["admin", "super_admin", "office_manager"].includes(requestingUser.role);
    if (!isAdmin && requestingUser.userId !== id) {
      throw new AuthorizationError("You can only view your own profile");
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        team: true,
        platformAccess: true,
        isActive: true,
        emailVerified: true,
        notificationPreferences: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) throw new NotFoundError("User not found");
    sendSuccess(res, user);
  } catch (error) {
    sendError(res, error);
  }
});

// PUT /:id → requireAdmin, update user role/team/platformAccess/isActive, invalidate Redis cache
router.put(
  "/:id",
  requireAdmin,
  validateBody(updateUserSchema),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const body = req.body as z.infer<typeof updateUserSchema>;

      const existing = await prisma.user.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError("User not found");

      if (!canEditUser(req.user!.role, existing.role)) {
        throw new AuthorizationError("You do not have permission to edit this user");
      }

      if (body.role !== undefined && body.role !== existing.role && req.user!.userId === id) {
        throw new AuthorizationError("You cannot change your own role");
      }

      if (body.platform_access !== undefined && existing.crewId) {
        const crew = await prisma.crew.findUnique({
          where: { id: existing.crewId },
          select: { name: true },
        });
        throw new ConflictError(
          `Platform access is locked to Mobile while this user is assigned to ${crew?.name ?? "a crew"}`,
          { crewName: crew?.name }
        );
      }

      const updated = await prisma.user.update({
        where: { id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.role !== undefined && { role: body.role }),
          ...(body.team !== undefined && { team: body.team }),
          ...(body.platform_access !== undefined && { platformAccess: body.platform_access }),
          ...(body.is_active !== undefined && { isActive: body.is_active }),
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          team: true,
          platformAccess: true,
          isActive: true,
          updatedAt: true,
        },
      });

      await redis.del(permissionsKey(id!));
      logger.info("User updated and Redis permission cache invalidated", { userId: id });

      sendSuccess(res, updated);
    } catch (error) {
      sendError(res, error);
    }
  }
);

// POST /invite → requireAdmin, create invitation record, stub send invite email
router.post(
  "/invite",
  requireAdmin,
  validateBody(inviteSchema),
  async (req: Request, res: Response) => {
    try {
      const { email, name, role, platform_access, team } =
        req.body as z.infer<typeof inviteSchema>;
      const createdBy = req.user!.userId;

      const token = uuidv4();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const invitation = await prisma.invitation.create({
        data: {
          token,
          email,
          name,
          role,
          platformAccess: platform_access,
          team,
          expiresAt,
          createdBy,
        },
      });

      const inviteUrl = `${envStore.FRONTEND_URL}/setup/${token}`;

      await sendEmail({
        to: email,
        subject: "You have been invited to Pi Surveying Portal",
        html: [
          `<p>Hi ${name},</p>`,
          `<p>You've been invited to join the Pi Surveying Portal as <strong>${role}</strong>.</p>`,
          `<p><a href="${inviteUrl}">Accept your invitation</a></p>`,
          `<p>This invitation expires on ${expiresAt.toLocaleDateString()}.</p>`,
          `<p>— Pi Surveying</p>`,
        ].join("\n"),
      }).catch((err) => {
        logger.error("Failed to send invitation email", {
          error: String(err),
          invitationId: invitation.id,
        });
      });

      logger.info("User invitation created", { invitationId: invitation.id, email, role });
      sendSuccess(
        res,
        { id: invitation.id, email, name, role, token, expiresAt },
        201
      );
    } catch (error) {
      sendError(res, error);
    }
  }
);

// POST /invitations/:id/resend → requireAdmin, resend invitation email with fresh expiry
router.post("/invitations/:id/resend", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const invitation = await prisma.invitation.findUnique({
      where: { id },
      include: { crew: { select: { name: true } } },
    });
    if (!invitation) throw new NotFoundError("Invitation not found");

    if (invitation.usedAt) {
      throw new ConflictError("This invitation has already been accepted");
    }

    const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.invitation.update({
      where: { id },
      data: { expiresAt: newExpiry },
    });

    const inviteUrl = `${envStore.FRONTEND_URL}/setup/${invitation.token}`;
    const crewLine = invitation.crew
      ? ` to join <strong>${invitation.crew.name}</strong>`
      : "";

    await sendEmail({
      to: invitation.email,
      subject: "Reminder: You have been invited to Pi Surveying Portal",
      html: [
        `<p>Hi ${invitation.name},</p>`,
        `<p>This is a reminder that you've been invited${crewLine} at Pi Surveying Portal as <strong>${invitation.role.replace(/_/g, " ")}</strong>.</p>`,
        `<p><a href="${inviteUrl}">Accept your invitation</a></p>`,
        `<p>This invitation expires on ${newExpiry.toLocaleDateString()}.</p>`,
        `<p>— Pi Surveying</p>`,
      ].join("\n"),
    }).catch((err) => {
      logger.error("Failed to resend invitation email", {
        error: String(err),
        invitationId: id,
      });
    });

    logger.info("Invitation resent", { invitationId: invitation.id, email: invitation.email });
    sendSuccess(res, {
      id: invitation.id,
      email: invitation.email,
      name: invitation.name,
      expiresAt: newExpiry,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// DELETE /invitations/:id → requireAdmin, revoke invitation (set used_at if not already used)
router.delete("/invitations/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const invitation = await prisma.invitation.findUnique({ where: { id } });
    if (!invitation) throw new NotFoundError("Invitation not found");

    if (!invitation.usedAt) {
      await prisma.invitation.update({
        where: { id },
        data: { usedAt: new Date() },
      });
    }

    logger.info("Invitation revoked", { invitationId: id });
    sendNoContent(res);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
