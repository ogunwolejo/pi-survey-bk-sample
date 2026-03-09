import { Router } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { addDays } from "date-fns";
import type { Server as SocketServer } from "socket.io";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { teamFilterMiddleware, getTeamFilter } from "../middleware/team-filter.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import { publicRateLimit } from "../middleware/rate-limit.middleware";
import { sendSuccess, sendPaginated, sendError } from "../lib/response";
import { getNextSequence } from "../lib/sequential-number";
import { canTransition } from "../lib/status-engine";
import { withTransaction } from "../lib/transaction";
import { NotFoundError, ValidationError } from "../lib/errors";
import { quoteLogger as logger } from "../lib/logger";
import { humanValue, humanizeChangeSummary } from "../lib/field-labels";
import { QuoteStatus, OrderStatus, OrderSource, type Prisma } from "@prisma/client";
import * as quoteService from "../services/quote.service";
import * as quoteResearch from "../services/quote-research.service";
import * as quoteRushFee from "../services/quote-rush-fee.service";
import * as quoteAlta from "../services/quote-alta.service";
import * as quotePricing from "../services/quote-pricing.service";
import { CustomerIoEventsNames, identifyAndTrackEvent } from "../services/customerio.service";
import { detectPaymentRequirement } from "../services/payment-detection.service";
import { emitDashboardEvent } from "../lib/socket-emitter";
import { notifyResearchLeader, notifyAdminsQuoteNew } from "../services/notification.service";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { ChatEntityType } from "@prisma/client";
import { createSystemEvent as createChatSystemEvent } from "../services/chat.service";
import { envStore } from "../env-store";

const router = Router();

// ─── Shared constants & schema fragments ─────────────────────────────────────

const COUNTY_VALUES = ["cook", "dupage", "will", "kane", "lake", "mchenry", "kendall", "dekalb", "kankakee", "iroquois", "lasalle", "grundy"] as const;

const QUOTE_CUSTOMER_TYPE_VALUES = ["attorney_law_office", "individual_homeowner", "realtor", "title_company", "engineering_construction", "architecture_firm", "government_municipality", "other"] as const;

const billingAddressFields = {
  billingAddressSameAsService: z.boolean().default(true),
  billingAddressLine1: z.string().optional(),
  billingAddressLine2: z.string().optional(),
  billingCity: z.string().optional(),
  billingState: z.string().optional(),
  billingZip: z.string().optional(),
};

function billingAddressRefinement(data: Record<string, unknown>, ctx: z.RefinementCtx): void {
  if (data.billingAddressSameAsService === false) {
    if (!data.billingAddressLine1 || (data.billingAddressLine1 as string).length < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Billing address line 1 is required", path: ["billingAddressLine1"] });
    }
    if (!data.billingCity || (data.billingCity as string).length < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Billing city is required", path: ["billingCity"] });
    }
    if (!data.billingState || (data.billingState as string).length !== 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Billing state must be 2 characters", path: ["billingState"] });
    }
    if (!data.billingZip || (data.billingZip as string).length < 5) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Billing ZIP must be at least 5 characters", path: ["billingZip"] });
    }
  }
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.string().optional(),
  date_from: z.string().datetime({ offset: true }).optional(),
  date_to: z.string().datetime({ offset: true }).optional(),
  survey_type: z.string().optional(),
  source: z.string().optional(),
  team: z.enum(["residential", "public"]).optional(),
  county: z.string().optional(),
  customer_type: z.string().optional(),
  property_type: z.string().optional(),
});

const createQuoteBase = z.object({
  clientId: z.string().uuid(),
  billingClientId: z.string().uuid().optional(),
  propertyAddressLine1: z.string().min(1),
  propertyAddressLine2: z.string().optional(),
  propertyCity: z.string().min(1),
  propertyState: z.string().length(2),
  propertyZip: z.string().min(5),
  propertyCounty: z.enum(COUNTY_VALUES),
  pin: z.string().min(1),
  additionalPins: z.array(z.string()).default([]),
  surveyType: z.enum(["boundary", "alta", "condominium", "topography", "other"]),
  price: z.number().positive(),
  basePriceAtCreation: z.number().positive(),
  priceOverrideReason: z.string().optional(),
  estimatedTimeframe: z.string().optional(),
  paymentTerms: z.enum(["pre_pay", "fifty_fifty", "full_with_discount", "post_closing"]).optional(),
  expiryDate: z.string().datetime({ offset: true }),
  source: z.enum(["website", "internal"]),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  assignedTo: z.string().uuid().optional(),
  internalNotes: z.string().optional(),
  referralSource: z.string().optional(),
  team: z.enum(["residential", "public"]).default("residential"),
  customerType: z.enum(QUOTE_CUSTOMER_TYPE_VALUES).optional(),
  ...billingAddressFields,
});

const createQuoteSchema = createQuoteBase.superRefine(billingAddressRefinement);

const updateQuoteSchema = createQuoteBase
  .partial()
  .omit({ source: true })
  .extend({
    propertyType: z
      .enum(["sfr", "sfr_townhome", "apartment", "commercial", "vacant_land", "farm", "other"])
      .nullable()
      .optional(),
    closingDate: z.string().nullable().optional(),
    onsiteContactFirstName: z.string().nullable().optional(),
    onsiteContactLastName: z.string().nullable().optional(),
    onsiteContactPhone: z.string().nullable().optional(),
    lockedGates: z.enum(["yes", "no", "na"]).nullable().optional(),
    deliveryPreference: z.enum(["pdf_only", "pdf_usps", "pdf_fedex"]).nullable().optional(),
    legalDescription: z.string().nullable().optional(),
    internalNotes: z.string().nullable().optional(),
    referralSource: z.string().nullable().optional(),
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

const researchUpdateSchema = z.object({
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

const rushFeeUpdateSchema = z.object({
  rushFeeApplied: z.boolean(),
  rushFeeAmount: z.number().positive().nullable().optional(),
  rushFeeWaived: z.boolean(),
  rushFeeWaivedReason: z.string().max(500).nullable().optional(),
});

const altaTableASchema = z.object({
  altaTableASelections: z.object({
    items: z.record(z.boolean()),
    item19InsuranceAmount: z.number().positive().optional(),
    customItems: z
      .array(
        z.object({
          id: z.string(),
          description: z.string(),
          selected: z.boolean(),
        }),
      )
      .optional(),
    notes: z.string().max(2000).optional(),
  }),
});

const preferenceFormSchema = z.object({
  action: z.enum(["sent", "received"]),
});

const sendToClientSchema = z.object({
  paymentRequired: z.boolean().optional(),
  paymentTerms: z.enum(["pre_pay", "fifty_fifty", "full_with_discount", "post_closing"]).optional(),
  depositPercentage: z.number().refine((v) => v === 50 || v === 100, { message: "Must be 50 or 100" }).optional(),
});

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

      const where: Record<string, unknown> = {
        deletedAt: null,
        ...(teamFilter.team ? { team: teamFilter.team } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.survey_type ? { surveyType: q.survey_type } : {}),
        ...(q.source ? { source: q.source } : {}),
        ...(q.county ? { propertyCounty: { in: q.county.split(",") } } : {}),
        ...(q.customer_type ? { customerType: { in: q.customer_type.split(",") } } : {}),
        ...(q.property_type ? { propertyType: { in: q.property_type.split(",") } } : {}),
        ...(q.date_from || q.date_to
          ? {
              createdAt: {
                ...(q.date_from ? { gte: new Date(q.date_from) } : {}),
                ...(q.date_to ? { lte: new Date(q.date_to) } : {}),
              },
            }
          : {}),
      };

      const [data, total] = await Promise.all([
        prisma.quote.findMany({
          where,
          skip: (q.page - 1) * q.limit,
          take: q.limit,
          orderBy: { createdAt: "desc" },
          include: {
            client: { select: { id: true, firstName: true, lastName: true, email: true } },
            order: { select: { id: true, orderNumber: true, status: true } },
          },
        }),
        prisma.quote.count({ where }),
      ]);

      sendPaginated(res, data, q.page, q.limit, total);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── GET /:id ─────────────────────────────────────────────────────────────────

router.get("/:id", requireAuth, teamFilterMiddleware, async (req, res) => {
  try {
    const quote = await prisma.quote.findUnique({
      where: { id: req.params["id"]! },
      include: {
        client: true,
        billingClient: true,
        order: {
          include: {
            jobs: { select: { id: true, jobNumber: true, status: true } },
          },
        },
        payments: true,
        quoteTokens: { orderBy: { createdAt: "desc" }, take: 1 },
        contractSignatures: true,
      },
    });

    if (!quote || quote.deletedAt) {
      throw new NotFoundError(`Quote ${req.params["id"]!} not found`);
    }

    sendSuccess(res, quote);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST / ───────────────────────────────────────────────────────────────────

router.post(
  "/",
  requireAuth,
  requireRole("office_manager"),
  teamFilterMiddleware,
  validateBody(createQuoteSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof createQuoteSchema>;
      const quoteNumber = await getNextSequence("QUOTE");

      const quote = await prisma.quote.create({
        data: {
          ...body,
          quoteNumber,
          price: body.price,
          basePriceAtCreation: body.basePriceAtCreation,
          expiryDate: new Date(body.expiryDate),
          createdBy: req.user!.userId,
        },
      });

      const io = req.app.get("io") as SocketServer | undefined;
      emitDashboardEvent(io, "dashboard:quotes", "quote:created", {
        quoteId: quote.id,
        quoteNumber: quote.quoteNumber,
        status: quote.status,
      });

      res.status(201).json({ data: quote });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

router.put(
  "/:id",
  requireAuth,
  requireRole("office_manager"),
  teamFilterMiddleware,
  validateBody(updateQuoteSchema),
  async (req, res) => {
    try {
      const { closingDate, expiryDate, ...rest } = req.body as z.infer<typeof updateQuoteSchema>;

      const existing = await prisma.quote.findUnique({
        where: { id: req.params["id"]! },
        include: { order: { select: { id: true } } },
      });
      if (!existing || existing.deletedAt) {
        throw new NotFoundError(`Quote ${req.params["id"]!} not found`);
      }
      if (existing.order) {
        res.status(409).json({ error: "Quote cannot be edited after an order has been created from it" });
        return;
      }

      const updated = await prisma.quote.update({
        where: { id: req.params["id"]! },
        data: {
          ...rest,
          ...(expiryDate ? { expiryDate: new Date(expiryDate) } : {}),
          ...(closingDate !== undefined
            ? { closingDate: closingDate ? new Date(closingDate) : null }
            : {}),
          updatedBy: req.user!.userId,
        },
      });

      const io = req.app.get("io") as SocketServer | undefined;
      emitDashboardEvent(io, "dashboard:quotes", "quote:updated", {
        quoteId: updated.id,
        status: updated.status,
      });

      const changes: Record<string, { old: unknown; new: unknown }> = {};
      const existingRecord = existing as Record<string, unknown>;
      const updatedRecord = updated as unknown as Record<string, unknown>;
      for (const key of Object.keys(rest)) {
        if (key === "updatedAt" || key === "updatedBy") continue;
        if (JSON.stringify(existingRecord[key]) !== JSON.stringify(updatedRecord[key])) {
          changes[key] = { old: existingRecord[key], new: updatedRecord[key] };
        }
      }

      if (Object.keys(changes).length > 0) {
        const changeSummary = humanizeChangeSummary(changes, "Updated");

        const auditEntry = await prisma.entityAuditLog.create({
          data: {
            entityType: "quote",
            entityId: updated.id,
            entityNumber: existing.quoteNumber,
            action: "updated",
            userId: req.user!.userId,
            userName: req.user!.email,
            changedAt: new Date(),
            changes: JSON.parse(JSON.stringify(changes)) as Prisma.InputJsonValue,
            changeSummary,
            source: "web_portal",
          },
          include: { user: { select: { id: true, name: true } } },
        }).catch(() => null);

        if (auditEntry) {
          io?.to(ROOM_PREFIXES.QUOTE(updated.id)).emit("quote:history:new", auditEntry);
        }

        await createChatSystemEvent({
          entityType: ChatEntityType.quote,
          entityId: updated.id,
          eventType: "field_update",
          content: changeSummary,
          metadata: { fields: Object.keys(changes) },
          userId: req.user!.userId,
          io,
        }).catch(() => null);
      }

      logger.info("Quote updated", { quoteId: updated.id, quoteNumber: updated.quoteNumber });
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
  requireRole("office_manager"),
  teamFilterMiddleware,
  validateBody(statusSchema),
  async (req, res) => {
    try {
      const { status: newStatus } = req.body as z.infer<typeof statusSchema>;

      const quote = await prisma.quote.findUnique({
        where: { id: req.params["id"]! },
        include: { client: true },
      });

      if (!quote || quote.deletedAt) {
        throw new NotFoundError(`Quote ${req.params["id"]!} not found`);
      }

      if (!canTransition("quote", quote.status, newStatus as QuoteStatus)) {
        throw new ValidationError(
          `Cannot transition quote from '${quote.status}' to '${newStatus}'`
        );
      }

      // Gate: quote must have a price > 0 before transitioning to "quoted"
      if (newStatus === QuoteStatus.quoted && Number(quote.price) <= 0) {
        return sendError(res, {
          code: "PRICE_REQUIRED",
          message: "A price must be set before transitioning to 'quoted' status",
          statusCode: 422,
        });
      }

      let result: object = quote;

      if (newStatus === QuoteStatus.sent) {
        result = await withTransaction(async (tx) => {
          const quoteToken = await tx.quoteToken.create({
            data: {
              token: uuidv4(),
              quoteId: quote.id,
              expiresAt: addDays(new Date(), 30),
            },
          });

          const updated = await tx.quote.update({
            where: { id: quote.id },
            data: { status: QuoteStatus.sent, updatedBy: req.user!.userId },
          });

          logger.info("Quote marked sent, token generated", {
            quoteId: quote.id,
            tokenId: quoteToken.id,
          });

          return { ...updated, quoteToken };
        });
      } else if (newStatus === QuoteStatus.accepted) {
        result = await withTransaction(async (tx) => {
          const orderNumber = await getNextSequence("ORDER");

          // Date placeholders – actual calculation happens in order creation flow
          const today = new Date();
          const dropDeadDate = today;
          const internalClosingDate = today;
          const dueDate = today;

          const order = await tx.order.create({
            data: {
              orderNumber,
              quoteId: quote.id,
              clientId: quote.clientId,
              billingClientId: quote.billingClientId,
              status: OrderStatus.new,
              orderType: "standard",
              propertyAddressLine1: quote.propertyAddressLine1,
              propertyAddressLine2: quote.propertyAddressLine2,
              propertyCity: quote.propertyCity,
              propertyState: quote.propertyState,
              propertyZip: quote.propertyZip,
              propertyCounty: quote.propertyCounty,
              pin: quote.pin,
              additionalPins: quote.additionalPins,
              surveyType: quote.surveyType!,
              price: quote.price,
              paymentTerms: quote.paymentTerms ?? "pre_pay",
              source: "quote_acceptance",
              team: quote.team,
              dropDeadDate,
              internalClosingDate,
              dueDate,
              isRush: false,
              createdBy: req.user!.userId,
            },
          });

          const updatedQuote = await tx.quote.update({
            where: { id: quote.id },
            data: { status: QuoteStatus.accepted, updatedBy: req.user!.userId },
          });

          logger.info("Quote accepted, order created", {
            quoteId: quote.id,
            orderId: order.id,
            orderNumber,
          });

          return { ...updatedQuote, order };
        });
      } else {
        result = await prisma.quote.update({
          where: { id: quote.id },
          data: {
            status: newStatus as QuoteStatus,
            updatedBy: req.user!.userId,
          },
        });
      }

      const typedForActivity = result as { id: string; status: string };
      const io = req.app.get("io") as SocketServer | undefined;

      await createChatSystemEvent({
        entityType: ChatEntityType.quote,
        entityId: typedForActivity.id,
        eventType: "status_change",
        content: `Status changed from ${humanValue("status", quote.status)} to ${humanValue("status", newStatus)}`,
        metadata: { fromStatus: quote.status, toStatus: newStatus },
        userId: req.user!.userId,
        io,
      }).catch(() => null);

      const statusAudit = await prisma.entityAuditLog.create({
        data: {
          entityType: "quote",
          entityId: typedForActivity.id,
          entityNumber: quote.quoteNumber,
          action: "updated",
          userId: req.user!.userId,
          userName: req.user!.email,
          changedAt: new Date(),
          changes: { status: { old: quote.status, new: newStatus } } as Prisma.InputJsonValue,
          changeSummary: `Status changed from ${humanValue("status", quote.status)} to ${humanValue("status", newStatus)}`,
          source: "web_portal",
        },
        include: { user: { select: { id: true, name: true } } },
      }).catch(() => null);

      if (statusAudit) {
        io?.to(ROOM_PREFIXES.QUOTE(typedForActivity.id)).emit("quote:history:new", statusAudit);
      }

      emitDashboardEvent(io, "dashboard:quotes", "quote:updated", {
        quoteId: typedForActivity.id,
        status: typedForActivity.status,
      });

      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── PATCH /:id/research ─────────────────────────────────────────────────────

router.patch(
  "/:id/research",
  requireAuth,
  requireRole("office_manager"),
  teamFilterMiddleware,
  validateBody(researchUpdateSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof researchUpdateSchema>;
      const user = req.user!;
      const io = req.app.get("io") as SocketServer | undefined;
      const result = await quoteResearch.updateResearch(
        req.params["id"]!,
        body,
        user.userId,
        user.email,
        io,
      );
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── PATCH /:id/rush-fee ─────────────────────────────────────────────────────

router.patch(
  "/:id/rush-fee",
  requireAuth,
  requireRole("office_manager"),
  teamFilterMiddleware,
  validateBody(rushFeeUpdateSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof rushFeeUpdateSchema>;
      const user = req.user!;
      const io = req.app.get("io") as SocketServer | undefined;
      const result = await quoteRushFee.updateRushFee(
        req.params["id"]!,
        body,
        user.userId,
        user.email,
        io,
      );
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── GET /:id/price-preview ─────────────────────────────────────────────────

router.get(
  "/:id/price-preview",
  requireAuth,
  teamFilterMiddleware,
  async (req, res) => {
    try {
      const breakdown = await quotePricing.previewPrice(req.params["id"]!);
      sendSuccess(res, breakdown);
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── PATCH /:id/generate-price ──────────────────────────────────────────────

const generatePriceSchema = z.object({
  basePrice: z.number().min(0),
  lineItems: z.array(z.object({
    key: z.string(),
    label: z.string(),
    amount: z.number().min(0),
  })),
  rushFee: z.number().min(0),
});

router.patch(
  "/:id/generate-price",
  requireAuth,
  requireRole("office_manager"),
  teamFilterMiddleware,
  validateBody(generatePriceSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof generatePriceSchema>;
      const user = req.user!;
      const io = req.app.get("io") as SocketServer | undefined;
      const result = await quotePricing.generatePrice(
        req.params["id"]!,
        user.userId,
        user.email,
        body,
        io,
      );
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── PATCH /:id/alta-table-a ─────────────────────────────────────────────────

router.patch(
  "/:id/alta-table-a",
  requireAuth,
  requireRole("office_manager"),
  teamFilterMiddleware,
  validateBody(altaTableASchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof altaTableASchema>;
      const user = req.user!;
      const io = req.app.get("io") as SocketServer | undefined;
      const result = await quoteAlta.updateAltaTableA(
        req.params["id"]!,
        body,
        user.userId,
        user.email,
        io,
      );
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── PATCH /:id/preference-form ──────────────────────────────────────────────

router.patch(
  "/:id/preference-form",
  requireAuth,
  requireRole("office_manager"),
  teamFilterMiddleware,
  validateBody(preferenceFormSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof preferenceFormSchema>;
      const user = req.user!;
      const io = req.app.get("io") as SocketServer | undefined;
      const result = await quoteAlta.updatePreferenceForm(
        req.params["id"]!,
        body,
        user.userId,
        user.email,
        io,
      );
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── GET /:id/linked-entities ─────────────────────────────────────────────────

router.get("/:id/linked-entities", requireAuth, teamFilterMiddleware, async (req, res) => {
  try {
    const quote = await prisma.quote.findUnique({
      where: { id: req.params["id"]! },
      include: {
        order: {
          include: {
            jobs: {
              where: { deletedAt: null },
              select: { id: true, jobNumber: true, status: true, team: true },
            },
          },
        },
      },
    });

    if (!quote || quote.deletedAt) {
      throw new NotFoundError(`Quote ${req.params["id"]!} not found`);
    }

    sendSuccess(res, {
      order: quote.order ?? null,
      job: quote.order?.jobs[0] ?? null,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /:id/history ─────────────────────────────────────────────────────────

const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

router.get(
  "/:id/history",
  requireAuth,
  validateQuery(historyQuerySchema),
  async (req, res) => {
    try {
      const { page, limit } = req.query as unknown as z.infer<typeof historyQuerySchema>;
      const quoteId = req.params["id"]!;

      const quote = await prisma.quote.findUnique({
        where: { id: quoteId },
        select: { id: true },
      });
      if (!quote) throw new NotFoundError(`Quote ${quoteId} not found`);

      const [entries, total] = await Promise.all([
        prisma.entityAuditLog.findMany({
          where: { entityType: "quote", entityId: quoteId },
          orderBy: { changedAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            user: { select: { id: true, name: true } },
          },
        }),
        prisma.entityAuditLog.count({
          where: { entityType: "quote", entityId: quoteId },
        }),
      ]);

      sendPaginated(res, entries, page, limit, total);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── POST /:id/cross-team-request ─────────────────────────────────────────────

const crossTeamRequestSchema = z.object({
  teams: z.array(z.string()).min(1),
  notes: z.string().optional(),
});

router.post(
  "/:id/cross-team-request",
  requireAuth,
  validateBody(crossTeamRequestSchema),
  async (req, res) => {
    try {
      const quoteId = req.params["id"]!;
      const { teams, notes } = req.body as z.infer<typeof crossTeamRequestSchema>;

      const quote = await prisma.quote.findUnique({
        where: { id: quoteId },
        select: { id: true, quoteNumber: true },
      });

      if (!quote) throw new NotFoundError(`Quote ${quoteId} not found`);

      await createChatSystemEvent({
        entityType: ChatEntityType.quote,
        entityId: quoteId,
        eventType: "cross_team_request",
        content: `Cross-team quote requested from: ${teams.join(", ")}${notes ? `. Notes: ${notes}` : ""}`,
        metadata: { teams, notes },
        userId: req.user?.userId ?? undefined,
        io: req.app.get("io") as SocketServer | undefined,
      });

      const crossTeamAudit = await prisma.entityAuditLog.create({
        data: {
          entityType: "quote",
          entityId: quoteId,
          action: "updated",
          userId: req.user?.userId ?? null,
          userName: req.user?.email ?? "System",
          changedAt: new Date(),
          changeSummary: `Cross-team quote requested from ${teams.join(", ")}`,
          changes: { teams: { old: null, new: teams } },
          source: "web_portal",
        },
        include: { user: { select: { id: true, name: true } } },
      });

      const io = req.app.get("io") as SocketServer | undefined;
      io?.to(ROOM_PREFIXES.QUOTE(quoteId)).emit("quote:history:new", crossTeamAudit);
      io?.to(ROOM_PREFIXES.QUOTE(quoteId)).emit("quote:activity:new", {
        quoteId,
        eventType: "cross_team_request",
        content: `Cross-team quote requested from: ${teams.join(", ")}`,
        userId: req.user?.userId ?? null,
        user: req.user ? { id: req.user.userId, name: req.user.email } : null,
        createdAt: new Date().toISOString(),
        metadata: { teams, notes },
      });

      sendSuccess(res, { success: true }, 201);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── POST /:id/send-to-client ────────────────────────────────────────────────

router.post(
  "/:id/send-to-client",
  requireAuth,
  requireRole("office_manager"),
  teamFilterMiddleware,
  validateBody(sendToClientSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof sendToClientSchema>;
      const result = await quoteService.sendQuoteToClient({
        quoteId: req.params["id"]!,
        userId: req.user!.userId,
        overrides: body,
      });

      const io = req.app.get("io") as SocketServer | undefined;
      const typed = result as { quote: { id: string; quoteNumber?: string; status: string }; quoteToken?: { token: string } };
      emitDashboardEvent(io, "dashboard:quotes", "quote:updated", {
        quoteId: typed.quote.id,
        status: typed.quote.status,
      });

      const sendAudit = await prisma.entityAuditLog.create({
        data: {
          entityType: "quote",
          entityId: typed.quote.id,
          entityNumber: typed.quote.quoteNumber ?? undefined,
          action: "updated",
          userId: req.user!.userId,
          userName: req.user!.email,
          changedAt: new Date(),
          changes: {
            paymentRequired: body.paymentRequired,
            paymentTerms: body.paymentTerms,
            depositPercentage: body.depositPercentage,
          } as Prisma.InputJsonValue,
          changeSummary: "Quote sent to client with proposal link",
          source: "web_portal",
        },
        include: { user: { select: { id: true, name: true } } },
      }).catch(() => null);

      if (sendAudit) {
        io?.to(ROOM_PREFIXES.QUOTE(typed.quote.id)).emit("quote:history:new", sendAudit);
      }

      sendSuccess(res, result, 201);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── POST /:id/resend-to-client ──────────────────────────────────────────────

router.post(
  "/:id/resend-to-client",
  requireAuth,
  requireRole("office_manager"),
  teamFilterMiddleware,
  validateBody(sendToClientSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof sendToClientSchema>;
      const result = await quoteService.resendQuoteToClient({
        quoteId: req.params["id"]!,
        userId: req.user!.userId,
        overrides: body,
      });

      const io = req.app.get("io") as SocketServer | undefined;
      const typed = result as { quote: { id: string; status: string } };
      emitDashboardEvent(io, "dashboard:quotes", "quote:updated", {
        quoteId: typed.quote.id,
        status: typed.quote.status,
      });

      const resendAudit = await prisma.entityAuditLog.create({
        data: {
          entityType: "quote",
          entityId: typed.quote.id,
          action: "updated",
          userId: req.user!.userId,
          userName: req.user!.email,
          changedAt: new Date(),
          changes: {
            paymentRequired: body.paymentRequired,
            paymentTerms: body.paymentTerms,
            depositPercentage: body.depositPercentage,
          } as Prisma.InputJsonValue,
          changeSummary: "Quote resent to client with new proposal link",
          source: "web_portal",
        },
        include: { user: { select: { id: true, name: true } } },
      }).catch(() => null);

      if (resendAudit) {
        io?.to(ROOM_PREFIXES.QUOTE(typed.quote.id)).emit("quote:history:new", resendAudit);
      }

      sendSuccess(res, result, 201);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── GET /:id/payment-detection ──────────────────────────────────────────────

router.get(
  "/:id/payment-detection",
  requireAuth,
  async (req, res) => {
    try {
      const quote = await prisma.quote.findUnique({
        where: { id: req.params["id"]! },
        include: { client: { select: { customerType: true, paymentTerms: true } } },
      });

      if (!quote || quote.deletedAt) {
        throw new NotFoundError(`Quote ${req.params["id"]!} not found`);
      }

      // Allow the dialog to override the customer type when the user manually selects one
      const customerTypeOverride =
        typeof req.query["customerTypeOverride"] === "string"
          ? req.query["customerTypeOverride"]
          : null;

      const detection = detectPaymentRequirement({
        customerType: quote.client.customerType,
        paymentTerms: quote.client.paymentTerms,
        quotePrice: Number(quote.price),
        quoteCustomerType: customerTypeOverride ?? quote.customerType ?? null,
        surveyType: quote.surveyType ?? null,
      });

      sendSuccess(res, { ...detection, totalPrice: Number(quote.price) });
    } catch (err) {
      sendError(res, err);
    }
  }
);

export default router;

// =============================================================================
// Public quote routes
// Mount publicQuoteRequestRouter at /api/quote-requests in app.ts
// Mount quoteTokenRouter at /api/quote in app.ts
//
// app.use("/api/quote-requests", publicQuoteRequestRouter);
// app.use("/api/quote", quoteTokenRouter);
// =============================================================================

// ─── Schemas (public) ─────────────────────────────────────────────────────────

const quoteRequestSchema = z.object({
  // Contact info
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(7),
  company: z.string().optional(),
  customerType: z.enum(QUOTE_CUSTOMER_TYPE_VALUES),

  // Property
  propertyAddressLine1: z.string().min(1),
  propertyAddressLine2: z.string().optional(),
  propertyCity: z.string().min(1),
  propertyState: z.string().length(2),
  propertyZip: z.string().min(5),
  propertyCounty: z.enum(COUNTY_VALUES),
  pin: z.string().min(1),
  additionalPins: z.array(z.string()).default([]),

  // Survey
  surveyType: z.enum(["boundary", "alta", "condominium", "topography", "other"]),
  propertyType: z
    .enum(["sfr", "sfr_townhome", "apartment", "commercial", "vacant_land", "farm", "other"])
    .optional(),

  // Preferences & logistics (all optional for backwards compatibility)
  deliveryPreference: z.enum(["pdf_only", "pdf_usps", "pdf_fedex"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  closingDate: z.string().optional(),
  requestedDate: z.string().optional(),
  onsiteContactFirstName: z.string().optional(),
  onsiteContactLastName: z.string().optional(),
  onsiteContactPhone: z.string().optional(),
  lockedGates: z.enum(["yes", "no", "na"]).optional(),
  legalDescription: z.string().optional(),

  // Admin / internal
  paymentTerms: z
    .enum(["pre_pay", "fifty_fifty", "full_with_discount", "post_closing"])
    .optional(),
  referralSource: z.string().optional(),
  team: z.enum(["residential", "public"]).default("residential"),

  // Billing address
  ...billingAddressFields,
}).superRefine(billingAddressRefinement);

const signSchema = z.object({
  signerName: z.string().min(1),
  signerEmail: z.string().email(),
  s3Key: z.string().min(1),
  ipAddress: z.string().optional(),
});

const supplementalSchema = z.object({
  closingDate: z.string().optional(),
  requestedDate: z.string().optional(),
  paymentTerms: z
    .enum(["pre_pay", "fifty_fifty", "full_with_discount", "post_closing"])
    .optional(),
  onsiteContactFirstName: z.string().optional(),
  onsiteContactLastName: z.string().optional(),
  onsiteContactPhone: z.string().optional(),
  lockedGates: z.enum(["yes", "no", "na"]).optional(),
  deliveryPreference: z.enum(["pdf_only", "pdf_usps", "pdf_fedex"]).optional(),
  legalDescription: z.string().optional(),
  // Partial data is also stored in abandoned_forms for recovery
  partialData: z.record(z.unknown()).optional(),
});

const paymentAcceptSchema = z.object({
  // Contact info for acceptance (may differ from quote contact)
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),

  // Order supplemental data
  closingDate: z.string().optional(),
  requestedDate: z.string().optional(),
  paymentTerms: z
    .enum(["pre_pay", "fifty_fifty", "full_with_discount", "post_closing"])
    .optional(),
  onsiteContactFirstName: z.string().optional(),
  onsiteContactLastName: z.string().optional(),
  onsiteContactPhone: z.string().optional(),
  lockedGates: z.enum(["yes", "no", "na"]).optional(),
  deliveryPreference: z.enum(["pdf_only", "pdf_usps", "pdf_fedex"]).optional(),
  legalDescription: z.string().optional(),
});

// ─── publicQuoteRequestRouter — /api/quote-requests ──────────────────────────

export const publicQuoteRequestRouter = Router();

// ── Draft creation schema (contact info only) ────────────────────────────────

const draftSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(7),
  customerType: z.enum(QUOTE_CUSTOMER_TYPE_VALUES),
  team: z.enum(["residential", "public"]).default("residential"),
});

// ── Finalize draft schema (remaining form data) ──────────────────────────────

const finalizeDraftSchema = z.object({
  propertyAddressLine1: z.string().min(1),
  propertyAddressLine2: z.string().optional(),
  propertyCity: z.string().min(1),
  propertyState: z.string().length(2),
  propertyZip: z.string().min(5),
  propertyCounty: z.enum(COUNTY_VALUES),
  pin: z.string().min(1),
  additionalPins: z.array(z.string()).default([]),
  surveyType: z.enum(["boundary", "alta", "condominium", "topography", "other"]),
  propertyType: z
    .enum(["sfr", "sfr_townhome", "apartment", "commercial", "vacant_land", "farm", "other"]),
  deliveryPreference: z.enum(["pdf_only", "pdf_usps", "pdf_fedex"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  closingDate: z.string().optional(),
  onsiteContactFirstName: z.string().optional(),
  onsiteContactLastName: z.string().optional(),
  onsiteContactPhone: z.string().optional(),
  lockedGates: z.enum(["yes", "no", "na"]).optional(),
  legalDescription: z.string().optional(),
  paymentTerms: z
    .enum(["pre_pay", "fifty_fifty", "full_with_discount", "post_closing"])
    .optional(),
  referralSource: z.string().optional(),
  team: z.enum(["residential", "public"]).optional(),
  ...billingAddressFields,
}).superRefine(billingAddressRefinement);

// ── POST /draft — create draft quote from contact step ───────────────────────

publicQuoteRequestRouter.post(
  "/draft",
  publicRateLimit,
  validateBody(draftSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof draftSchema>;

      const quote = await quoteService.createDraft({
        clientFirstName: body.firstName,
        clientLastName: body.lastName,
        clientEmail: body.email,
        clientPhone: body.phone,
        team: body.team,
        customerType: body.customerType,
      });

      const typedQuote = quote as { id: string; quoteNumber: string; status: string; clientId: string };

      identifyAndTrackEvent(
        typedQuote.id,
        { email: body.email, first_name: body.firstName, last_name: body.lastName },
        CustomerIoEventsNames.QUOTE_FORM_STARTED,
        {
          quote_id: typedQuote.id,
          quote_number: typedQuote.quoteNumber,
          form_resume_url: `${envStore.FRONTEND_URL}/request-quote?resume=${typedQuote.id}`,
        },
      ).catch((err) => logger.warn("CustomerIO quote_form_started failed", { err }));

      logger.info("Draft quote created from public form", {
        quoteId: typedQuote.id,
        email: body.email,
      });

      const io = req.app.get("io") as SocketServer | undefined;
      emitDashboardEvent(io, "dashboard:quotes", "quote:created", {
        quoteId: typedQuote.id,
        quoteNumber: typedQuote.quoteNumber,
        status: typedQuote.status,
      });

      res.status(201).json({ data: quote });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ── GET /resume/:id — return draft quote data for form resume (public, rate limited) ──

publicQuoteRequestRouter.get(
  "/resume/:id",
  publicRateLimit,
  async (req, res) => {
    try {
      const { id } = req.params as { id: string };

      const quote = await prisma.quote.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          lastCompletedStep: true,
          surveyType: true,
          propertyAddressLine1: true,
          propertyAddressLine2: true,
          propertyCity: true,
          propertyState: true,
          propertyZip: true,
          propertyCounty: true,
          pin: true,
          client: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      });

      if (!quote) {
        return sendError(res, new NotFoundError("Quote not found"));
      }

      if (quote.status !== QuoteStatus.draft) {
        return res.status(410).json({
          error: {
            code: "QUOTE_FINALIZED",
            message: "This quote has already been submitted",
          },
        });
      }

      sendSuccess(res, {
        id: quote.id,
        status: quote.status,
        lastCompletedStep: quote.lastCompletedStep ?? 1,
        surveyType: quote.surveyType,
        propertyAddressLine1: quote.propertyAddressLine1,
        propertyAddressLine2: quote.propertyAddressLine2,
        propertyCity: quote.propertyCity,
        propertyState: quote.propertyState,
        propertyZip: quote.propertyZip,
        propertyCounty: quote.propertyCounty,
        pin: quote.pin,
        email: quote.client?.email,
        firstName: quote.client?.firstName ?? "",
        lastName: quote.client?.lastName ?? "",
      });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ── PUT /:id/finalize — finalize draft with full form data ───────────────────

publicQuoteRequestRouter.put(
  "/:id/finalize",
  publicRateLimit,
  validateBody(finalizeDraftSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof finalizeDraftSchema>;

      const quote = await quoteService.finalizeDraft(req.params["id"]!, body);

      const typedQuote = quote as {
        id: string;
        quoteNumber: string;
        status: string;
        source: string | null;
        surveyType: string | null;
        propertyAddressLine1: string | null;
        propertyAddressLine2: string | null;
        propertyCity: string | null;
        propertyState: string | null;
        propertyZip: string | null;
        client: { id: string; email: string; firstName: string; lastName: string };
      };

      const io = req.app.get("io") as SocketServer | undefined;
      emitDashboardEvent(io, "dashboard:quotes", "quote:updated", {
        quoteId: typedQuote.id,
        status: typedQuote.status,
      });

      identifyAndTrackEvent(
        typedQuote.id,
        { email: typedQuote.client.email, first_name: typedQuote.client.firstName, last_name: typedQuote.client.lastName },
        CustomerIoEventsNames.QUOTE_FORM_COMPLETED,
        { quote_id: typedQuote.id, quote_number: typedQuote.quoteNumber },
      ).catch((err: unknown) => logger.warn("CustomerIO quote_form_completed failed", { err }));

      const clientName = `${typedQuote.client.firstName} ${typedQuote.client.lastName}`;
      notifyAdminsQuoteNew(typedQuote, clientName, io).catch(() => {});

      logger.info("Draft quote finalized from public form", {
        quoteId: typedQuote.id,
      });

      res.status(200).json({ data: quote });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ── POST / — full quote request (portal QuoteRequestModal) ──────────────────

publicQuoteRequestRouter.post(
  "/",
  publicRateLimit,
  validateBody(quoteRequestSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof quoteRequestSchema>;

      const quote = await quoteService.create(
        {
          clientFirstName: body.firstName,
          clientLastName: body.lastName,
          clientEmail: body.email,
          clientPhone: body.phone,
          customerType: body.customerType,
          propertyAddressLine1: body.propertyAddressLine1,
          propertyAddressLine2: body.propertyAddressLine2,
          propertyCity: body.propertyCity,
          propertyState: body.propertyState,
          propertyZip: body.propertyZip,
          propertyCounty: body.propertyCounty,
          pin: body.pin,
          additionalPins: body.additionalPins,
          surveyType: body.surveyType,
          propertyType: body.propertyType,
          deliveryPreference: body.deliveryPreference,
          priority: body.priority,
          closingDate: body.closingDate,
          requestedDate: body.requestedDate,
          onsiteContactFirstName: body.onsiteContactFirstName,
          onsiteContactLastName: body.onsiteContactLastName,
          onsiteContactPhone: body.onsiteContactPhone,
          lockedGates: body.lockedGates,
          legalDescription: body.legalDescription,
          paymentTerms: body.paymentTerms,
          referralSource: body.referralSource,
          source: "website",
          team: body.team,
        },
        undefined
      );

      const typedQuote = quote as { id: string; quoteNumber: string; status: string };

      const io = req.app.get("io") as SocketServer | undefined;
      emitDashboardEvent(io, "dashboard:quotes", "quote:created", {
        quoteId: typedQuote.id,
        quoteNumber: typedQuote.quoteNumber,
        status: typedQuote.status,
      });

      logger.info("Public quote request received", {
        quoteId: typedQuote.id,
        email: body.email,
      });

      res.status(201).json({ data: quote });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── quoteTokenRouter — public token-based endpoints ─────────────────────────
// Mount at /api/quote in app.ts

export const quoteTokenRouter = Router();

// ─── GET /:token — validate token, return quote details ───────────────────────

quoteTokenRouter.get("/:token", async (req, res) => {
  try {
    const tokenRecord = await prisma.quoteToken.findUnique({
      where: { token: req.params["token"]! },
      include: {
        quote: {
          include: {
            client: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
              },
            },
          },
        },
      },
    });

    if (!tokenRecord) {
      throw new NotFoundError("Quote acceptance link not found");
    }
    if (tokenRecord.usedAt) {
      throw new ValidationError("This quote acceptance link has already been used");
    }
    if (tokenRecord.expiresAt < new Date()) {
      throw new ValidationError("This quote acceptance link has expired");
    }

    const quote = tokenRecord.quote;
    if (!quote || quote.deletedAt) {
      throw new NotFoundError("Quote not found");
    }
    if (quote.status !== QuoteStatus.sent) {
      throw new ValidationError(`Quote is not available for acceptance (status: ${quote.status})`);
    }

    sendSuccess(res, {
      token: tokenRecord.token,
      expiresAt: tokenRecord.expiresAt,
      quote: {
        id: quote.id,
        quoteNumber: quote.quoteNumber,
        surveyType: quote.surveyType,
        price: quote.price,
        paymentTerms: quote.paymentTerms,
        expiryDate: quote.expiryDate,
        propertyAddressLine1: quote.propertyAddressLine1,
        propertyAddressLine2: quote.propertyAddressLine2,
        propertyCity: quote.propertyCity,
        propertyState: quote.propertyState,
        propertyZip: quote.propertyZip,
        propertyCounty: quote.propertyCounty,
        pin: quote.pin,
        client: quote.client,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /:token/sign — save contract signature ──────────────────────────────

quoteTokenRouter.post(
  "/:token/sign",
  publicRateLimit,
  validateBody(signSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof signSchema>;

      const tokenRecord = await prisma.quoteToken.findUnique({
        where: { token: req.params["token"]! },
        select: { quoteId: true, usedAt: true, expiresAt: true },
      });

      if (!tokenRecord) {
        throw new NotFoundError("Quote acceptance link not found");
      }
      if (tokenRecord.usedAt) {
        throw new ValidationError("This acceptance link has already been used");
      }
      if (tokenRecord.expiresAt < new Date()) {
        throw new ValidationError("This acceptance link has expired");
      }

      const signature = await prisma.contractSignature.create({
        data: {
          quoteId: tokenRecord.quoteId,
          signerName: body.signerName,
          signerEmail: body.signerEmail,
          s3Key: body.s3Key,
          signedAt: new Date(),
          ipAddress: body.ipAddress ?? (req.ip ?? null),
        },
      });

      logger.info("Contract signature saved", {
        quoteId: tokenRecord.quoteId,
        signatureId: signature.id,
        signerEmail: body.signerEmail,
      });

      sendSuccess(res, signature, 201);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── POST /:token/supplemental — save supplemental / partial form data ────────

quoteTokenRouter.post(
  "/:token/supplemental",
  publicRateLimit,
  validateBody(supplementalSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof supplementalSchema>;

      const tokenRecord = await prisma.quoteToken.findUnique({
        where: { token: req.params["token"]! },
        select: {
          quoteId: true,
          usedAt: true,
          expiresAt: true,
          quote: { select: { client: { select: { email: true } } } },
        },
      });

      if (!tokenRecord) {
        throw new NotFoundError("Quote acceptance link not found");
      }
      if (tokenRecord.usedAt) {
        throw new ValidationError("This acceptance link has already been used");
      }

      // Upsert abandoned form record with the latest partial data
      const { partialData, ...supplemental } = body;
      const storedData = { ...supplemental, ...(partialData ?? {}) };

      const abandonedForm = await prisma.abandonedForm.create({
        data: {
          formType: "quote_acceptance",
          email: tokenRecord.quote.client?.email ?? "unknown",
          partialData: storedData,
          quoteId: tokenRecord.quoteId,
          abandonedAt: new Date(),
        },
      });

      logger.info("Supplemental form data saved", {
        quoteId: tokenRecord.quoteId,
        abandonedFormId: abandonedForm.id,
      });

      sendSuccess(res, { saved: true, id: abandonedForm.id });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── POST /:token/payment — atomic: create order + accept quote ───────────────

quoteTokenRouter.post(
  "/:token/payment",
  publicRateLimit,
  validateBody(paymentAcceptSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof paymentAcceptSchema>;

      const result = await quoteService.accept(
        req.params["token"]!,
        {
          firstName: body.firstName,
          lastName: body.lastName,
          email: body.email,
          phone: body.phone,
          closingDate: body.closingDate,
          requestedDate: body.requestedDate,
          paymentTerms: body.paymentTerms,
          onsiteContactFirstName: body.onsiteContactFirstName,
          onsiteContactLastName: body.onsiteContactLastName,
          onsiteContactPhone: body.onsiteContactPhone,
          lockedGates: body.lockedGates,
          deliveryPreference: body.deliveryPreference,
          legalDescription: body.legalDescription,
        },
        undefined
      );

      const io = req.app.get("io") as SocketServer | undefined;
      const typedResult = result as {
        quote: { id: string; status: string };
        order: {
          id: string;
          orderNumber: string;
          status: string;
          price: { toString(): string } | number | string | null;
          surveyType: string | null;
          propertyAddressLine1: string | null;
          propertyCity: string | null;
          propertyState: string | null;
          propertyZip: string | null;
          source: OrderSource | null;
        };
        clientName: string;
      };
      emitDashboardEvent(io, "dashboard:quotes", "quote:updated", {
        quoteId: typedResult.quote.id,
        status: typedResult.quote.status,
      });
      emitDashboardEvent(io, "dashboard:orders", "order:created", {
        orderId: typedResult.order.id,
        orderNumber: typedResult.order.orderNumber,
        status: typedResult.order.status,
      });

      // Order from quote goes directly to research_in_progress — notify
      notifyResearchLeader(typedResult.order, typedResult.clientName, io).catch(() => {});

      res.status(201).json({ data: result });
    } catch (err) {
      sendError(res, err);
    }
  }
);
