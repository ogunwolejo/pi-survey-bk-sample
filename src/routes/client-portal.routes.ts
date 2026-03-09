import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import rateLimit from "express-rate-limit";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { envStore } from "../env-store";
import { prisma } from "../lib/prisma";
import { optionalAuth } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { NotFoundError, AuthorizationError } from "../lib/errors";
import { generalLogger as logger } from "../lib/logger";
import { sendEmail } from "../services/email.service";

const router = Router();

const s3 = new S3Client({ region: envStore.AWS_REGION });
const S3_BUCKET = envStore.AWS_S3_BUCKET;

// ---------------------------------------------------------------------------
// Client-friendly order status mapping (omits internal statuses)
// ---------------------------------------------------------------------------
const CLIENT_ORDER_STATUS: Record<string, string> = {
  draft: "Order Received",
  pending_contract: "Order Received",
  pending_payment: "Payment Pending",
  paid: "In Progress",
  research_in_progress: "In Progress",
  research_complete: "Processing",
  ready_for_field: "Field Work Scheduled",
  complete: "Delivered",
};

function mapClientStatus(status: string): string {
  return CLIENT_ORDER_STATUS[status] ?? status;
}

// ---------------------------------------------------------------------------
// requireClientPortalAuth middleware (inline)
// Validates Bearer session_token against client_portal_sessions
// ---------------------------------------------------------------------------
async function requireClientPortalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing client portal session token" } });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const session = await prisma.clientPortalSession.findFirst({
      where: {
        sessionToken: token,
        expiresAt: { gt: new Date() },
      },
    });

    if (!session) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid or expired session" } });
      return;
    }

    res.locals["clientId"] = session.clientId;
    next();
  } catch {
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Authentication error" } });
  }
}

// ---------------------------------------------------------------------------
// Rate limiter: 3 magic-link requests per 15 min per email
// ---------------------------------------------------------------------------
const magicLinkRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const body = req.body as Record<string, unknown>;
    return typeof body["email"] === "string" ? body["email"] : (req.ip ?? "unknown");
  },
  message: {
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many magic link requests. Please try again later.",
    },
  },
});

// ---------------------------------------------------------------------------
// POST /magic-link → optionalAuth, create magic link for client
// Always returns 200 to prevent email enumeration
// ---------------------------------------------------------------------------
const magicLinkSchema = z.object({
  email: z.string().email(),
});

router.post(
  "/magic-link",
  optionalAuth,
  magicLinkRateLimit,
  validateBody(magicLinkSchema),
  async (req: Request, res: Response) => {
    try {
      const { email } = req.body as z.infer<typeof magicLinkSchema>;

      const client = await prisma.client.findUnique({
        where: { email, deletedAt: null },
      });

      if (client) {
        const token = uuidv4();
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await prisma.magicLinkRequest.create({
          data: {
            token,
            email,
            clientId: client.id,
            expiresAt,
          },
        });

        const magicLinkUrl = `${envStore.FRONTEND_URL}/client-portal/auth/${token}`;

        await sendEmail({
          to: email,
          subject: "Your Pi Surveying Portal access link",
          html: [
            `<p>Hi ${client.firstName ?? ""},</p>`,
            `<p>Click the link below to access your Pi Surveying client portal:</p>`,
            `<p><a href="${magicLinkUrl}">Sign in to your portal</a></p>`,
            `<p>This link expires at ${expiresAt.toLocaleString()}. If you didn't request this, you can safely ignore this email.</p>`,
            `<p>— Pi Surveying</p>`,
          ].join("\n"),
        }).catch((err) => {
          logger.error("Failed to send magic link email", {
            error: String(err),
            email,
          });
        });
      } else {
        logger.info("Magic link requested for unknown email (not sent)", { email });
      }

      logger.info("Magic link request processed", { email });
      sendSuccess(res, {
        message: "If an account exists for this email, a sign-in link has been sent.",
      });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /auth/:token → validate magic link or portal token, create session
// ---------------------------------------------------------------------------
router.get("/auth/:token", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const now = new Date();
    const sessionExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    // Check ClientPortalToken (long-lived token link)
    const portalToken = await prisma.clientPortalToken.findUnique({
      where: { token },
      include: { client: true },
    });

    if (portalToken && !portalToken.revokedAt) {
      await prisma.clientPortalToken.update({
        where: { id: portalToken.id },
        data: { lastAccessedAt: now },
      });

      const sessionToken = uuidv4();
      await prisma.clientPortalSession.create({
        data: {
          clientId: portalToken.clientId,
          sessionToken,
          authMethod: "token_link",
          expiresAt: sessionExpiry,
        },
      });

      const { client } = portalToken;
      logger.info("Client portal session created via token link", { clientId: client.id });
      sendSuccess(res, {
        sessionToken,
        expiresAt: sessionExpiry,
        client: {
          id: client.id,
          firstName: client.firstName,
          lastName: client.lastName,
          email: client.email,
          phone: client.phone,
        },
      });
      return;
    }

    // Check MagicLinkRequest
    const magicLink = await prisma.magicLinkRequest.findUnique({
      where: { token },
      include: { client: true },
    });

    if (magicLink && !magicLink.usedAt && magicLink.expiresAt > now && magicLink.client) {
      await prisma.magicLinkRequest.update({
        where: { id: magicLink.id },
        data: { usedAt: now },
      });

      const sessionToken = uuidv4();
      await prisma.clientPortalSession.create({
        data: {
          clientId: magicLink.client.id,
          sessionToken,
          authMethod: "magic_link",
          expiresAt: sessionExpiry,
        },
      });

      const { client } = magicLink;
      logger.info("Client portal session created via magic link", { clientId: client.id });
      sendSuccess(res, {
        sessionToken,
        expiresAt: sessionExpiry,
        client: {
          id: client.id,
          firstName: client.firstName,
          lastName: client.lastName,
          email: client.email,
          phone: client.phone,
        },
      });
      return;
    }

    throw new NotFoundError("Invalid or expired token");
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------------------
// GET /orders → client portal auth, list client orders with client-friendly status
// ---------------------------------------------------------------------------
router.get("/orders", requireClientPortalAuth, async (_req: Request, res: Response) => {
  try {
    const clientId = res.locals["clientId"] as string;

    const orders = await prisma.order.findMany({
      where: { clientId, deletedAt: null },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        surveyType: true,
        propertyAddressLine1: true,
        propertyAddressLine2: true,
        propertyCity: true,
        propertyState: true,
        propertyZip: true,
        propertyCounty: true,
        deliveryPreference: true,
        createdAt: true,
        updatedAt: true,
        deliveryTracking: {
          select: {
            trackingToken: true,
            status: true,
            trackingNumber: true,
            carrierUrl: true,
            estimatedDelivery: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const mapped = orders.map((o) => ({
      ...o,
      clientStatus: mapClientStatus(o.status),
    }));

    sendSuccess(res, mapped);
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------------------
// GET /orders/:id → client portal auth, order detail with client-friendly status
// ---------------------------------------------------------------------------
router.get("/orders/:id", requireClientPortalAuth, async (req: Request, res: Response) => {
  try {
    const clientId = res.locals["clientId"] as string;
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: { id, clientId, deletedAt: null },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        surveyType: true,
        propertyAddressLine1: true,
        propertyAddressLine2: true,
        propertyCity: true,
        propertyState: true,
        propertyZip: true,
        propertyCounty: true,
        pin: true,
        deliveryPreference: true,
        closingDate: true,
        dueDate: true,
        createdAt: true,
        updatedAt: true,
        deliveryTracking: {
          select: {
            trackingToken: true,
            status: true,
            carrier: true,
            trackingNumber: true,
            carrierUrl: true,
            estimatedDelivery: true,
            deliveredAt: true,
            events: {
              orderBy: { occurredAt: "desc" },
              select: { status: true, title: true, description: true, occurredAt: true },
            },
          },
        },
      },
    });

    if (!order) throw new NotFoundError("Order not found");

    sendSuccess(res, {
      ...order,
      clientStatus: mapClientStatus(order.status),
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------------------
// GET /orders/:id/documents/:docId/download → pre-signed S3 URL
// ---------------------------------------------------------------------------
router.get(
  "/orders/:id/documents/:docId/download",
  requireClientPortalAuth,
  async (req: Request, res: Response) => {
    try {
      const clientId = res.locals["clientId"] as string;
      const { id: orderId, docId } = req.params;

      const order = await prisma.order.findFirst({
        where: { id: orderId, clientId, deletedAt: null },
        select: { id: true },
      });
      if (!order) throw new AuthorizationError("Order not found or access denied");

      const doc = await prisma.documentMetadata.findFirst({
        where: { id: docId, orderId },
        select: { id: true, s3Key: true, filename: true, documentType: true },
      });
      if (!doc) throw new NotFoundError("Document not found");

      const command = new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: doc.s3Key,
        ResponseContentDisposition: `attachment; filename="${doc.filename}"`,
      });

      const url = await getSignedUrl(s3, command, { expiresIn: 3600 });

      sendSuccess(res, { url, filename: doc.filename, documentType: doc.documentType });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /preferences → client portal auth, return delivery preferences
// ---------------------------------------------------------------------------
router.get("/preferences", requireClientPortalAuth, async (_req: Request, res: Response) => {
  try {
    const clientId = res.locals["clientId"] as string;

    const prefs = await prisma.clientDeliveryPreference.findUnique({
      where: { clientId },
    });

    sendSuccess(res, prefs ?? null);
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------------------
// PUT /preferences → client portal auth, update delivery preferences
// ---------------------------------------------------------------------------
const updatePreferencesSchema = z.object({
  delivery_method: z.enum(["pdf_only", "pdf_usps", "pdf_fedex"]).optional(),
  mailing_address_line_1: z.string().optional(),
  mailing_address_line_2: z.string().optional(),
  mailing_city: z.string().optional(),
  mailing_state: z.string().max(2).optional(),
  mailing_zip: z.string().optional(),
  email_recipients: z.array(z.string().email()).optional(),
  cc_recipients: z.array(z.string().email()).optional(),
  charge_for_shipping: z.boolean().optional(),
  include_physical_invoice: z.boolean().optional(),
  delivery_location: z.enum(["property", "office"]).optional(),
  special_instructions: z.string().optional(),
});

router.put(
  "/preferences",
  requireClientPortalAuth,
  validateBody(updatePreferencesSchema),
  async (req: Request, res: Response) => {
    try {
      const clientId = res.locals["clientId"] as string;
      const body = req.body as z.infer<typeof updatePreferencesSchema>;

      const updateData = {
        ...(body.delivery_method !== undefined && { deliveryMethod: body.delivery_method }),
        ...(body.mailing_address_line_1 !== undefined && { mailingAddressLine1: body.mailing_address_line_1 }),
        ...(body.mailing_address_line_2 !== undefined && { mailingAddressLine2: body.mailing_address_line_2 }),
        ...(body.mailing_city !== undefined && { mailingCity: body.mailing_city }),
        ...(body.mailing_state !== undefined && { mailingState: body.mailing_state }),
        ...(body.mailing_zip !== undefined && { mailingZip: body.mailing_zip }),
        ...(body.email_recipients !== undefined && { emailRecipients: body.email_recipients }),
        ...(body.cc_recipients !== undefined && { ccRecipients: body.cc_recipients }),
        ...(body.charge_for_shipping !== undefined && { chargeForShipping: body.charge_for_shipping }),
        ...(body.include_physical_invoice !== undefined && { includePhysicalInvoice: body.include_physical_invoice }),
        ...(body.delivery_location !== undefined && { deliveryLocation: body.delivery_location }),
        ...(body.special_instructions !== undefined && { specialInstructions: body.special_instructions }),
      };

      const prefs = await prisma.clientDeliveryPreference.upsert({
        where: { clientId },
        create: {
          clientId,
          deliveryMethod: body.delivery_method ?? "pdf_only",
          emailRecipients: body.email_recipients ?? [],
          ccRecipients: body.cc_recipients ?? [],
          ...updateData,
        },
        update: updateData,
      });

      logger.info("Client delivery preferences updated", { clientId });
      sendSuccess(res, prefs);
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /profile → client portal auth, return client profile
// ---------------------------------------------------------------------------
router.get("/profile", requireClientPortalAuth, async (_req: Request, res: Response) => {
  try {
    const clientId = res.locals["clientId"] as string;

    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        zipCode: true,
      },
    });

    if (!client) throw new NotFoundError("Client not found");
    sendSuccess(res, client);
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------------------
// PUT /profile → client portal auth, update name/phone/address (not email)
// ---------------------------------------------------------------------------
const updateProfileSchema = z.object({
  first_name: z.string().min(1).max(255).optional(),
  last_name: z.string().min(1).max(255).optional(),
  phone: z.string().min(7).max(20).optional(),
  address_line_1: z.string().optional(),
  address_line_2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().max(2).optional(),
  zip_code: z.string().optional(),
});

router.put(
  "/profile",
  requireClientPortalAuth,
  validateBody(updateProfileSchema),
  async (req: Request, res: Response) => {
    try {
      const clientId = res.locals["clientId"] as string;
      const body = req.body as z.infer<typeof updateProfileSchema>;

      const profileData = {
        ...(body.first_name !== undefined && { firstName: body.first_name }),
        ...(body.last_name !== undefined && { lastName: body.last_name }),
        ...(body.phone !== undefined && { phone: body.phone }),
        ...(body.address_line_1 !== undefined && { addressLine1: body.address_line_1 }),
        ...(body.address_line_2 !== undefined && { addressLine2: body.address_line_2 }),
        ...(body.city !== undefined && { city: body.city }),
        ...(body.state !== undefined && { state: body.state }),
        ...(body.zip_code !== undefined && { zipCode: body.zip_code }),
      };

      const client = await prisma.client.update({
        where: { id: clientId },
        data: profileData,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          zipCode: true,
        },
      });

      logger.info("Client profile updated", { clientId });
      sendSuccess(res, client);
    } catch (error) {
      sendError(res, error);
    }
  }
);

export default router;
