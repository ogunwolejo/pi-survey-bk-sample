import { Router } from "express";
import { z } from "zod";
import type { Server as SocketServer } from "socket.io";
import { OrderStatus, type County } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { publicRateLimit } from "../middleware/rate-limit.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { getNextSequence } from "../lib/sequential-number";
import { NotFoundError, ValidationError } from "../lib/errors";
import { orderLogger as logger } from "../lib/logger";
import { emitDashboardEvent } from "../lib/socket-emitter";
import { findOrCreateFromSubmission } from "../services/contact.service";
import { calculateDates } from "../services/date-calculation.service";
import { notifyAdminsOrderNew } from "../services/notification.service";
import { identifyAndTrackEvent, CustomerIoEventsNames } from "../services/customerio.service";
import { sendOrderConfirmationEmail } from "../services/email.service";
import { envStore } from "../env-store";

const router = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const draftSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(7),
  company: z.string().optional(),
  customerType: z.string().optional(),
});

const finalizeSchema = z.object({
  propertyAddressLine1: z.string().min(1),
  propertyAddressLine2: z.string().optional(),
  propertyCity: z.string().min(1),
  propertyState: z.string().length(2),
  propertyZip: z.string().min(5),
  propertyCounty: z.string().min(1),
  pin: z.string().min(1),
  additionalPins: z.array(z.string()).default([]),
  propertyType: z
    .enum(["sfr", "sfr_townhome", "apartment", "commercial", "vacant_land", "farm", "other"])
    .optional(),
  surveyType: z.enum(["boundary", "alta", "condominium", "topography", "other"]),
  closingDate: z.string().optional(),
  requestedDate: z.string().optional(),
  deliveryPreference: z.enum(["pdf_only", "pdf_usps", "pdf_fedex"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  onsiteContactFirstName: z.string().optional(),
  onsiteContactLastName: z.string().optional(),
  onsiteContactPhone: z.string().optional(),
  lockedGates: z.enum(["yes", "no", "na"]).optional(),
  legalDescription: z.string().optional(),
  referralSource: z.string().optional(),
  billingAddressSameAsService: z.boolean().default(true),
  billingAddressLine1: z.string().optional(),
  billingAddressLine2: z.string().optional(),
  billingCity: z.string().optional(),
  billingState: z.string().optional(),
  billingZip: z.string().optional(),
});

// ─── POST /draft — create draft order from contact step ──────────────────────

router.post(
  "/draft",
  publicRateLimit,
  validateBody(draftSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof draftSchema>;
      const orderNumber = await getNextSequence("ORDER");

      const order = await prisma.order.create({
        data: {
          orderNumber,
          status: OrderStatus.draft,
          firstName: body.firstName,
          lastName: body.lastName,
          email: body.email,
          phone: body.phone,
          company: body.company,
          customerType: body.customerType as any,
          source: "website",
          lastCompletedStep: 1,
        },
      });

      logger.info("Draft order created from public form", {
        orderId: order.id,
        orderNumber,
        email: body.email,
      });

      identifyAndTrackEvent(
        order.id,
        { email: body.email, first_name: body.firstName, last_name: body.lastName },
        CustomerIoEventsNames.ORDER_FORM_STARTED,
        {
          order_id: order.id,
          order_number: order.orderNumber,
          form_resume_url: `${envStore.FRONTEND_URL}/order?resume=${order.id}`,
        },
      ).catch((err) => logger.warn("CustomerIO order_form_started failed", { err }));

      const io = req.app.get("io") as SocketServer | undefined;
      emitDashboardEvent(io, "dashboard:orders", "order:created", {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
      });

      res.status(201).json({
        data: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          lastCompletedStep: order.lastCompletedStep,
        },
      });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── GET /resume/:id — return draft order data for form resume ───────────────

router.get(
  "/resume/:id",
  publicRateLimit,
  async (req, res) => {
    try {
      const { id } = req.params as { id: string };

      const order = await prisma.order.findUnique({
        where: { id },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          lastCompletedStep: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          company: true,
          customerType: true,
          propertyAddressLine1: true,
          propertyAddressLine2: true,
          propertyCity: true,
          propertyState: true,
          propertyZip: true,
          propertyCounty: true,
          pin: true,
          additionalPins: true,
          propertyType: true,
          surveyType: true,
          closingDate: true,
          requestedDate: true,
          deliveryPreference: true,
          priority: true,
          onsiteContactFirstName: true,
          onsiteContactLastName: true,
          onsiteContactPhone: true,
          lockedGates: true,
          legalDescription: true,
          referralSource: true,
          billingAddressSameAsService: true,
          billingAddressLine1: true,
          billingAddressLine2: true,
          billingCity: true,
          billingState: true,
          billingZip: true,
        },
      });

      if (!order) {
        return sendError(res, new NotFoundError("Order not found"));
      }

      if (order.status !== OrderStatus.draft) {
        return res.status(410).json({
          error: {
            code: "ORDER_FINALIZED",
            message: "This order has already been submitted",
          },
        });
      }

      sendSuccess(res, order);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── PUT /:id/step/:stepNumber — progressive save ───────────────────────────

router.put(
  "/:id/step/:stepNumber",
  publicRateLimit,
  async (req, res) => {
    try {
      const { id, stepNumber } = req.params as { id: string; stepNumber: string };
      const step = parseInt(stepNumber, 10);
      if (isNaN(step) || step < 1 || step > 5) {
        throw new ValidationError("Invalid step number");
      }

      const order = await prisma.order.findUnique({
        where: { id },
        select: { id: true, status: true, lastCompletedStep: true },
      });

      if (!order) {
        throw new NotFoundError("Order not found");
      }
      if (order.status !== OrderStatus.draft) {
        throw new ValidationError("Order has already been finalized");
      }

      const data: Record<string, unknown> = {
        ...req.body,
        lastCompletedStep: Math.max(order.lastCompletedStep, step),
      };

      const updated = await prisma.order.update({
        where: { id },
        data,
        select: { id: true, lastCompletedStep: true },
      });

      sendSuccess(res, updated);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── PUT /:id/finalize — finalize draft with full remaining data ─────────────

router.put(
  "/:id/finalize",
  publicRateLimit,
  validateBody(finalizeSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof finalizeSchema>;

      const order = await prisma.order.findUnique({
        where: { id: req.params["id"]! },
        select: {
          id: true,
          status: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          orderNumber: true,
        },
      });

      if (!order) {
        throw new NotFoundError("Order not found");
      }
      if (order.status !== OrderStatus.draft) {
        throw new ValidationError("Order has already been finalized");
      }

      // Find or create client from draft contact info
      let clientId: string | undefined;
      if (order.email && order.firstName && order.lastName && order.phone) {
        const contact = await findOrCreateFromSubmission({
          firstName: order.firstName,
          lastName: order.lastName,
          email: order.email,
          phone: order.phone,
          customerType: "homeowner",
          source: "order_form",
        });
        clientId = (contact as { id: string }).id;
      }

      const closingDate = body.closingDate ? new Date(body.closingDate) : null;
      const requestedDate = body.requestedDate ? new Date(body.requestedDate) : null;
      const dates = clientId
        ? await calculateDates(closingDate, requestedDate, clientId)
        : {
            dropDeadDate: closingDate ?? new Date(Date.now() + 14 * 86400000),
            internalClosingDate: closingDate ?? new Date(Date.now() + 12 * 86400000),
            dueDate: closingDate ?? new Date(Date.now() + 11 * 86400000),
            isRush: false,
          };

      const updated = await prisma.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.new,
          clientId,
          propertyAddressLine1: body.propertyAddressLine1,
          propertyAddressLine2: body.propertyAddressLine2,
          propertyCity: body.propertyCity,
          propertyState: body.propertyState,
          propertyZip: body.propertyZip,
          propertyCounty: body.propertyCounty as County | undefined,
          pin: body.pin,
          additionalPins: body.additionalPins,
          propertyType: body.propertyType,
          surveyType: body.surveyType,
          closingDate,
          requestedDate,
          deliveryPreference: body.deliveryPreference,
          priority: body.priority ?? "normal",
          onsiteContactFirstName: body.onsiteContactFirstName,
          onsiteContactLastName: body.onsiteContactLastName,
          onsiteContactPhone: body.onsiteContactPhone,
          lockedGates: body.lockedGates,
          legalDescription: body.legalDescription,
          referralSource: body.referralSource,
          team: "residential",
          billingAddressSameAsService: body.billingAddressSameAsService,
          billingAddressLine1: body.billingAddressLine1,
          billingAddressLine2: body.billingAddressLine2,
          billingCity: body.billingCity,
          billingState: body.billingState,
          billingZip: body.billingZip,
          dropDeadDate: dates.dropDeadDate,
          internalClosingDate: dates.internalClosingDate,
          dueDate: dates.dueDate,
          isRush: dates.isRush,
          lastCompletedStep: 5,
        },
      });

      logger.info("Draft order finalized from public form", {
        orderId: updated.id,
        orderNumber: updated.orderNumber,
      });

      if (order.email) {
        identifyAndTrackEvent(
          order.id,
          { email: order.email, first_name: order.firstName, last_name: order.lastName },
          CustomerIoEventsNames.ORDER_FORM_COMPLETED,
          { order_id: updated.id, order_number: updated.orderNumber },
        ).catch((err: unknown) => logger.warn("CustomerIO order_form_completed failed", { err }));
      }

      const io = req.app.get("io") as SocketServer | undefined;
      emitDashboardEvent(io, "dashboard:orders", "order:updated", {
        orderId: updated.id,
        status: updated.status,
      });

      const clientName = `${order.firstName ?? ""} ${order.lastName ?? ""}`.trim() || "Unknown";
      notifyAdminsOrderNew(updated, clientName, io).catch(() => {});

      if (order.email && !updated.suppressClientEmails) {
        sendOrderConfirmationEmail({
          orderNumber: updated.orderNumber,
          clientEmail: order.email,
          clientFirstName: order.firstName ?? "",
          clientLastName: order.lastName ?? "",
          surveyType: updated.surveyType ?? "other",
          propertyAddressLine1: updated.propertyAddressLine1 ?? "",
          propertyAddressLine2: updated.propertyAddressLine2 ?? undefined,
          propertyCity: updated.propertyCity ?? "",
          propertyState: updated.propertyState ?? "",
          propertyZip: updated.propertyZip ?? "",
          propertyCounty: updated.propertyCounty ?? undefined,
          pin: updated.pin ?? "",
          closingDate: updated.closingDate,
          deliveryPreference: updated.deliveryPreference,
          onsiteContactFirstName: updated.onsiteContactFirstName,
          onsiteContactLastName: updated.onsiteContactLastName,
          onsiteContactPhone: updated.onsiteContactPhone,
        }).catch(() => {});
      }

      res.status(200).json({
        data: {
          id: updated.id,
          orderNumber: updated.orderNumber,
          status: updated.status,
        },
      });
    } catch (err) {
      sendError(res, err);
    }
  }
);

export default router;
