import { Router } from "express";
import { z } from "zod";
import type { Server as SocketServer } from "socket.io";
import { OrderStatus, JobStatus, AuditSource, CustomerType, ChatEntityType, type County } from "@prisma/client";
import { createSystemEvent as createChatSystemEvent } from "../services/chat.service";
import { prisma } from "../lib/prisma";
import { requireAuth, optionalAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { teamFilterMiddleware, getTeamFilter } from "../middleware/team-filter.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import { publicRateLimit } from "../middleware/rate-limit.middleware";
import { sendSuccess, sendPaginated, sendError } from "../lib/response";
import { getNextSequence } from "../lib/sequential-number";
import { canTransition } from "../lib/status-engine";
import { withTransaction } from "../lib/transaction";
import { subDays } from "date-fns";
import {
  subtractBusinessDays,
  addBusinessDays,
  datesToHolidaySet,
  type HolidaySet,
} from "../lib/date-utils";
import { getRushFeeSetting } from "../services/pricing-shared";
import { findOrCreateFromSubmission } from "../services/contact.service";
import { NotFoundError, ValidationError, ConflictError } from "../lib/errors";
import { envStore } from "../env-store";
import { orderLogger as logger } from "../lib/logger";
import { emitDashboardEvent } from "../lib/socket-emitter";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { notifyAdminsOrderNew, notifyAdminsResearchComplete, notifyResearchLeader } from "../services/notification.service";
import { sendOrderConfirmationEmail } from "../services/email.service";
import * as orderResearch from "../services/order-research.service";
import * as orderPricing from "../services/order-pricing.service";
import * as orderRushFee from "../services/order-rush-fee.service";
import {
  sendOrderToClient,
  resendOrderToClient,
} from "../services/order-proposal.service";
import { computeCompleteness } from "../services/order-document.service";
import {
  computePaymentInfo,
  computePaymentInfoBatch,
} from "../services/payment-gate.service";
import { sendEmail } from "../services/email.service";
import { researchEscalationEmailHtml } from "../services/email-templates";

const router = Router();

// ─── Roles that can see sensitive date fields ─────────────────────────────────

const ADMIN_ROLES = new Set(["super_admin", "admin", "office_manager"]);

function isAdminUser(role: string): boolean {
  return ADMIN_ROLES.has(role);
}

// ─── Date calculation logic ───────────────────────────────────────────────────

async function loadHolidays(): Promise<HolidaySet> {
  const rows = await prisma.holiday.findMany({ select: { date: true } });
  return datesToHolidaySet(rows.map((r) => r.date));
}

function countBusinessDaysUntil(from: Date, to: Date, holidays: HolidaySet): number {
  let count = 0;
  let cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);

  while (cursor < end) {
    const day = cursor.getDay();
    const dateStr = cursor.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !holidays.has(dateStr)) {
      count++;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

interface DateCalcInput {
  closingDate?: Date | null;
  requestedDate?: Date | null;
  isOrtClient?: boolean;
}

interface DateCalcResult {
  dropDeadDate: Date;
  internalClosingDate: Date;
  dueDate: Date;
  isRush: boolean;
}

async function calculateDates(input: DateCalcInput): Promise<DateCalcResult> {
  const holidays = await loadHolidays();
  const today = new Date();

  const dropDeadDate =
    input.closingDate ?? input.requestedDate ?? addBusinessDays(today, 14, holidays);

  const internalOffsetDays = input.isOrtClient ? 3 : 2;
  const internalClosingDate = subtractBusinessDays(dropDeadDate, internalOffsetDays, holidays);

  // dueDate = 3 calendar days before the user-provided date (dropDeadDate)
  const dueDate = new Date(dropDeadDate);
  dueDate.setDate(dueDate.getDate() - 3);

  const businessDaysUntilDue = countBusinessDaysUntil(today, dueDate, holidays);
  const isRush = businessDaysUntilDue <= 7;

  return { dropDeadDate, internalClosingDate, dueDate, isRush };
}

function stripSensitiveDates<T extends Record<string, unknown>>(order: T): T {
  return { ...order, dropDeadDate: null, internalClosingDate: null };
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.string().optional(),
  search: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  due_date_from: z.string().optional(),
  due_date_to: z.string().optional(),
  county: z.string().optional(),
  survey_type: z.string().optional(),
  payment_status: z.string().optional(),
  team: z.enum(["residential", "public"]).optional(),
});

const createOrderSchema = z.object({
  // client info (for public submissions, may not have clientId yet)
  clientId: z.string().uuid().optional(),
  clientFirstName: z.string().optional(),
  clientLastName: z.string().optional(),
  clientEmail: z.string().email().optional(),
  clientPhone: z.string().optional(),
  billingClientId: z.string().uuid().optional(),
  // order fields
  orderType: z.enum(["standard", "public_municipal"]).default("standard"),
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
  price: z.number().positive().optional(),
  paymentTerms: z.enum(["pre_pay", "fifty_fifty", "full_with_discount", "post_closing"]).optional(),
  closingDate: z.string().optional(),
  requestedDate: z.string().optional(),
  onsiteContactFirstName: z.string().optional(),
  onsiteContactLastName: z.string().optional(),
  onsiteContactPhone: z.string().optional(),
  lockedGates: z.enum(["yes", "no", "na"]).optional(),
  deliveryPreference: z.enum(["pdf_only", "pdf_usps", "pdf_fedex"]).optional(),
  legalDescription: z.string().optional(),
  source: z.enum(["website", "internal", "quote_acceptance"]),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  team: z.enum(["residential", "public"]),
  suppressClientEmails: z.boolean().default(false),
  internalNotes: z.string().optional(),
  referralSource: z.string().optional(),
});

// Separate schema for updates – all fields optional so both the edit modal
// and lightweight partial updates (notes, pin location) share one endpoint.
// Nullable fields mirror the Prisma model (String?, Enum?).
const updateOrderSchema = createOrderSchema
  .partial()
  .omit({ source: true, clientFirstName: true, clientLastName: true, clientEmail: true, clientPhone: true })
  .extend({
    customerType: z.string().nullable().optional(),
    propertyAddressLine2: z.string().nullable().optional(),
    closingDate: z.string().nullable().optional(),
    requestedDate: z.string().nullable().optional(),
    onsiteContactFirstName: z.string().nullable().optional(),
    onsiteContactLastName: z.string().nullable().optional(),
    onsiteContactPhone: z.string().nullable().optional(),
    lockedGates: z.enum(["yes", "no", "na"]).nullable().optional(),
    deliveryPreference: z.enum(["pdf_only", "pdf_usps", "pdf_fedex"]).nullable().optional(),
    legalDescription: z.string().nullable().optional(),
    internalNotes: z.string().nullable().optional(),
    referralSource: z.string().nullable().optional(),
    price: z.number().nonnegative().nullable().optional(),
    pinLatitude: z.number().min(-90).max(90).nullable().optional(),
    pinLongitude: z.number().min(-180).max(180).nullable().optional(),
  })
  .refine(
    (data) => {
      const hasLat = data.pinLatitude !== null && data.pinLatitude !== undefined;
      const hasLng = data.pinLongitude !== null && data.pinLongitude !== undefined;
      return hasLat === hasLng;
    },
    { message: "Both pinLatitude and pinLongitude must be provided together" }
  );

const statusSchema = z.object({
  status: z.string().min(1),
  reason: z.string().optional(),
});

const calculateDatesSchema = z.object({
  closingDate: z.string().optional(),
  requestedDate: z.string().optional(),
  isOrtClient: z.boolean().default(false),
});

// ─── GET /search ──────────────────────────────────────────────────────────────

const orderSearchSchema = z.object({
  q: z.string().min(2).max(100),
  limit: z.coerce.number().int().positive().max(20).default(10),
});

router.get(
  "/search",
  requireAuth,
  validateQuery(orderSearchSchema),
  async (req, res) => {
    try {
      const { q, limit } = req.query as unknown as z.infer<typeof orderSearchSchema>;

      const orders = await prisma.order.findMany({
        where: {
          deletedAt: null,
          OR: [
            { orderNumber: { contains: q, mode: "insensitive" } },
            { propertyAddressLine1: { contains: q, mode: "insensitive" } },
            { propertyCity: { contains: q, mode: "insensitive" } },
            { client: { OR: [
              { firstName: { contains: q, mode: "insensitive" } },
              { lastName: { contains: q, mode: "insensitive" } },
            ] } },
          ],
        },
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          client: { select: { id: true, firstName: true, lastName: true } },
          quote: { select: { id: true, quoteNumber: true, status: true } },
          jobs: { select: { id: true, jobNumber: true, status: true } },
        },
      });

      const { canCollectPayment } = await import("../services/payment-gate.service");

      const results = await Promise.all(
        orders.map(async (o) => {
          const eligibility = await canCollectPayment(o.id);
          const price = Number(o.price ?? 0);
          const amountPaid = Number(o.amountPaid);
          const balanceRemaining = Number(o.balanceRemaining);
          return {
            id: o.id,
            orderNumber: o.orderNumber,
            status: o.status,
            price: price || null,
            amountPaid,
            balanceRemaining,
            surveyType: o.surveyType,
            propertyAddressLine1: o.propertyAddressLine1,
            propertyCity: o.propertyCity,
            propertyState: o.propertyState,
            client: o.client,
            quote: o.quote,
            jobs: o.jobs,
            canCollectPayment: eligibility.eligible,
            fullyPaid: balanceRemaining <= 0 && price > 0,
          };
        }),
      );

      sendSuccess(res, results);
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  teamFilterMiddleware,
  validateQuery(listQuerySchema),
  async (req, res) => {
    try {
      const q = req.query as unknown as z.infer<typeof listQuerySchema>;
      const teamFilter = getTeamFilter(res);
      const userIsAdmin = isAdminUser(req.user!.role);

      const where: Record<string, unknown> = {
        deletedAt: null,
        ...(teamFilter.team ? { team: teamFilter.team } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.county ? { propertyCounty: { contains: q.county, mode: "insensitive" } } : {}),
        ...(q.survey_type ? { surveyType: q.survey_type } : {}),
        ...(q.search
          ? {
              OR: [
                { orderNumber: { contains: q.search, mode: "insensitive" } },
                { propertyAddressLine1: { contains: q.search, mode: "insensitive" } },
                { propertyCity: { contains: q.search, mode: "insensitive" } },
                { propertyCounty: { contains: q.search, mode: "insensitive" } },
                {
                  client: {
                    OR: [
                      { firstName: { contains: q.search, mode: "insensitive" } },
                      { lastName: { contains: q.search, mode: "insensitive" } },
                      { email: { contains: q.search, mode: "insensitive" } },
                    ],
                  },
                },
              ],
            }
          : {}),
        ...(q.date_from || q.date_to
          ? {
              createdAt: {
                ...(q.date_from ? { gte: new Date(q.date_from) } : {}),
                ...(q.date_to ? { lte: new Date(q.date_to) } : {}),
              },
            }
          : {}),
        ...(q.due_date_from || q.due_date_to
          ? {
              dueDate: {
                ...(q.due_date_from ? { gte: new Date(q.due_date_from) } : {}),
                ...(q.due_date_to ? { lte: new Date(q.due_date_to) } : {}),
              },
            }
          : {}),
        ...(q.payment_status
          ? { invoices: { some: { status: q.payment_status } } }
          : {}),
      };

      const [orders, total] = await Promise.all([
        prisma.order.findMany({
          where,
          skip: (q.page - 1) * q.limit,
          take: q.limit,
          orderBy: { createdAt: "desc" },
          include: {
            client: { select: { id: true, firstName: true, lastName: true, email: true } },
            jobs: { select: { id: true, jobNumber: true, status: true } },
          },
        }),
        prisma.order.count({ where }),
      ]);

      const orderIds = orders.map((o) => o.id);
      const paymentInfoMap = await computePaymentInfoBatch(orderIds);

      const enriched = orders.map((o) => ({
        ...(userIsAdmin ? o : stripSensitiveDates(o as unknown as Record<string, unknown>)),
        paymentInfo: paymentInfoMap.get(o.id) ?? null,
      }));

      sendPaginated(res, enriched, q.page, q.limit, total);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── GET /:id ─────────────────────────────────────────────────────────────────

router.get("/:id", requireAuth, teamFilterMiddleware, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params["id"]! },
      include: {
        client: true,
        billingClient: true,
        quote: {
          include: {
            client: true,
            billingClient: true,
            payments: true,
          },
        },
        jobs: true,
        invoices: {
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            totalAmount: true,
            balanceDue: true,
          },
        },
        payments: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
      },
    });

    if (!order || order.deletedAt) {
      throw new NotFoundError(`Order ${req.params["id"]!} not found`);
    }

    const [orderSignatureCount, quoteSignatureCount, paymentInfo, researchFields] = await Promise.all([
      prisma.orderContractSignature.count({ where: { orderId: order.id } }),
      order.quoteId
        ? prisma.contractSignature.count({ where: { quoteId: order.quoteId } })
        : Promise.resolve(0),
      computePaymentInfo(order.id),
      prisma.orderResearchField.findMany({
        where: { orderId: order.id },
        include: { createdByUser: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const proposalSigned = orderSignatureCount > 0 || quoteSignatureCount > 0;

    const userIsAdmin = isAdminUser(req.user!.role);
    const base = userIsAdmin
      ? order
      : stripSensitiveDates(order as unknown as Record<string, unknown>);

    sendSuccess(res, { ...base, proposalSigned, paymentInfo, researchFields });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST / ───────────────────────────────────────────────────────────────────

router.post(
  "/",
  (req, res, next) => {
    const body = req.body as { source?: string };
    if (body.source === "website") {
      publicRateLimit(req, res, () => optionalAuth(req, res, next));
      return;
    }
    return requireAuth(req, res, next);
  },
  validateBody(createOrderSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof createOrderSchema>;

      // Resolve client: use provided clientId or find/create from submission data
      let clientId = body.clientId;
      if (!clientId) {
        if (!body.clientEmail || !body.clientFirstName || !body.clientLastName || !body.clientPhone) {
          throw new ValidationError(
            "clientId or (clientFirstName, clientLastName, clientEmail, clientPhone) required"
          );
        }
        const contact = await findOrCreateFromSubmission({
          firstName: body.clientFirstName,
          lastName: body.clientLastName,
          email: body.clientEmail,
          phone: body.clientPhone,
          customerType: "homeowner",
          source: body.source === "website" ? "order_form" : "internal",
        });
        clientId = (contact as { id: string }).id;
      }

      // Check if client is ORT for date offset calculation
      const clientCompanies = await prisma.companyContact.findMany({
        where: { clientId },
        include: { company: { select: { isOrt: true } } },
      });
      const isOrtClient = clientCompanies.some((cc) => cc.company.isOrt);

      const closingDate = body.closingDate ? new Date(body.closingDate) : null;
      const requestedDate = body.requestedDate ? new Date(body.requestedDate) : null;

      const dates = await calculateDates({ closingDate, requestedDate, isOrtClient });
      const orderNumber = await getNextSequence("ORDER");
      const rushFeeAmount = dates.isRush ? await getRushFeeSetting() : null;

      const order = await prisma.order.create({
        data: {
          orderNumber,
          clientId,
          billingClientId: body.billingClientId,
          status: OrderStatus.new,
          orderType: body.orderType,
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
          price: body.price ?? 0,
          paymentTerms: body.paymentTerms ?? "pre_pay",
          closingDate,
          onsiteContactFirstName: body.onsiteContactFirstName,
          onsiteContactLastName: body.onsiteContactLastName,
          onsiteContactPhone: body.onsiteContactPhone,
          lockedGates: body.lockedGates,
          deliveryPreference: body.deliveryPreference,
          legalDescription: body.legalDescription,
          source: body.source,
          priority: body.priority,
          team: body.team,
          suppressClientEmails: body.suppressClientEmails,
          internalNotes: body.internalNotes,
          referralSource: body.referralSource,
          dropDeadDate: dates.dropDeadDate,
          internalClosingDate: dates.internalClosingDate,
          dueDate: dates.dueDate,
          isRush: dates.isRush,
          rushFeeAmount,
          createdBy: req.user?.userId,
        },
        include: {
          client: true,
        },
      });

      logger.info("Order created", { orderId: order.id, orderNumber, clientId });
      const io = req.app.get("io") as SocketServer | undefined;
      emitDashboardEvent(io, "dashboard:orders", "order:created", {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
      });

      const clientName = order.client
        ? `${order.client.firstName} ${order.client.lastName}`
        : `${body.clientFirstName ?? ""} ${body.clientLastName ?? ""}`.trim() || "Unknown";
      notifyAdminsOrderNew(order, clientName, io).catch(() => {});

      const clientEmail = order.client?.email ?? body.clientEmail;
      if (clientEmail && !order.suppressClientEmails) {
        sendOrderConfirmationEmail({
          orderNumber: order.orderNumber,
          clientEmail,
          clientFirstName: order.client?.firstName ?? body.clientFirstName ?? "",
          clientLastName: order.client?.lastName ?? body.clientLastName ?? "",
          surveyType: order.surveyType ?? "other",
          propertyAddressLine1: order.propertyAddressLine1 ?? "",
          propertyAddressLine2: order.propertyAddressLine2 ?? undefined,
          propertyCity: order.propertyCity ?? "",
          propertyState: order.propertyState ?? "",
          propertyZip: order.propertyZip ?? "",
          propertyCounty: order.propertyCounty ?? undefined,
          pin: order.pin ?? "",
          closingDate: order.closingDate,
          deliveryPreference: order.deliveryPreference,
          onsiteContactFirstName: order.onsiteContactFirstName,
          onsiteContactLastName: order.onsiteContactLastName,
          onsiteContactPhone: order.onsiteContactPhone,
        }).catch(() => {});
      }

      res.status(201).json({ data: order });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

router.put(
  "/:id",
  requireAuth,
  requireRole("office_manager", "pls_reviewer"),
  teamFilterMiddleware,
  validateBody(updateOrderSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof updateOrderSchema>;

      const existing = await prisma.order.findUnique({
        where: { id: req.params["id"]! },
        include: {
          client: { include: { companyContacts: { include: { company: true } } } },
        },
      });

      if (!existing || existing.deletedAt) {
        throw new NotFoundError(`Order ${req.params["id"]!} not found`);
      }

      let dateFields: Partial<DateCalcResult> & { rushFeeAmount?: number | null } = {};
      if (body.closingDate !== undefined) {
        const isOrtClient = existing.client?.companyContacts.some((cc) => cc.company.isOrt) ?? false;
        const closingDate = body.closingDate ? new Date(body.closingDate) : null;
        const requestedDate = body.requestedDate
          ? new Date(body.requestedDate)
          : existing.closingDate;
        const calc = await calculateDates({ closingDate, requestedDate, isOrtClient });
        dateFields = { ...calc };
        if (calc.isRush && !existing.rushFeeAmount) {
          dateFields.rushFeeAmount = await getRushFeeSetting();
        }
      }

      const updated = await prisma.order.update({
        where: { id: req.params["id"]! },
        data: {
          // Explicit mapping of validated update fields to Prisma model fields
          ...(body.clientId !== undefined ? { clientId: body.clientId } : {}),
          ...(body.billingClientId !== undefined ? { billingClientId: body.billingClientId } : {}),
          ...(body.orderType !== undefined ? { orderType: body.orderType } : {}),
          ...(body.propertyAddressLine1 !== undefined ? { propertyAddressLine1: body.propertyAddressLine1 } : {}),
          ...(body.propertyAddressLine2 !== undefined ? { propertyAddressLine2: body.propertyAddressLine2 } : {}),
          ...(body.propertyCity !== undefined ? { propertyCity: body.propertyCity } : {}),
          ...(body.propertyState !== undefined ? { propertyState: body.propertyState } : {}),
          ...(body.propertyZip !== undefined ? { propertyZip: body.propertyZip } : {}),
          ...(body.propertyCounty !== undefined ? { propertyCounty: body.propertyCounty as County } : {}),
          ...(body.pin !== undefined ? { pin: body.pin } : {}),
          ...(body.additionalPins !== undefined ? { additionalPins: body.additionalPins } : {}),
          ...(body.propertyType !== undefined ? { propertyType: body.propertyType } : {}),
          ...(body.surveyType !== undefined ? { surveyType: body.surveyType } : {}),
          ...(body.price !== undefined ? { price: body.price } : {}),
          ...(body.paymentTerms !== undefined ? { paymentTerms: body.paymentTerms } : {}),
          ...(body.onsiteContactFirstName !== undefined ? { onsiteContactFirstName: body.onsiteContactFirstName } : {}),
          ...(body.onsiteContactLastName !== undefined ? { onsiteContactLastName: body.onsiteContactLastName } : {}),
          ...(body.onsiteContactPhone !== undefined ? { onsiteContactPhone: body.onsiteContactPhone } : {}),
          ...(body.lockedGates !== undefined ? { lockedGates: body.lockedGates } : {}),
          ...(body.deliveryPreference !== undefined ? { deliveryPreference: body.deliveryPreference } : {}),
          ...(body.legalDescription !== undefined ? { legalDescription: body.legalDescription } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.team !== undefined ? { team: body.team } : {}),
          ...(body.suppressClientEmails !== undefined ? { suppressClientEmails: body.suppressClientEmails } : {}),
          ...(body.internalNotes !== undefined ? { internalNotes: body.internalNotes } : {}),
          ...(body.referralSource !== undefined ? { referralSource: body.referralSource } : {}),
          ...(body.closingDate !== undefined
            ? { closingDate: body.closingDate ? new Date(body.closingDate) : null }
            : {}),
          ...(body.requestedDate !== undefined
            ? { requestedDate: body.requestedDate ? new Date(body.requestedDate) : null }
            : {}),
          ...(body.pinLatitude !== undefined ? { pinLatitude: body.pinLatitude } : {}),
          ...(body.pinLongitude !== undefined ? { pinLongitude: body.pinLongitude } : {}),
          ...dateFields,
          updatedBy: req.user!.userId,
        },
      });

      if (body.customerType !== undefined && existing.clientId) {
        const ct = body.customerType as string;
        if (Object.values(CustomerType).includes(ct as CustomerType)) {
          await prisma.client.update({
            where: { id: existing.clientId },
            data: { customerType: ct as CustomerType },
          });
        }
      }

      const io = req.app.get("io") as SocketServer | undefined;
      emitDashboardEvent(io, "dashboard:orders", "order:updated", {
        orderId: updated.id,
        status: updated.status,
      });
      logger.info("Order updated", { orderId: updated.id, orderNumber: updated.orderNumber });
      sendSuccess(res, updated);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── PUT /:id/status ──────────────────────────────────────────────────────────

router.put(
  "/:id/status",
  requireAuth,
  requireRole("office_manager", "pls_reviewer"),
  teamFilterMiddleware,
  validateBody(statusSchema),
  async (req, res) => {
    try {
      const { status: newStatus } = req.body as z.infer<typeof statusSchema>;

      const order = await prisma.order.findUnique({
        where: { id: req.params["id"]! },
      });

      if (!order || order.deletedAt) {
        throw new NotFoundError(`Order ${req.params["id"]!} not found`);
      }

      if (!canTransition("order", order.status, newStatus as OrderStatus)) {
        throw new ValidationError(
          `Cannot transition order from '${order.status}' to '${newStatus}'`
        );
      }

      if (order.status === OrderStatus.pending_review && !order.paymentTerms) {
        throw new ValidationError(
          "Payment terms must be selected before advancing from Under Review"
        );
      }

      if (
        order.status === OrderStatus.pending_review &&
        newStatus === OrderStatus.research_queued
      ) {
        if (order.quoteId) {
          const quoteSignatureCount = await prisma.contractSignature.count({
            where: { quoteId: order.quoteId },
          });
          if (quoteSignatureCount === 0) {
            throw new ValidationError(
              "The quote proposal must be signed before advancing to research."
            );
          }
        } else {
          const signatureCount = await prisma.orderContractSignature.count({
            where: { orderId: order.id },
          });
          if (signatureCount === 0) {
            throw new ValidationError(
              "The order proposal must be signed before advancing to research. Please send the proposal to the client and wait for their signature."
            );
          }
        }
      }

      if (
        order.status === OrderStatus.research_in_progress &&
        newStatus === OrderStatus.research_complete
      ) {
        const completeness = await computeCompleteness(order.id);
        if (completeness.missing.length > 0) {
          throw new ValidationError(
            `Research cannot be completed until all 7 required document types are uploaded. Missing: ${completeness.missing.join(", ")}`
          );
        }
      }

      let result: object = order;

      if (newStatus === OrderStatus.ready_for_field) {
        result = await withTransaction(async (tx) => {
          const jobNumber = await getNextSequence("JOB");

          const job = await tx.job.create({
            data: {
              jobNumber,
              orderId: order.id,
              status: JobStatus.unassigned,
              team: order.team ?? "residential",
              createdBy: req.user!.userId,
              propertyAddressLine1: order.propertyAddressLine1,
              propertyAddressLine2: order.propertyAddressLine2,
              propertyCity: order.propertyCity,
              propertyState: order.propertyState,
              propertyZip: order.propertyZip,
              propertyCounty: order.propertyCounty,
              pin: order.pin,
              additionalPins: order.additionalPins ?? [],
              propertyLat: order.pinLatitude,
              propertyLng: order.pinLongitude,
              internalDueDate: order.dropDeadDate
                ? subDays(order.dropDeadDate, 3)
                : null,
            },
          });

          const updatedOrder = await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.ready_for_field, updatedBy: req.user!.userId },
          });

          logger.info("Order ready_for_field, job created", {
            orderId: order.id,
            jobId: job.id,
            jobNumber,
          });

          const io = req.app.get("io") as SocketServer | undefined;
          emitDashboardEvent(io, "dashboard:orders", "order:updated", {
            orderId: order.id,
            status: OrderStatus.ready_for_field,
          });

          const rfAudit = await tx.entityAuditLog.create({
            data: {
              entityType: "orders",
              entityId: order.id,
              entityNumber: order.orderNumber,
              action: "updated",
              userId: req.user!.userId,
              userName: req.user!.email,
              changedAt: new Date(),
              changeSummary: `Status changed to ready_for_field, Job ${jobNumber} created`,
              changes: { status: { old: order.status, new: "ready_for_field" } },
              source: AuditSource.web_portal,
            },
            include: { user: { select: { id: true, name: true } } },
          }).catch(() => null);

          if (rfAudit) {
            io?.to(ROOM_PREFIXES.ORDER(order.id)).emit("order:history:new", rfAudit);
          }

          return { ...updatedOrder, job };
        });
      } else {
        const updated = await prisma.order.update({
          where: { id: order.id },
          data: {
            status: newStatus as OrderStatus,
            updatedBy: req.user!.userId,
          },
          include: {
            client: { select: { firstName: true, lastName: true } },
          },
        });
        result = updated;

        const io = req.app.get("io") as SocketServer | undefined;
        emitDashboardEvent(io, "dashboard:orders", "order:updated", {
          orderId: order.id,
          status: newStatus,
        });

        if (newStatus === OrderStatus.research_queued.toString()) {
          const clientName = updated.client
            ? `${updated.client.firstName} ${updated.client.lastName}`
            : "Unknown";
          notifyResearchLeader(updated, clientName, io).catch(() => {});
        }

        if (newStatus === OrderStatus.research_complete.toString()) {
          const clientName = updated.client
            ? `${updated.client.firstName} ${updated.client.lastName}`
            : "Unknown";
          notifyAdminsResearchComplete(updated, clientName, io).catch(() => {});
        }

        const statusAudit = await prisma.entityAuditLog.create({
          data: {
            entityType: "orders",
            entityId: order.id,
            entityNumber: order.orderNumber,
            action: "updated",
            userId: req.user!.userId,
            userName: req.user!.email,
            changedAt: new Date(),
            changeSummary: `Status changed to ${newStatus}`,
            changes: { status: { old: order.status, new: newStatus } },
            source: AuditSource.web_portal,
          },
          include: { user: { select: { id: true, name: true } } },
        }).catch(() => null);

        if (statusAudit) {
          io?.to(ROOM_PREFIXES.ORDER(order.id)).emit("order:history:new", statusAudit);
        }
      }

      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── POST /:id/mark-signed ────────────────────────────────────────────────────

router.post(
  "/:id/mark-signed",
  requireAuth,
  requireRole("office_manager", "pls_reviewer"),
  teamFilterMiddleware,
  async (req, res) => {
    try {
      const orderId = req.params["id"]!;

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { client: { select: { firstName: true, lastName: true } } },
      });

      if (!order || order.deletedAt) {
        throw new NotFoundError(`Order ${orderId} not found`);
      }

      if (order.status !== OrderStatus.pending_contract) {
        throw new ConflictError(
          `Order must be in 'pending_contract' status to mark as signed (current: ${order.status})`,
        );
      }

      const nextStatus = order.paymentRequired === false
        ? OrderStatus.research_queued
        : OrderStatus.pending_payment;

      const { updated, auditEntry } = await withTransaction(async (tx) => {
        const fresh = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { status: true },
        });
        if (fresh.status !== OrderStatus.pending_contract) {
          throw new ConflictError("Order is no longer in 'pending_contract' status");
        }

        const upd = await tx.order.update({
          where: { id: orderId },
          data: { status: nextStatus, updatedBy: req.user!.userId },
        });

        await createChatSystemEvent({
          entityType: ChatEntityType.order,
          entityId: orderId,
          eventType: "order_marked_signed",
          content: `${req.user!.email} marked order as signed`,
          metadata: {
            paymentRequired: order.paymentRequired,
            nextStatus,
            paymentTerms: order.paymentTerms,
          },
          userId: req.user!.userId,
          io: req.app.get("io") as SocketServer | undefined,
        });

        const audit = await tx.entityAuditLog.create({
          data: {
            entityType: "orders",
            entityId: orderId,
            entityNumber: order.orderNumber,
            action: "updated",
            userId: req.user!.userId,
            userName: req.user!.email,
            changedAt: new Date(),
            changeSummary: `Order marked as signed — status changed to ${nextStatus}`,
            changes: { status: { old: "pending_contract", new: nextStatus } },
            source: AuditSource.web_portal,
          },
          include: { user: { select: { id: true, name: true } } },
        }).catch(() => null);

        return { updated: upd, auditEntry: audit };
      }, "Serializable");

      const io = req.app.get("io") as SocketServer | undefined;
      io?.to(ROOM_PREFIXES.ORDER(orderId)).emit("order:status_changed", {
        orderId,
        status: nextStatus,
        orderNumber: updated.orderNumber,
      });
      emitDashboardEvent(io, "dashboard:orders", "order:updated", {
        orderId,
        status: nextStatus,
      });
      if (auditEntry) {
        io?.to(ROOM_PREFIXES.ORDER(orderId)).emit("order:history:new", auditEntry);
      }

      if (nextStatus === OrderStatus.research_queued) {
        const clientName = order.client
          ? `${order.client.firstName} ${order.client.lastName}`
          : "Unknown";
        notifyResearchLeader(updated, clientName, io).catch(() => {});
      }

      logger.info("Order marked as signed", { orderId, nextStatus });

      sendSuccess(res, {
        id: updated.id,
        orderNumber: updated.orderNumber,
        status: updated.status,
        paymentRequired: order.paymentRequired,
        previousStatus: "pending_contract",
      });
    } catch (err) {
      sendError(res, err);
    }
  },
);

const RESEARCH_DOC_TYPE_LABELS: Record<string, string> = {
  plat_of_subdivision: "Plat of Subdivision (POS)",
  sidwell_map: "Sidwell Map (County Tax Map)",
  title_commitment: "Title Commitment",
  recorded_deed: "Recorded Deed / Vesting Deed",
  legal_description: "Legal Description",
  certificate_of_correction: "Certificate of Correction",
  order_form: "Order Form",
  other: "Other",
};

// ─── POST /:id/escalate-missing-docs ──────────────────────────────────────────

const escalateDocsSchema = z.object({
  missingDocTypes: z.array(z.string()).min(1),
  note: z.string().max(2000).optional(),
});

router.post(
  "/:id/escalate-missing-docs",
  requireAuth,
  requireRole("pls_reviewer", "super_admin", "admin", "office_manager"),
  teamFilterMiddleware,
  validateBody(escalateDocsSchema),
  async (req, res) => {
    try {
      const { missingDocTypes, note } = req.body as z.infer<typeof escalateDocsSchema>;
      const orderId = req.params["id"]!;

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          propertyAddressLine1: true,
          propertyCity: true,
          propertyState: true,
          propertyZip: true,
          deletedAt: true,
        },
      });

      if (!order || order.deletedAt) {
        throw new NotFoundError(`Order ${orderId} not found`);
      }

      const officeManagers = await prisma.user.findMany({
        where: { role: "office_manager", isActive: true },
        select: { email: true },
      });

      if (officeManagers.length === 0) {
        throw new ValidationError("No office managers configured to receive escalation emails");
      }

      const propertyAddress = [
        order.propertyAddressLine1,
        order.propertyCity,
        order.propertyState ? `${order.propertyState} ${order.propertyZip ?? ""}`.trim() : null,
      ].filter(Boolean).join(", ") || "Address pending";

      const missingDocLabels = missingDocTypes.map(
        (t) => RESEARCH_DOC_TYPE_LABELS[t] ?? t,
      );

      const portalUrl = `${envStore.FRONTEND_URL}/orders/${order.id}`;

      const html = researchEscalationEmailHtml({
        orderNumber: order.orderNumber,
        propertyAddress,
        missingDocLabels,
        note,
        escalatedByName: req.user!.email,
        portalUrl,
      });

      const recipients = officeManagers.map((om) => om.email);
      await Promise.all(
        recipients.map((email) =>
          sendEmail({
            to: email,
            subject: `Missing Documents — Order #${order.orderNumber}`,
            html,
          }),
        ),
      );

      logger.info("[Escalation] Missing docs email sent", {
        orderId,
        orderNumber: order.orderNumber,
        recipientCount: recipients.length,
        missingDocTypes,
      });

      sendSuccess(res, { emailsSent: recipients.length, recipients });
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── POST /:id/start-research ──────────────────────────────────────────────────

router.post(
  "/:id/start-research",
  requireAuth,
  requireRole("pls_reviewer", "super_admin", "admin", "office_manager"),
  teamFilterMiddleware,
  async (req, res) => {
    try {
      const orderId = req.params["id"]!;
      const order = await prisma.order.findUnique({ where: { id: orderId } });

      if (!order || order.deletedAt) {
        throw new NotFoundError(`Order ${orderId} not found`);
      }

      if (order.status !== OrderStatus.research_queued) {
        throw new ConflictError(
          `Order must be in 'research_queued' status to start research (current: ${order.status})`,
        );
      }

      const updated = await prisma.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.research_in_progress, updatedBy: req.user!.userId },
      });

      await createChatSystemEvent({
        entityType: ChatEntityType.order,
        entityId: orderId,
        eventType: "order_research_started",
        content: `${req.user!.email} started research`,
        userId: req.user!.userId,
        io: req.app.get("io") as SocketServer | undefined,
      });

      const audit = await prisma.entityAuditLog.create({
        data: {
          entityType: "orders",
          entityId: orderId,
          entityNumber: order.orderNumber,
          action: "updated",
          userId: req.user!.userId,
          userName: req.user!.email,
          changedAt: new Date(),
          changeSummary: "Research started",
          changes: { status: { old: "research_queued", new: "research_in_progress" } },
          source: AuditSource.web_portal,
        },
        include: { user: { select: { id: true, name: true } } },
      }).catch(() => null);

      const io = req.app.get("io") as SocketServer | undefined;
      io?.to(ROOM_PREFIXES.ORDER(orderId)).emit("order:status_changed", {
        orderId,
        status: OrderStatus.research_in_progress,
        orderNumber: updated.orderNumber,
      });
      emitDashboardEvent(io, "dashboard:orders", "order:updated", {
        orderId,
        status: OrderStatus.research_in_progress,
      });
      if (audit) {
        io?.to(ROOM_PREFIXES.ORDER(orderId)).emit("order:history:new", audit);
      }

      sendSuccess(res, {
        id: updated.id,
        status: updated.status,
        previousStatus: "research_queued",
      });
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── POST /calculate-dates ────────────────────────────────────────────────────

router.post(
  "/calculate-dates",
  requireAuth,
  validateBody(calculateDatesSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof calculateDatesSchema>;

      const closingDate = body.closingDate ? new Date(body.closingDate) : null;
      const requestedDate = body.requestedDate ? new Date(body.requestedDate) : null;

      const dates = await calculateDates({
        closingDate,
        requestedDate,
        isOrtClient: body.isOrtClient,
      });

      sendSuccess(res, dates);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── GET /:id/payment-status ──────────────────────────────────────────────────

router.get("/:id/payment-status", requireAuth, teamFilterMiddleware, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params["id"]! },
      select: { id: true, deletedAt: true },
    });

    if (!order || order.deletedAt) {
      throw new NotFoundError(`Order ${req.params["id"]!} not found`);
    }

    const invoices = await prisma.invoice.findMany({
      where: { orderId: req.params["id"]! },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        totalAmount: true,
        amountPaid: true,
        balanceDue: true,
        dueDate: true,
      },
      orderBy: { createdAt: "desc" },
    });

    sendSuccess(res, { orderId: order.id, invoices });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /:id/traceability ────────────────────────────────────────────────────

router.get("/:id/traceability", requireAuth, teamFilterMiddleware, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params["id"]! },
      include: {
        quote: {
          select: {
            id: true,
            quoteNumber: true,
            status: true,
            createdAt: true,
          },
        },
        jobs: {
          where: { deletedAt: null },
          select: {
            id: true,
            jobNumber: true,
            status: true,
            assignedCrewId: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!order || order.deletedAt) {
      throw new NotFoundError(`Order ${req.params["id"]!} not found`);
    }

    sendSuccess(res, {
      quote: order.quote ?? null,
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        createdAt: order.createdAt,
      },
      jobs: order.jobs,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── PATCH /:id/payment-terms ────────────────────────────────────────────────

const paymentTermsPatchSchema = z.object({
  paymentTerms: z.enum(["pre_pay", "fifty_fifty", "full_with_discount", "post_closing"]),
});

router.patch(
  "/:id/payment-terms",
  requireAuth,
  requireRole("office_manager", "pls_reviewer"),
  teamFilterMiddleware,
  validateBody(paymentTermsPatchSchema),
  async (req, res) => {
    try {
      const { paymentTerms } = req.body as z.infer<typeof paymentTermsPatchSchema>;

      const existing = await prisma.order.findUnique({
        where: { id: req.params["id"]! },
        select: { id: true, deletedAt: true },
      });

      if (!existing || existing.deletedAt) {
        throw new NotFoundError(`Order ${req.params["id"]!} not found`);
      }

      const updated = await prisma.order.update({
        where: { id: req.params["id"]! },
        data: { paymentTerms, updatedBy: req.user!.userId },
      });

      const io = req.app.get("io") as SocketServer | undefined;
      emitDashboardEvent(io, "dashboard:orders", "order:updated", {
        orderId: updated.id,
        status: updated.status,
      });

      logger.info("Order payment terms updated", { orderId: updated.id, paymentTerms });
      sendSuccess(res, { id: updated.id, paymentTerms: updated.paymentTerms });
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── PATCH /:id/research ─────────────────────────────────────────────────────

const orderResearchUpdateSchema = z.object({
  lotSizeAcres: z.number().positive().max(9999).nullable().optional(),
  lotShape: z.enum(["regular_rectangular", "irregular", "many_sided", "curved_boundary"]).nullable().optional(),
  drivewayType: z.enum(["standard_straight", "u_shaped_horseshoe", "long_curved", "none"]).nullable().optional(),
  waterFeatures: z.enum(["none", "pond_within_lot", "boundary_water"]).nullable().optional(),
  vegetationDensity: z.enum(["minimal", "moderate", "dense_obstructive"]).nullable().optional(),
  subdivisionStatus: z.enum(["recorded_plat", "metes_and_bounds"]).nullable().optional(),
  structuresOnProperty: z.array(z.string()).optional(),
  structuresOther: z.string().max(500).nullable().optional(),
  accessIssues: z.string().max(1000).nullable().optional(),
});

router.patch(
  "/:id/research",
  requireAuth,
  requireRole("office_manager", "pls_reviewer"),
  teamFilterMiddleware,
  validateBody(orderResearchUpdateSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof orderResearchUpdateSchema>;
      const user = req.user!;
      const io = req.app.get("io") as SocketServer | undefined;
      const result = await orderResearch.updateResearch(
        req.params["id"]!,
        body,
        user.userId,
        user.email,
        io,
      );
      logger.info("Order research updated", { orderId: req.params["id"]! });
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── PATCH /:id/generate-price ───────────────────────────────────────────────

const orderGeneratePriceSchema = z.object({
  basePrice: z.number().nonnegative(),
  lineItems: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      amount: z.number(),
    }),
  ),
  rushFee: z.number().nonnegative(),
});

router.patch(
  "/:id/generate-price",
  requireAuth,
  requireRole("office_manager", "pls_reviewer"),
  teamFilterMiddleware,
  validateBody(orderGeneratePriceSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof orderGeneratePriceSchema>;
      const user = req.user!;
      const io = req.app.get("io") as SocketServer | undefined;
      const result = await orderPricing.generatePrice(
        req.params["id"]!,
        user.userId,
        user.email,
        body,
        io,
      );
      logger.info("Order price generated", { orderId: req.params["id"]!, basePrice: body.basePrice, rushFee: body.rushFee });
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── PATCH /:id/rush-fee ─────────────────────────────────────────────────────

const orderRushFeeSchema = z.object({
  isRush: z.boolean(),
  rushFeeAmount: z.number().positive().nullable().optional(),
  rushFeeWaived: z.boolean(),
  rushFeeWaivedReason: z.string().max(500).nullable().optional(),
});

router.patch(
  "/:id/rush-fee",
  requireAuth,
  requireRole("office_manager", "pls_reviewer"),
  teamFilterMiddleware,
  validateBody(orderRushFeeSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof orderRushFeeSchema>;
      const user = req.user!;
      const io = req.app.get("io") as SocketServer | undefined;
      const result = await orderRushFee.updateRushFee(
        req.params["id"]!,
        body,
        user.userId,
        user.email,
        io,
      );
      logger.info("Order rush fee updated", { orderId: req.params["id"]!, isRush: body.isRush, rushFeeWaived: body.rushFeeWaived });
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── Send / Resend Order to Client ───────────────────────────────────────────

const sendOrderToClientSchema = z.object({
  paymentRequired: z.boolean().optional(),
  paymentTerms: z
    .enum(["pre_pay", "fifty_fifty", "full_with_discount", "post_closing"])
    .optional(),
  depositPercentage: z
    .number()
    .refine((v) => v === 50 || v === 100, { message: "Must be 50 or 100" })
    .optional(),
});

router.post(
  "/:id/send-to-client",
  requireAuth,
  requireRole("office_manager", "pls_reviewer"),
  validateBody(sendOrderToClientSchema),
  async (req, res) => {
    try {
      const overrides = req.body as z.infer<typeof sendOrderToClientSchema>;
      const result = await sendOrderToClient({
        orderId: req.params.id!,
        userId: req.user!.userId,
        userName: req.user!.email,
        overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        io: req.app.get("io") as SocketServer | undefined,
      });
      logger.info("Order sent to client", { orderId: req.params.id! });
      sendSuccess(res, result, 201);
    } catch (err) {
      sendError(res, err);
    }
  },
);

router.post(
  "/:id/resend-to-client",
  requireAuth,
  requireRole("office_manager", "pls_reviewer"),
  validateBody(sendOrderToClientSchema),
  async (req, res) => {
    try {
      const overrides = req.body as z.infer<typeof sendOrderToClientSchema>;
      const result = await resendOrderToClient({
        orderId: req.params.id!,
        userId: req.user!.userId,
        userName: req.user!.email,
        overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        io: req.app.get("io") as SocketServer | undefined,
      });
      logger.info("Order resent to client", { orderId: req.params.id! });
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── GET /:id/payments ────────────────────────────────────────────────────────

router.get("/:id/payments", requireAuth, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id! },
      select: {
        id: true,
        orderNumber: true,
        price: true,
        amountPaid: true,
        balanceRemaining: true,
        payments: {
          orderBy: { paymentDate: "desc" },
          select: {
            id: true,
            paymentNumber: true,
            paymentDate: true,
            amount: true,
            paymentMethod: true,
            cardBrand: true,
            cardLastFour: true,
            status: true,
            paymentType: true,
            paymentSource: true,
            invoice: { select: { invoiceNumber: true } },
            recordedByUser: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!order) throw new NotFoundError("Order not found");

    const { canCollectPayment } = await import("../services/payment-gate.service");
    const eligibility = await canCollectPayment(order.id);

    const price = Number(order.price ?? 0);
    const balanceRemaining = Number(order.balanceRemaining);

    sendSuccess(res, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      price,
      amountPaid: Number(order.amountPaid),
      balanceRemaining,
      fullyPaid: balanceRemaining <= 0 && price > 0,
      canCollectPayment: eligibility.eligible,
      payments: order.payments.map((p) => ({
        ...p,
        invoiceNumber: p.invoice?.invoiceNumber ?? null,
        recordedBy: p.recordedByUser,
      })),
    });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
