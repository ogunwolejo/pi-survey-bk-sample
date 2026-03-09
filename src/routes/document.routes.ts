import { Router } from "express";
import { z } from "zod";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Prisma, type ResearchDocumentType } from "@prisma/client";
import { envStore } from "../env-store";
import { prisma } from "../lib/prisma";
import { fileLogger as logger } from "../lib/logger";
import { sendSuccess, sendPaginated, sendError, sendNoContent } from "../lib/response";
import { NotFoundError, ValidationError } from "../lib/errors";
import { requireAuth } from "../middleware/auth.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";

const router = Router();

// ─── S3 Client ────────────────────────────────────────────────────────────────

const s3 = new S3Client({ region: envStore.AWS_REGION });

const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/tiff",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
]);

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const UPLOAD_URL_EXPIRY_SECONDS = 900; // 15 min
const DOWNLOAD_URL_EXPIRY_SECONDS = 3600; // 1 hr

// ─── Schemas ──────────────────────────────────────────────────────────────────

const uploadSchema = z.object({
  entityType: z.enum(["job", "order"]),
  entityId: z.string().min(1),
  documentType: z.string().min(1),
  filename: z.string().min(1),
  displayName: z.string().max(255).optional(),
  contentType: z.string().min(1),
  fileSize: z.number().int().positive(),
  researchDocType: z.enum([
    "plat_of_subdivision",
    "sidwell_map",
    "title_commitment",
    "recorded_deed",
    "legal_description",
    "certificate_of_correction",
    "order_form",
    "other",
  ]).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  job_id: z.string().optional(),
  order_id: z.string().optional(),
  document_type: z.string().optional(),
});

// ─── POST /upload ─────────────────────────────────────────────────────────────

router.post("/upload", requireAuth, validateBody(uploadSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof uploadSchema>;

    if (!ALLOWED_CONTENT_TYPES.has(body.contentType)) {
      throw new ValidationError(`Content type '${body.contentType}' is not allowed`);
    }

    if (body.fileSize > MAX_FILE_SIZE_BYTES) {
      throw new ValidationError("File size exceeds the 100 MB limit");
    }

    if (body.entityType === "job") {
      const job = await prisma.job.findFirst({ where: { id: body.entityId, deletedAt: null } });
      if (!job) throw new NotFoundError("Job not found");
    } else {
      const order = await prisma.order.findFirst({ where: { id: body.entityId, deletedAt: null } });
      if (!order) throw new NotFoundError("Order not found");
    }

    const sanitizedFilename = body.filename.replace(/[^a-zA-Z0-9._\-]/g, "_");
    const s3Key = `${body.entityType}/${body.entityId}/${Date.now()}-${sanitizedFilename}`;

    const command = new PutObjectCommand({
      Bucket: envStore.AWS_S3_BUCKET,
      Key: s3Key,
      ContentType: body.contentType,
      ContentLength: body.fileSize,
    });

    const uploadUrl = await getSignedUrl(s3, command, {
      expiresIn: UPLOAD_URL_EXPIRY_SECONDS,
    });

    const document = await prisma.documentMetadata.create({
      data: {
        ...(body.entityType === "job" ? { jobId: body.entityId } : {}),
        ...(body.entityType === "order" ? { orderId: body.entityId } : {}),
        documentType: body.documentType,
        filename: body.filename,
        displayName: body.displayName || null,
        s3Key,
        fileSize: BigInt(body.fileSize),
        uploadedBy: req.user!.userId,
        uploadedAt: new Date(),
        ...(body.researchDocType ? { researchDocType: body.researchDocType as ResearchDocumentType } : {}),
      },
    });

    logger.info("Document pre-signed URL generated", {
      documentId: document.id,
      entityType: body.entityType,
      entityId: body.entityId,
    });

    sendSuccess(
      res,
      {
        uploadUrl,
        documentId: document.id,
        s3Key,
        expiresIn: UPLOAD_URL_EXPIRY_SECONDS,
      },
      201
    );
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /:id/download ────────────────────────────────────────────────────────

router.get("/:id/download", requireAuth, async (req, res) => {
  try {
    const document = await prisma.documentMetadata.findUnique({
      where: { id: req.params["id"]! },
    });

    if (!document) throw new NotFoundError("Document not found");

    const command = new GetObjectCommand({
      Bucket: envStore.AWS_S3_BUCKET,
      Key: document.s3Key,
      ResponseContentDisposition: `attachment; filename="${document.filename}"`,
    });

    const downloadUrl = await getSignedUrl(s3, command, {
      expiresIn: DOWNLOAD_URL_EXPIRY_SECONDS,
    });

    sendSuccess(res, {
      downloadUrl,
      filename: document.filename,
      documentType: document.documentType,
      expiresIn: DOWNLOAD_URL_EXPIRY_SECONDS,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get("/", requireAuth, validateQuery(listQuerySchema), async (req, res) => {
  try {
    const q = req.query as unknown as z.infer<typeof listQuerySchema>;

    const where: Prisma.DocumentMetadataWhereInput = {
      ...(q.job_id ? { jobId: q.job_id } : {}),
      ...(q.order_id ? { orderId: q.order_id } : {}),
      ...(q.document_type ? { documentType: q.document_type } : {}),
    };

    const [total, documents] = await Promise.all([
      prisma.documentMetadata.count({ where }),
      prisma.documentMetadata.findMany({
        where,
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        orderBy: { uploadedAt: "desc" },
        include: {
          uploadedByUser: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    const serialized = documents.map((doc) => ({
      ...doc,
      fileSize: Number(doc.fileSize),
    }));

    sendPaginated(res, serialized, q.page, q.limit, total);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const document = await prisma.documentMetadata.findUnique({
      where: { id: req.params["id"]! },
    });

    if (!document) throw new NotFoundError("Document not found");

    await prisma.documentMetadata.delete({ where: { id: req.params["id"]! } });

    sendNoContent(res);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
