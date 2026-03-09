import { Router } from "express";
import type { Server as SocketServer } from "socket.io";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { sendSuccess, sendError, sendPaginated } from "../lib/response";
import { prisma } from "../lib/prisma";
import { z } from "zod";
import { ValidationError, NotFoundError } from "../lib/errors";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { RouteStatus, Team } from "@prisma/client";
import { generalLogger as logger } from "../lib/logger";
import {
  getPendingJobs,
  getCalendarCounts,
  getAvailableJobs,
  checkDoubleBooking,
  calculateDirections,
  fetchDistanceMatrix,
  publishRoute,
  cancelRoute,
  rescheduleRoute,
  updatePublishedRoute,
} from "../services/route.service";
import { ConflictError } from "../lib/errors";

const createRouteSchema = z.object({
  routeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  crewId: z.string().uuid(),
  jobIds: z.array(z.string().uuid()).min(1),
});

const updateRouteSchema = z.object({
  jobIds: z.array(z.string().uuid()).optional(),
  siteContacts: z.array(z.object({
    routeJobId: z.string().uuid(),
    siteContactName: z.string().optional(),
    siteContactEmail: z.string().email().optional(),
    siteContactPhone: z.string().optional(),
  })).optional(),
});

const cancelRouteSchema = z.object({
  reason: z.string().min(1).max(500),
});

const rescheduleRouteSchema = z.object({
  newDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().min(1).max(500),
});

const calendarCountsSchema = z.object({
  crewId: z.string().uuid(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

const availableJobsSchema = z.object({
  crewId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  refLat: z.coerce.number().min(-90).max(90).optional(),
  refLng: z.coerce.number().min(-180).max(180).optional(),
  excludeRouteId: z.string().uuid().optional(),
});

const distanceMatrixSchema = z.object({
  originLat: z.number().min(-90).max(90),
  originLng: z.number().min(-180).max(180),
  destinations: z.array(z.object({
    jobId: z.string().uuid(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })).min(1).max(100),
});

const routeListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.string().optional(),
  sort: z.enum(["routeDate", "createdAt", "status"]).default("routeDate"),
  order: z.enum(["asc", "desc"]).default("desc"),
  crewId: z.string().uuid().optional(),
});

export function createRouteRouter(io: SocketServer) {
  const router = Router();

  // GET /api/routes - list routes with pagination, filtering, sorting
  router.get(
    "/",
    requireAuth,
    requireRole("crew_manager", "office_manager", "admin"),
    async (req, res) => {
      try {
        const params = routeListSchema.parse(req.query);
        const where: Record<string, unknown> = {};
        if (params.crewId) where.crewId = params.crewId;
        if (params.status) {
          const statuses = params.status.split(",").map((s) => s.trim());
          where.status = { in: statuses };
        }

        const [routes, total] = await Promise.all([
          prisma.route.findMany({
            where,
            include: {
              crew: { select: { id: true, name: true, crewNumber: true } },
              routeJobs: {
                orderBy: { sortOrder: "asc" },
                include: { job: { select: { id: true, jobNumber: true, order: { select: { propertyAddressLine1: true, propertyCity: true } } } } },
              },
              _count: { select: { routeJobs: true } },
            },
            orderBy: { [params.sort]: params.order },
            skip: (params.page - 1) * params.limit,
            take: params.limit,
          }),
          prisma.route.count({ where }),
        ]);

        sendPaginated(res, routes, params.page, params.limit, total);
      } catch (err) {
        if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
        else sendError(res, err);
      }
    }
  );

  // GET /api/routes/calendar-counts - aggregated job counts per date for calendar highlights
  router.get(
    "/calendar-counts",
    requireAuth,
    requireRole("crew_manager", "office_manager", "admin"),
    async (req, res) => {
      try {
        const { crewId, month } = calendarCountsSchema.parse(req.query);
        const monthStart = new Date(`${month}-01`);
        const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
        const data = await getCalendarCounts(crewId, monthStart, monthEnd);
        sendSuccess(res, data);
      } catch (err) {
        if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
        else sendError(res, err);
      }
    }
  );

  // GET /api/routes/available-jobs - crew-scoped, date-filtered jobs with optional distance
  router.get(
    "/available-jobs",
    requireAuth,
    requireRole("crew_manager", "office_manager", "admin"),
    async (req, res) => {
      try {
        const { crewId, date, refLat, refLng, excludeRouteId } = availableJobsSchema.parse(req.query);
        const data = await getAvailableJobs(crewId, new Date(date), refLat, refLng, excludeRouteId);
        sendSuccess(res, data);
      } catch (err) {
        if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
        else sendError(res, err);
      }
    }
  );

  // POST /api/routes/distance-matrix - Google Maps driving distances from reference point
  router.post(
    "/distance-matrix",
    requireAuth,
    requireRole("crew_manager", "office_manager", "admin"),
    async (req, res) => {
      try {
        const { originLat, originLng, destinations } = distanceMatrixSchema.parse(req.body);
        const results = await fetchDistanceMatrix(
          { lat: originLat, lng: originLng },
          destinations
        );
        sendSuccess(res, results);
      } catch (err) {
        if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
        else sendError(res, err);
      }
    }
  );

  // GET /api/routes/pending-jobs - jobs available for route planning
  router.get(
    "/pending-jobs",
    requireAuth,
    requireRole("crew_manager", "office_manager", "admin"),
    async (req, res) => {
      try {
        const jobs = await getPendingJobs(req.query.team as Team | undefined);
        sendSuccess(res, jobs);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  // POST /api/routes - create a route (with double-booking prevention)
  router.post(
    "/",
    requireAuth,
    requireRole("crew_manager", "office_manager", "admin"),
    async (req, res) => {
      try {
        const data = createRouteSchema.parse(req.body);

        const conflicts = await checkDoubleBooking(data.jobIds);
        if (conflicts.length > 0) {
          sendError(res, new ConflictError("One or more jobs are already on an active route", conflicts));
          return;
        }

        const route = await prisma.route.create({
          data: {
            routeDate: new Date(data.routeDate),
            crewId: data.crewId,
            createdBy: req.user!.userId,
            routeJobs: {
              create: data.jobIds.map((jobId, index) => ({
                jobId,
                sortOrder: index,
              })),
            },
          },
          include: {
            crew: { select: { id: true, name: true } },
            routeJobs: { orderBy: { sortOrder: "asc" } },
          },
        });
        logger.info("Route created", { routeId: route.id, crewId: data.crewId, routeDate: data.routeDate, jobCount: data.jobIds.length });
        io.to(ROOM_PREFIXES.PIPELINE_BOARD).emit("route:created", {
          routeId: route.id,
          crewId: data.crewId,
          routeDate: data.routeDate,
        });
        sendSuccess(res, route, 201);
      } catch (err) {
        if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
        else sendError(res, err);
      }
    }
  );

  // GET /api/routes/:id - get single route
  router.get(
    "/:id",
    requireAuth,
    requireRole("crew_manager", "office_manager", "admin"),
    async (req, res) => {
      try {
        const route = await prisma.route.findUnique({
          where: { id: req.params["id"] },
          include: {
            crew: { select: { id: true, name: true, crewNumber: true } },
            routeJobs: {
              orderBy: { sortOrder: "asc" },
              include: {
                job: {
                  select: {
                    id: true, jobNumber: true, status: true, stakingRequired: true,
                    specialNotes: true, isAlta: true, propertyLat: true, propertyLng: true,
                    order: { select: { propertyAddressLine1: true, propertyCity: true, propertyState: true, propertyZip: true } },
                  },
                },
              },
            },
          },
        });
        if (!route) { sendError(res, new NotFoundError("Route")); return; }
        sendSuccess(res, route);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  // PUT /api/routes/:id - update route jobs / site contacts
  router.put(
    "/:id",
    requireAuth,
    requireRole("crew_manager", "office_manager", "admin"),
    async (req, res) => {
      try {
        const data = updateRouteSchema.parse(req.body);
        const route = await prisma.route.findUnique({ where: { id: req.params["id"] } });
        if (!route) { sendError(res, new NotFoundError("Route")); return; }

        if (route.status === RouteStatus.cancelled || route.status === RouteStatus.completed) {
          sendError(res, new ValidationError(`${route.status} routes cannot be modified.`));
          return;
        }

        if (route.status === RouteStatus.published) {
          const updated = await updatePublishedRoute({
            routeId: route.id,
            jobIds: data.jobIds,
            siteContacts: data.siteContacts,
          });
          sendSuccess(res, updated);
          return;
        }

        // Draft route — simple replacement
        await prisma.$transaction(async (tx) => {
          if (data.jobIds) {
            await tx.routeJob.deleteMany({ where: { routeId: route.id } });
            await tx.routeJob.createMany({
              data: data.jobIds.map((jobId, index) => ({ routeId: route.id, jobId, sortOrder: index })),
            });
          }
          if (data.siteContacts) {
            for (const sc of data.siteContacts) {
              await tx.routeJob.update({
                where: { id: sc.routeJobId },
                data: {
                  siteContactName: sc.siteContactName,
                  siteContactEmail: sc.siteContactEmail,
                  siteContactPhone: sc.siteContactPhone,
                },
              });
            }
          }
        });

        const updated = await prisma.route.findUnique({
          where: { id: route.id },
          include: { routeJobs: { orderBy: { sortOrder: "asc" } } },
        });
        sendSuccess(res, updated);
      } catch (err) {
        if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
        else sendError(res, err);
      }
    }
  );

  // POST /api/routes/:id/calculate-directions
  router.post(
    "/:id/calculate-directions",
    requireAuth,
    requireRole("crew_manager", "office_manager", "admin"),
    async (req, res) => {
      try {
        const result = await calculateDirections(req.params["id"]!);
        if (!result) { sendError(res, new NotFoundError("Route or insufficient waypoints")); return; }
        sendSuccess(res, result);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  // POST /api/routes/:id/publish
  router.post(
    "/:id/publish",
    requireAuth,
    requireRole("crew_manager", "office_manager", "admin"),
    async (req, res) => {
      try {
        const published = await publishRoute(req.params["id"]!, req.user!.userId);
        logger.info("Route published", { routeId: req.params["id"]! });
        io.to(ROOM_PREFIXES.PIPELINE_BOARD).emit("route:published", { routeId: req.params["id"] });
        sendSuccess(res, published);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  // POST /api/routes/:id/cancel
  router.post(
    "/:id/cancel",
    requireAuth,
    requireRole("crew_manager", "office_manager", "admin"),
    async (req, res) => {
      try {
        const { reason } = cancelRouteSchema.parse(req.body);
        await cancelRoute(req.params["id"]!, reason);
        logger.info("Route cancelled", { routeId: req.params["id"]!, reason });
        io.to(ROOM_PREFIXES.PIPELINE_BOARD).emit("route:cancelled", { routeId: req.params["id"] });
        sendSuccess(res, { message: "Route cancelled" });
      } catch (err) {
        if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
        else sendError(res, err);
      }
    }
  );

  // POST /api/routes/:id/reschedule
  router.post(
    "/:id/reschedule",
    requireAuth,
    requireRole("crew_manager", "office_manager", "admin"),
    async (req, res) => {
      try {
        const { newDate, reason } = rescheduleRouteSchema.parse(req.body);
        const updated = await rescheduleRoute(req.params["id"]!, new Date(newDate), reason);
        logger.info("Route rescheduled", { routeId: req.params["id"]!, newDate, reason });
        io.to(ROOM_PREFIXES.PIPELINE_BOARD).emit("route:updated", { routeId: req.params["id"] });
        sendSuccess(res, updated);
      } catch (err) {
        if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
        else sendError(res, err);
      }
    }
  );

  // GET /api/routes/my-today (for mobile field crew)
  router.get(
    "/my-today",
    requireAuth,
    requireRole("field_crew"),
    async (req, res) => {
      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const user = await prisma.user.findUnique({
          where: { id: req.user!.userId },
          select: { crewId: true },
        });
        if (!user?.crewId) { sendSuccess(res, null); return; }

        const route = await prisma.route.findFirst({
          where: {
            crewId: user.crewId,
            routeDate: { gte: today },
            status: RouteStatus.published,
          },
          orderBy: { routeDate: "asc" },
          include: {
            routeJobs: {
              orderBy: { sortOrder: "asc" },
              include: {
                job: {
                  select: {
                    id: true, jobNumber: true, status: true, stakingRequired: true,
                    specialNotes: true, isAlta: true,
                    order: { select: { propertyAddressLine1: true, propertyCity: true, propertyState: true, propertyZip: true } },
                  },
                },
              },
            },
          },
        });

        sendSuccess(res, route);
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  return router;
}
