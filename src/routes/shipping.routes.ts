import { Router } from "express";
import { z } from "zod";
import { ShippingTaskStatus, Prisma } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { prisma } from "../lib/prisma";
import { orderLogger as logger } from "../lib/logger";
import { sendSuccess, sendPaginated, sendError } from "../lib/response";
import { NotFoundError, ValidationError } from "../lib/errors";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(["pending", "ready_to_ship", "shipped"]).optional(),
  carrier: z.enum(["usps", "fedex"]).optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
});

const updateTaskSchema = z.object({
  notes: z.string().optional(),
  mailingAddressLine1: z.string().optional(),
  mailingAddressLine2: z.string().optional(),
  mailingCity: z.string().optional(),
  mailingState: z.string().optional(),
  mailingZip: z.string().optional(),
  recipientName: z.string().optional(),
  status: z.enum(["pending", "ready_to_ship"]).optional(),
});

const markShippedSchema = z.object({
  trackingNumber: z.string().min(1),
});

const bulkMarkSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        trackingNumber: z.string().min(1),
      })
    )
    .min(1),
});

const labelsBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

// ─── GET /summary ─────────────────────────────────────────────────────────────

router.get("/summary", requireAuth, async (_req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [pending, readyToShip, shippedToday, byUsps, byFedex] = await Promise.all([
      prisma.shippingTask.count({ where: { status: ShippingTaskStatus.pending } }),
      prisma.shippingTask.count({ where: { status: ShippingTaskStatus.ready_to_ship } }),
      prisma.shippingTask.count({
        where: { status: ShippingTaskStatus.shipped, shippedAt: { gte: today, lt: tomorrow } },
      }),
      prisma.shippingTask.count({ where: { status: { not: ShippingTaskStatus.shipped }, carrier: "usps" } }),
      prisma.shippingTask.count({ where: { status: { not: ShippingTaskStatus.shipped }, carrier: "fedex" } }),
    ]);

    sendSuccess(res, {
      pending,
      ready_to_ship: readyToShip,
      shipped_today: shippedToday,
      by_carrier: { usps: byUsps, fedex: byFedex },
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get("/", requireAuth, validateQuery(listQuerySchema), async (req, res) => {
  try {
    const q = req.query as unknown as z.infer<typeof listQuerySchema>;

    const where: Prisma.ShippingTaskWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.carrier ? { carrier: q.carrier } : {}),
      ...(q.date_from || q.date_to
        ? {
            createdAt: {
              ...(q.date_from ? { gte: new Date(q.date_from) } : {}),
              ...(q.date_to ? { lte: new Date(q.date_to) } : {}),
            },
          }
        : {}),
    };

    const [total, tasks] = await Promise.all([
      prisma.shippingTask.count({ where }),
      prisma.shippingTask.findMany({
        where,
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        orderBy: { createdAt: "desc" },
        include: {
          client: { select: { id: true, firstName: true, lastName: true } },
          job: { select: { id: true, jobNumber: true } },
          order: { select: { id: true, orderNumber: true } },
        },
      }),
    ]);

    sendPaginated(res, tasks, q.page, q.limit, total);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

router.put("/:id", requireAuth, requireRole("shipping_admin"), validateBody(updateTaskSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof updateTaskSchema>;

    const task = await prisma.shippingTask.findUnique({ where: { id: req.params["id"]! } });
    if (!task) throw new NotFoundError("Shipping task not found");

    if (task.status === ShippingTaskStatus.shipped) {
      throw new ValidationError("Cannot update a shipped task");
    }

    const data: Prisma.ShippingTaskUpdateInput = {};
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.mailingAddressLine1 !== undefined) data.mailingAddressLine1 = body.mailingAddressLine1;
    if (body.mailingAddressLine2 !== undefined) data.mailingAddressLine2 = body.mailingAddressLine2;
    if (body.mailingCity !== undefined) data.mailingCity = body.mailingCity;
    if (body.mailingState !== undefined) data.mailingState = body.mailingState;
    if (body.mailingZip !== undefined) data.mailingZip = body.mailingZip;
    if (body.recipientName !== undefined) data.recipientName = body.recipientName;
    if (body.status !== undefined) data.status = body.status;

    const updated = await prisma.shippingTask.update({ where: { id: req.params["id"]! }, data });
    logger.info("Shipping task updated", { taskId: updated.id, status: updated.status });
    sendSuccess(res, updated);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── PUT /:id/mark-shipped ────────────────────────────────────────────────────

router.put(
  "/:id/mark-shipped",
  requireAuth,
  requireRole("shipping_admin"),
  validateBody(markShippedSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof markShippedSchema>;

      const task = await prisma.shippingTask.findUnique({ where: { id: req.params["id"]! } });
      if (!task) throw new NotFoundError("Shipping task not found");

      if (task.status === ShippingTaskStatus.shipped) {
        throw new ValidationError("Task is already marked as shipped");
      }

      const updated = await prisma.shippingTask.update({
        where: { id: req.params["id"]! },
        data: {
          status: ShippingTaskStatus.shipped,
          trackingNumber: body.trackingNumber,
          shippedAt: new Date(),
          shippedBy: req.user!.userId,
        },
        include: {
          client: { select: { id: true, firstName: true, lastName: true } },
          job: { select: { id: true, jobNumber: true } },
        },
      });

      const io = req.app.get("io") as SocketServer | undefined;
      io?.emit("shipping:task_shipped", {
        taskId: updated.id,
        orderId: updated.orderId,
        trackingNumber: body.trackingNumber,
        carrier: updated.carrier,
      });

      logger.info("Shipping task marked shipped", {
        taskId: updated.id,
        trackingNumber: body.trackingNumber,
      });

      sendSuccess(res, updated);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── POST /bulk-mark ──────────────────────────────────────────────────────────

router.post(
  "/bulk-mark",
  requireAuth,
  requireRole("shipping_admin"),
  validateBody(bulkMarkSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof bulkMarkSchema>;
      const ids = body.items.map((item) => item.id);

      const tasks = await prisma.shippingTask.findMany({
        where: { id: { in: ids }, status: { not: ShippingTaskStatus.shipped } },
        select: { id: true },
      });

      const validIds = tasks.map((t) => t.id);

      const results = await Promise.all(
        body.items
          .filter((item) => validIds.includes(item.id))
          .map((item) =>
            prisma.shippingTask.update({
              where: { id: item.id },
              data: {
                status: ShippingTaskStatus.shipped,
                trackingNumber: item.trackingNumber,
                shippedAt: new Date(),
                shippedBy: req.user!.userId,
              },
              select: { id: true, trackingNumber: true, orderId: true },
            })
          )
      );

      logger.info("Shipping tasks bulk-marked shipped", { count: results.length });
      sendSuccess(res, { updated: results.length, tasks: results });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── GET /:id/label ───────────────────────────────────────────────────────────

router.get("/:id/label", requireAuth, requireRole("shipping_admin"), async (req, res) => {
  try {
    const task = await prisma.shippingTask.findUnique({
      where: { id: req.params["id"]! },
      include: {
        client: { select: { id: true, firstName: true, lastName: true } },
        job: { select: { id: true, jobNumber: true } },
        order: { select: { id: true, orderNumber: true, pin: true, propertyAddressLine1: true, propertyCity: true, propertyState: true } },
      },
    });

    if (!task) throw new NotFoundError("Shipping task not found");

    sendSuccess(res, {
      recipientName: task.recipientName,
      addressLine1: task.mailingAddressLine1,
      addressLine2: task.mailingAddressLine2,
      city: task.mailingCity,
      state: task.mailingState,
      zip: task.mailingZip,
      carrier: task.carrier,
      trackingNumber: task.trackingNumber,
      jobNumber: task.job.jobNumber,
      fileNumber: task.order.pin,
      orderNumber: task.order.orderNumber,
      propertyAddress: `${task.order.propertyAddressLine1}, ${task.order.propertyCity}, ${task.order.propertyState}`,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /labels ─────────────────────────────────────────────────────────────

router.post(
  "/labels",
  requireAuth,
  requireRole("shipping_admin"),
  validateBody(labelsBodySchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof labelsBodySchema>;

      const tasks = await prisma.shippingTask.findMany({
        where: { id: { in: body.ids } },
        include: {
          job: { select: { jobNumber: true } },
          order: {
            select: {
              orderNumber: true,
              pin: true,
              propertyAddressLine1: true,
              propertyCity: true,
              propertyState: true,
            },
          },
        },
      });

      const labels = tasks.map((task) => ({
        id: task.id,
        recipientName: task.recipientName,
        addressLine1: task.mailingAddressLine1,
        addressLine2: task.mailingAddressLine2,
        city: task.mailingCity,
        state: task.mailingState,
        zip: task.mailingZip,
        carrier: task.carrier,
        trackingNumber: task.trackingNumber,
        jobNumber: task.job.jobNumber,
        fileNumber: task.order.pin,
        orderNumber: task.order.orderNumber,
        propertyAddress: `${task.order.propertyAddressLine1}, ${task.order.propertyCity}, ${task.order.propertyState}`,
      }));

      sendSuccess(res, labels);
    } catch (err) {
      sendError(res, err);
    }
  }
);

export default router;
