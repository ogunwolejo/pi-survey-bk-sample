import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { sendSuccess, sendPaginated, sendError, sendNoContent } from "../lib/response";
import { NotFoundError } from "../lib/errors";
import { requireAuth } from "../middleware/auth.middleware";
import { requireAdmin } from "../middleware/rbac.middleware";
import { teamFilterMiddleware, getTeamFilter } from "../middleware/team-filter.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import { contactLogger as logger } from "../lib/logger";
import {
  list,
  getById,
  create,
  update,
  softDelete,
  getOrderHistory,
  getActivityFeed,
  addCompanyAssociation,
  removeCompanyAssociation,
  exportToCsv,
  findDuplicates,
  merge,
  findOrCreateFromSubmission,
} from "../services/contact.service";

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().optional(),
  customer_type: z
    .enum(["homeowner", "attorney", "title_company", "other"])
    .optional(),
  company: z.string().optional(),
  vip: z.enum(["true", "false"]).optional(),
  has_active_orders: z.enum(["true", "false"]).optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  payment_terms: z
    .enum(["pre_pay", "post_closing", "net_30", "net_60"])
    .optional(),
  team: z.enum(["residential", "public"]).optional(),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const createContactSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  customerType: z.enum(["homeowner", "attorney", "title_company", "other"]),
  paymentTerms: z.enum(["pre_pay", "post_closing", "net_30", "net_60"]).optional(),
  preferredPaymentMethod: z.string().optional(),
  vip: z.boolean().default(false),
  creditLimit: z.number().positive().optional(),
  communicationPreferences: z.record(z.unknown()).optional(),
  operationalNotes: z.string().optional(),
  source: z.enum(["order_form", "quote_form", "internal", "imported"]).default("internal"),
});

const updateContactSchema = createContactSchema.partial();

const companyAssociationSchema = z.object({
  companyId: z.string().min(1),
  role: z.string().min(1),
  isPrimary: z.boolean().default(false),
});

const mergeSchema = z.object({
  secondaryId: z.string().min(1),
});

const exportSchema = z.object({
  search: z.string().optional(),
  customer_type: z.enum(["homeowner", "attorney", "title_company", "other"]).optional(),
});

const findOrCreateSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1),
  customerType: z.enum(["homeowner", "attorney", "title_company", "other"]).default("homeowner"),
  source: z.enum(["order_form", "quote_form", "internal", "imported"]).default("internal"),
});

// ─── GET /summary ─────────────────────────────────────────────────────────────

router.get("/summary", requireAuth, async (_req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [total, active, vip, newThisMonth] = await Promise.all([
      prisma.client.count({ where: { deletedAt: null } }),
      prisma.client.count({
        where: { deletedAt: null, ordersAsClient: { some: { deletedAt: null } } },
      }),
      prisma.client.count({ where: { deletedAt: null, vip: true } }),
      prisma.client.count({
        where: { deletedAt: null, createdAt: { gte: startOfMonth } },
      }),
    ]);

    sendSuccess(res, { total, active, vip, new_this_month: newThisMonth });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /duplicates ──────────────────────────────────────────────────────────

router.get("/duplicates", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const duplicates = await findDuplicates();
    sendSuccess(res, duplicates);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /export ─────────────────────────────────────────────────────────────

router.post("/export", requireAuth, validateBody(exportSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof exportSchema>;

    const contacts = await exportToCsv({
      search: body.search,
      customerType: body.customer_type,
    }) as Array<{
      id: string;
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      customerType: string;
      addressLine1?: string | null;
      city?: string | null;
      state?: string | null;
      zipCode?: string | null;
      totalOrders: number;
      createdAt: Date;
    }>;

    const csvField = (value: string | number): string => {
      const s = String(value);
      return `"${s.replace(/"/g, '""')}"`;
    };

    const header = "id,first_name,last_name,email,phone,customer_type,address_line_1,city,state,zip_code,total_orders,created_at";
    const rows = contacts.map((c) =>
      [
        csvField(c.id),
        csvField(c.firstName),
        csvField(c.lastName),
        csvField(c.email),
        csvField(c.phone),
        csvField(c.customerType),
        csvField(c.addressLine1 ?? ""),
        csvField(c.city ?? ""),
        csvField(c.state ?? ""),
        csvField(c.zipCode ?? ""),
        csvField(c.totalOrders),
        csvField(c.createdAt.toISOString()),
      ].join(",")
    );

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=contacts.csv");
    res.send([header, ...rows].join("\n"));
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /find-or-create ─────────────────────────────────────────────────────

router.post("/find-or-create", requireAuth, validateBody(findOrCreateSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof findOrCreateSchema>;

    const contact = await findOrCreateFromSubmission({
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      phone: body.phone,
      customerType: body.customerType,
      source: body.source,
      createdBy: req.user!.userId,
    });

    sendSuccess(res, contact, 200);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get("/", requireAuth, teamFilterMiddleware, validateQuery(listQuerySchema), async (req, res) => {
  try {
    const q = req.query as unknown as z.infer<typeof listQuerySchema>;
    const teamFilter = getTeamFilter(res);

    const { data, total } = await list(
      {
        search: q.search,
        customerType: q.customer_type,
      },
      q.page,
      q.limit,
      teamFilter
    );

    sendPaginated(res, data, q.page, q.limit, total);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const contact = await getById(req.params["id"]!);
    sendSuccess(res, contact);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST / ───────────────────────────────────────────────────────────────────

router.post("/", requireAuth, validateBody(createContactSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof createContactSchema>;

    const existing = await prisma.client.findUnique({ where: { email: body.email } });
    if (existing && !existing.deletedAt) {
      sendSuccess(res, existing, 200);
      return;
    }

    const contact = await create({ ...body, createdBy: req.user!.userId });
    logger.info("Contact created", { contactId: (contact as { id: string }).id, email: body.email });
    sendSuccess(res, contact, 201);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

router.put("/:id", requireAuth, validateBody(updateContactSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof updateContactSchema>;
    const contact = await update(req.params["id"]!, { ...body, updatedBy: req.user!.userId });
    sendSuccess(res, contact);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await softDelete(req.params["id"]!);
    logger.info("Contact soft-deleted", { contactId: req.params["id"]! });
    sendNoContent(res);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /:id/orders ──────────────────────────────────────────────────────────

router.get("/:id/orders", requireAuth, validateQuery(paginationSchema), async (req, res) => {
  try {
    const q = req.query as unknown as z.infer<typeof paginationSchema>;
    const { data, total } = await getOrderHistory(req.params["id"]!, q.page, q.limit);
    sendPaginated(res, data, q.page, q.limit, total);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /:id/activity ────────────────────────────────────────────────────────

router.get("/:id/activity", requireAuth, validateQuery(paginationSchema), async (req, res) => {
  try {
    const q = req.query as unknown as z.infer<typeof paginationSchema>;
    const { data, total } = await getActivityFeed(req.params["id"]!, q.page, q.limit);
    sendPaginated(res, data, q.page, q.limit, total);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /:id/companies ──────────────────────────────────────────────────────

router.post(
  "/:id/companies",
  requireAuth,
  validateBody(companyAssociationSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof companyAssociationSchema>;
      const association = await addCompanyAssociation(
        req.params["id"]!,
        body.companyId,
        body.role,
        body.isPrimary
      );
      sendSuccess(res, association, 201);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── DELETE /:id/companies/:companyId ─────────────────────────────────────────

router.delete("/:id/companies/:companyId", requireAuth, async (req, res) => {
  try {
    await removeCompanyAssociation(req.params["id"]!, req.params["companyId"]!);
    sendNoContent(res);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /:id/merge ──────────────────────────────────────────────────────────

router.post("/:id/merge", requireAuth, requireAdmin, validateBody(mergeSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof mergeSchema>;

    const contact = await prisma.client.findFirst({
      where: { id: req.params["id"]!, deletedAt: null },
    });
    if (!contact) throw new NotFoundError("Contact not found");

    const result = await merge(req.params["id"]!, body.secondaryId, req.user!.userId);
    logger.info("Contacts merged", { primaryId: req.params["id"]!, secondaryId: body.secondaryId });
    sendSuccess(res, result);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
