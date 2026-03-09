import { Router } from "express";
import { z } from "zod";
import { JobStatus, DeliveryChecklistStatus, DeliveryTrackingStatus, StakingRequestStatus, FileCategory, UserRole, Prisma } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import archiver from "archiver";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { prisma } from "../lib/prisma";
import { withTransaction } from "../lib/transaction";
import { canTransition } from "../lib/status-engine";
import { jobLogger as logger } from "../lib/logger";
import { sendSuccess, sendPaginated, sendError } from "../lib/response";
import { NotFoundError, ValidationError } from "../lib/errors";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { teamFilterMiddleware, getTeamFilter } from "../middleware/team-filter.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import { generateS3Key, getUploadPresignedUrl, getDownloadPresignedUrl } from "../lib/s3";
import { envStore } from "../env-store";
import { createSystemEvent } from "../services/job-chat.service";
import { hasOpenCriticalFlags } from "../services/job-issue-flag.service";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import {
  notifyCrewJobAssigned,
  notifyCrewJobReassigned,
  notifyCrewFieldDateChanged,
  loadJobNotificationData,
  loadCrewWithMembers,
} from "../services/notification.service";

const router = Router();

const ADMIN_ROLES = new Set(["super_admin", "admin", "office_manager"]);

// ─── Schemas ──────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z
    .enum(["unassigned", "assigned", "in_progress", "field_complete", "ready_for_drafting", "drafting", "drafted", "pls_review", "awaiting_corrections", "ready_for_delivery", "complete"])
    .optional(),
  assigned_crew: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  staking_required: z.enum(["true", "false"]).optional(),
  team: z.enum(["residential", "public"]).optional(),
});

const updateJobSchema = z.object({
  fieldDate: z.string().optional(),
  stakingRequired: z.boolean().optional(),
});

const assignJobSchema = z.object({
  crewId: z.string().min(1),
  fieldDate: z.string().min(1),
});

const bulkAssignSchema = z.object({
  jobIds: z.array(z.string().min(1)).min(1),
  crewId: z.string().min(1),
  fieldDate: z.string().min(1),
});

const statusUpdateSchema = z.object({
  status: z.enum([
    "unassigned",
    "assigned",
    "in_progress",
    "field_complete",
    "drafting",
    "pls_review",
    "complete",
  ]),
  notes: z.string().optional(),
});

const stakingCreateSchema = z.object({
  notes: z.string().optional(),
});

const stakingRespondSchema = z.object({
  status: z.enum(["completed"]),
  notes: z.string().optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

type DeliveryMethod = "pdf_only" | "pdf_usps" | "pdf_fedex";

function buildChecklistItems(method: DeliveryMethod): Array<{
  stepKey: string;
  label: string;
  sortOrder: number;
  isRequired: boolean;
}> {
  const base = [
    { stepKey: "generate_pdf", label: "Generate Survey PDF", sortOrder: 1, isRequired: true },
    { stepKey: "quality_check", label: "Quality Check", sortOrder: 2, isRequired: true },
  ];
  if (method === "pdf_usps") {
    return [
      ...base,
      { stepKey: "print_document", label: "Print Document", sortOrder: 3, isRequired: true },
      { stepKey: "prepare_envelope", label: "Prepare Envelope", sortOrder: 4, isRequired: true },
      { stepKey: "ship_usps", label: "Ship via USPS", sortOrder: 5, isRequired: true },
    ];
  }
  if (method === "pdf_fedex") {
    return [
      ...base,
      { stepKey: "print_document", label: "Print Document", sortOrder: 3, isRequired: true },
      { stepKey: "prepare_package", label: "Prepare Package", sortOrder: 4, isRequired: true },
      { stepKey: "ship_fedex", label: "Ship via FedEx", sortOrder: 5, isRequired: true },
    ];
  }
  return [
    ...base,
    { stepKey: "email_delivery", label: "Send Email to Client", sortOrder: 3, isRequired: true },
  ];
}

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get("/", requireAuth, teamFilterMiddleware, validateQuery(listQuerySchema), async (req, res) => {
  try {
    const q = req.query as unknown as z.infer<typeof listQuerySchema>;
    const teamFilter = getTeamFilter(res);
    const isAdmin = ADMIN_ROLES.has(req.user!.role);

    const where: Prisma.JobWhereInput = {
      deletedAt: null,
      ...(teamFilter.team ? { team: teamFilter.team as "residential" | "public" } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.assigned_crew ? { assignedCrewId: q.assigned_crew } : {}),
      ...(q.date_from || q.date_to
        ? {
            fieldDate: {
              ...(q.date_from ? { gte: new Date(q.date_from) } : {}),
              ...(q.date_to ? { lte: new Date(q.date_to) } : {}),
            },
          }
        : {}),
      ...(q.staking_required !== undefined ? { stakingRequired: q.staking_required === "true" } : {}),
    };

    const [total, jobs] = await Promise.all([
      prisma.job.count({ where }),
      prisma.job.findMany({
        where,
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        orderBy: { createdAt: "desc" },
        include: {
          assignedCrew: { select: { id: true, name: true } },
          order: {
            select: {
              orderNumber: true,
              dropDeadDate: true,
              dueDate: true,
              propertyAddressLine1: true,
              propertyCity: true,
              propertyState: true,
              quote: { select: { quoteNumber: true } },
            },
          },
        },
      }),
    ]);

    const data = jobs.map((job) => ({
      ...job,
      order: job.order
        ? { ...job.order, dropDeadDate: isAdmin ? job.order.dropDeadDate : null }
        : null,
    }));

    sendPaginated(res, data, q.page, q.limit, total);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const isAdmin = ADMIN_ROLES.has(req.user!.role);

    const job = await prisma.job.findFirst({
      where: { id: req.params["id"]!, deletedAt: null },
      include: {
        order: {
          include: {
            client: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
            quote: { select: { id: true, quoteNumber: true, status: true } },
          },
        },
        assignedCrew: true,
        stakingRequests: {
          orderBy: { requestedAt: "desc" },
          include: {
            requestedByUser: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    if (!job) throw new NotFoundError("Job not found");

    const response = {
      ...job,
      order: job.order
        ? { ...job.order, dropDeadDate: isAdmin ? job.order.dropDeadDate : null }
        : null,
    };

    sendSuccess(res, response);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

router.put("/:id", requireAuth, validateBody(updateJobSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof updateJobSchema>;

    const job = await prisma.job.findFirst({ where: { id: req.params["id"]!, deletedAt: null } });
    if (!job) throw new NotFoundError("Job not found");

    const oldFieldDate = job.fieldDate;
    const data: Prisma.JobUncheckedUpdateInput = { updatedBy: req.user!.userId };
    if (body.fieldDate !== undefined) data.fieldDate = new Date(body.fieldDate);
    if (body.stakingRequired !== undefined) data.stakingRequired = body.stakingRequired;

    const updated = await prisma.job.update({ where: { id: req.params["id"]! }, data });
    logger.info("Job updated", { jobId: updated.id, jobNumber: updated.jobNumber });

    // US4: Field date change notification to assigned crew
    if (
      body.fieldDate !== undefined &&
      job.assignedCrewId != null &&
      oldFieldDate != null
    ) {
      const newFieldDate = new Date(body.fieldDate);
      const dateActuallyChanged = oldFieldDate.getTime() !== newFieldDate.getTime();

      if (dateActuallyChanged) {
        const io = req.app.get("io") as SocketServer | undefined;
        (async () => {
          try {
            const notifData = await loadJobNotificationData(job.id);
            if (!notifData) return;
            const crew = await loadCrewWithMembers(job.assignedCrewId!);
            if (!crew) return;
            await notifyCrewFieldDateChanged(
              notifData.job,
              crew,
              oldFieldDate,
              newFieldDate,
              notifData.client,
              io,
            );
          } catch (err) {
            logger.error("Field date change notification failed", {
              error: err instanceof Error ? err.message : String(err),
              jobId: job.id,
            });
          }
        })();
      }
    }

    sendSuccess(res, updated);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── PUT /:id/assign ──────────────────────────────────────────────────────────

router.put(
  "/:id/assign",
  requireAuth,
  requireRole("crew_manager"),
  validateBody(assignJobSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof assignJobSchema>;

      const job = await prisma.job.findFirst({ where: { id: req.params["id"]!, deletedAt: null } });
      if (!job) throw new NotFoundError("Job not found");

      if (!canTransition("job", job.status, JobStatus.assigned)) {
        throw new ValidationError(`Cannot transition job from '${job.status}' to 'assigned'`);
      }

      const crew = await prisma.crew.findFirst({ where: { id: body.crewId, isActive: true } });
      if (!crew) throw new NotFoundError("Crew not found");

      // Same-crew guard: skip all notifications if crew unchanged (FR-009)
      const isSameCrew = job.assignedCrewId === body.crewId;
      const isReassignment = job.assignedCrewId != null && job.assignedCrewId !== body.crewId;

      // Load old crew members BEFORE the update for reassignment notifications
      let oldCrewMembers: Array<{ id: string; email: string }> = [];
      if (isReassignment) {
        const oldCrew = await loadCrewWithMembers(job.assignedCrewId!);
        oldCrewMembers = oldCrew?.members ?? [];
      }

      const updated = await prisma.job.update({
        where: { id: req.params["id"]! },
        data: {
          assignedCrewId: body.crewId,
          fieldDate: new Date(body.fieldDate),
          status: JobStatus.assigned,
          updatedBy: req.user!.userId,
        },
        include: { assignedCrew: { select: { id: true, name: true } } },
      });

      const io = req.app.get("io") as SocketServer | undefined;
      io?.to(`user:${body.crewId}`).emit("job:assigned", {
        jobId: job.id,
        jobNumber: job.jobNumber,
        fieldDate: body.fieldDate,
      });

      await createSystemEvent(
        job.id,
        job.status,
        JobStatus.assigned,
        req.user!.userId,
        io,
      );

      // Fire-and-forget crew notifications (US1, US2, US3)
      if (!isSameCrew) {
        (async () => {
          try {
            const notifData = await loadJobNotificationData(job.id);
            if (!notifData) return;
            const jobForNotif = { ...notifData.job, fieldDate: new Date(body.fieldDate) };

            // US2: Notify old crew on reassignment
            if (isReassignment && oldCrewMembers.length > 0) {
              await notifyCrewJobReassigned(jobForNotif, oldCrewMembers, io);
            }

            // US1/US3: Notify new crew of assignment
            const newCrew = await loadCrewWithMembers(body.crewId);
            if (newCrew) {
              await notifyCrewJobAssigned(jobForNotif, newCrew, notifData.client, io);
            }
          } catch (err) {
            logger.error("Crew assignment notification failed", {
              error: err instanceof Error ? err.message : String(err),
              jobId: job.id,
            });
          }
        })();
      }

      logger.info("Job assigned", { jobId: job.id, crewId: body.crewId });
      sendSuccess(res, updated);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── POST /bulk-assign ────────────────────────────────────────────────────────

router.post(
  "/bulk-assign",
  requireAuth,
  requireRole("crew_manager"),
  validateBody(bulkAssignSchema),
  async (req, res) => {
    try {
      const body = req.body as z.infer<typeof bulkAssignSchema>;

      const crew = await prisma.crew.findFirst({ where: { id: body.crewId, isActive: true } });
      if (!crew) throw new NotFoundError("Crew not found");

      const result = await prisma.job.updateMany({
        where: { id: { in: body.jobIds }, status: JobStatus.unassigned, deletedAt: null },
        data: {
          assignedCrewId: body.crewId,
          fieldDate: new Date(body.fieldDate),
          status: JobStatus.assigned,
          updatedBy: req.user!.userId,
        },
      });

      // US5: Fire-and-forget notifications for each bulk-assigned job
      const io = req.app.get("io") as SocketServer | undefined;
      (async () => {
        try {
          const assignedJobs = await prisma.job.findMany({
            where: {
              id: { in: body.jobIds },
              assignedCrewId: body.crewId,
              deletedAt: null,
            },
            select: { id: true },
          });

          const crewWithMembers = await loadCrewWithMembers(body.crewId);
          if (!crewWithMembers || crewWithMembers.members.length === 0) return;

          for (const assignedJob of assignedJobs) {
            try {
              const notifData = await loadJobNotificationData(assignedJob.id);
              if (!notifData) continue;
              const jobForNotif = { ...notifData.job, fieldDate: new Date(body.fieldDate) };
              await notifyCrewJobAssigned(jobForNotif, crewWithMembers, notifData.client, io);
            } catch (err) {
              logger.error("Bulk assign notification failed for job", {
                error: err instanceof Error ? err.message : String(err),
                jobId: assignedJob.id,
              });
            }
          }
        } catch (err) {
          logger.error("Bulk assign notification dispatch failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      logger.info("Jobs bulk-assigned", { crewId: body.crewId, count: result.count });
      sendSuccess(res, { updated: result.count });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ─── PUT /:id/status ──────────────────────────────────────────────────────────

router.put("/:id/status", requireAuth, validateBody(statusUpdateSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof statusUpdateSchema>;

    const job = await prisma.job.findFirst({
      where: { id: req.params["id"]!, deletedAt: null },
      include: {
        order: { select: { deliveryPreference: true } },
      },
    });
    if (!job) throw new NotFoundError("Job not found");

    if (!canTransition("job", job.status, body.status)) {
      throw new ValidationError(`Cannot transition from '${job.status}' to '${body.status}'`);
    }

    const updatedJob = await withTransaction(async (tx) => {
      const updated = await tx.job.update({
        where: { id: req.params["id"]! },
        data: { status: body.status, updatedBy: req.user!.userId },
      });

      await tx.entityAuditLog.create({
        data: {
          entityType: "job",
          entityId: job.id,
          entityNumber: job.jobNumber,
          action: "updated",
          userId: req.user!.userId,
          userName: req.user!.email,
          changedAt: new Date(),
          changes: { from: job.status, to: body.status },
          changeSummary: `Status changed from '${job.status}' to '${body.status}'`,
          source: "web_portal",
        },
      });

      if (body.status === JobStatus.complete) {
        const deliveryMethod: DeliveryMethod =
          (job.order?.deliveryPreference as DeliveryMethod | null | undefined) ?? "pdf_only";

        await tx.deliveryChecklist.create({
          data: {
            orderId: job.orderId,
            jobId: job.id,
            deliveryMethod,
            status: DeliveryChecklistStatus.not_started,
            items: { create: buildChecklistItems(deliveryMethod) },
          },
        });

        await tx.deliveryTracking.create({
          data: {
            orderId: job.orderId,
            jobId: job.id,
            deliveryMethod,
            status: DeliveryTrackingStatus.preparing,
          },
        });
      }

      return updated;
    });

    const io = req.app.get("io") as SocketServer | undefined;
    await createSystemEvent(job.id, job.status, body.status, req.user!.userId, io);

    sendSuccess(res, updatedJob);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /:id/traceability ────────────────────────────────────────────────────

router.get("/:id/traceability", requireAuth, async (req, res) => {
  try {
    const job = await prisma.job.findFirst({
      where: { id: req.params["id"]!, deletedAt: null },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            createdAt: true,
            quote: { select: { id: true, quoteNumber: true, status: true, createdAt: true } },
          },
        },
      },
    });

    if (!job) throw new NotFoundError("Job not found");

    sendSuccess(res, {
      job: { id: job.id, jobNumber: job.jobNumber, status: job.status, createdAt: job.createdAt },
      order: job.order ?? null,
      quote: job.order?.quote ?? null,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /:id/staking ────────────────────────────────────────────────────────

router.post("/:id/staking", requireAuth, validateBody(stakingCreateSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof stakingCreateSchema>;

    const job = await prisma.job.findFirst({ where: { id: req.params["id"]!, deletedAt: null } });
    if (!job) throw new NotFoundError("Job not found");

    const timeoutAt = new Date(Date.now() + 20 * 60 * 1000);

    const request = await prisma.stakingRequest.create({
      data: {
        jobId: job.id,
        requestedBy: req.user!.userId,
        status: StakingRequestStatus.pending,
        requestedAt: new Date(),
        timeoutAt,
        notes: body.notes,
      },
    });

    logger.info("Staking request created", { jobId: job.id, requestId: request.id });
    sendSuccess(res, request, 201);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET /:id/staking ─────────────────────────────────────────────────────────

router.get("/:id/staking", requireAuth, async (req, res) => {
  try {
    const job = await prisma.job.findFirst({ where: { id: req.params["id"]!, deletedAt: null } });
    if (!job) throw new NotFoundError("Job not found");

    const requests = await prisma.stakingRequest.findMany({
      where: { jobId: job.id },
      orderBy: { requestedAt: "desc" },
      include: {
        requestedByUser: { select: { id: true, name: true, email: true } },
        respondedByUser: { select: { id: true, name: true, email: true } },
      },
    });

    sendSuccess(res, requests);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── PUT /:id/staking/:requestId ─────────────────────────────────────────────

router.put("/:id/staking/:requestId", requireAuth, validateBody(stakingRespondSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof stakingRespondSchema>;

    const request = await prisma.stakingRequest.findFirst({
      where: { id: req.params["requestId"]!, jobId: req.params["id"]! },
    });
    if (!request) throw new NotFoundError("Staking request not found");

    const updated = await prisma.stakingRequest.update({
      where: { id: req.params["requestId"]! },
      data: {
        status: body.status,
        respondedAt: new Date(),
        respondedBy: req.user!.userId,
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      },
    });

    logger.info("Staking request responded", { requestId: updated.id, status: body.status });
    sendSuccess(res, updated);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── File Management Endpoints ─────────────────────────────────────────────

const uploadUrlSchema = z.object({
  filename: z.string().min(1).max(500),
  mimeType: z.string().min(1),
  fileSize: z.number().int().positive().max(100 * 1024 * 1024), // 100MB max
  fileCategory: z.nativeEnum(FileCategory).optional(),
});

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/tiff",
  "application/pdf",
  "application/zip",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
  "text/plain",
  "application/dxf",
  "application/dwg",
]);

// POST /:id/files/upload-url — generate presigned S3 PUT URL
router.post("/:id/files/upload-url", requireAuth, async (req, res) => {
  try {
    const job = await prisma.job.findUnique({ where: { id: req.params["id"]! }, select: { id: true } });
    if (!job) { sendError(res, new NotFoundError("Job")); return; }

    const body = uploadUrlSchema.parse(req.body);

    if (!ALLOWED_MIME_TYPES.has(body.mimeType)) {
      sendError(res, new ValidationError(`File type '${body.mimeType}' is not allowed`));
      return;
    }

    const s3Key = generateS3Key(`jobs/${job.id}/files`, job.id, body.filename);
    const uploadUrl = await getUploadPresignedUrl(s3Key, body.mimeType);

    const docMeta = await prisma.documentMetadata.create({
      data: {
        jobId: job.id,
        documentType: body.fileCategory ?? "other",
        filename: body.filename,
        s3Key,
        fileSize: BigInt(body.fileSize),
        mimeType: body.mimeType,
        fileCategory: body.fileCategory,
        uploadedBy: req.user!.userId,
        uploadedAt: new Date(),
      },
    });

    logger.info("Job file upload URL generated", { jobId: job.id, documentId: docMeta.id, filename: body.filename });
    sendSuccess(res, { uploadUrl, documentId: docMeta.id }, 201);
  } catch (err) {
    if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
    else sendError(res, err);
  }
});

// POST /:id/files/:documentId/confirm — confirm upload complete
router.post("/:id/files/:documentId/confirm", requireAuth, async (req, res) => {
  try {
    const docMeta = await prisma.documentMetadata.findFirst({
      where: { id: req.params["documentId"]!, jobId: req.params["id"]! },
    });
    if (!docMeta) { sendError(res, new NotFoundError("Document")); return; }

    const updated = await prisma.documentMetadata.findUnique({
      where: { id: docMeta.id },
      include: { uploadedByUser: { select: { id: true, name: true } } },
    });

    sendSuccess(res, updated);
  } catch (err) {
    sendError(res, err);
  }
});

// GET /:id/files — list files for a job
router.get("/:id/files", requireAuth, async (req, res) => {
  try {
    const job = await prisma.job.findUnique({ where: { id: req.params["id"]! }, select: { id: true } });
    if (!job) { sendError(res, new NotFoundError("Job")); return; }

    const files = await prisma.documentMetadata.findMany({
      where: { jobId: job.id },
      include: { uploadedByUser: { select: { id: true, name: true } } },
      orderBy: { uploadedAt: "desc" },
    });

    const filesWithUrls = await Promise.all(
      files.map(async (f) => ({
        ...f,
        fileSize: f.fileSize.toString(),
        downloadUrl: await getDownloadPresignedUrl(f.s3Key, f.filename),
      }))
    );

    sendSuccess(res, filesWithUrls);
  } catch (err) {
    sendError(res, err);
  }
});

// POST /:id/files/download — bulk download as zip
router.post("/:id/files/download", requireAuth, async (req, res) => {
  try {
    const { fileIds } = z.object({ fileIds: z.array(z.string().uuid()).min(1).max(50) }).parse(req.body);
    const job = await prisma.job.findUnique({ where: { id: req.params["id"]! }, select: { id: true, jobNumber: true } });
    if (!job) { sendError(res, new NotFoundError("Job")); return; }

    const files = await prisma.documentMetadata.findMany({
      where: { id: { in: fileIds }, jobId: job.id },
    });

    if (files.length === 0) { sendError(res, new NotFoundError("No files found")); return; }

    const s3 = new S3Client({ region: envStore.AWS_REGION });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${job.jobNumber}-files.zip"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(res);

    for (const file of files) {
      const obj = await s3.send(new GetObjectCommand({ Bucket: envStore.AWS_S3_BUCKET, Key: file.s3Key }));
      if (obj.Body) {
        // S3 SDK v3 returns a web ReadableStream; archiver needs a Node.js Readable
        const { Readable } = await import("stream");
        const nodeStream = Readable.from(obj.Body as AsyncIterable<Uint8Array>);
        archive.append(nodeStream, { name: file.filename });
      }
    }

    await archive.finalize();
  } catch (err) {
    if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
    else sendError(res, err);
  }
});

// ─── POST /:id/transition ─────────────────────────────────────────────────────
// Role-based transition permissions per pipeline stage
const TRANSITION_ROLES: Partial<Record<JobStatus, string[]>> = {
  [JobStatus.in_progress]: ["field_crew", "crew_manager", "office_manager"],
  [JobStatus.field_complete]: ["field_crew", "crew_manager", "office_manager"],
  [JobStatus.ready_for_drafting]: ["office_manager", "crew_manager"],
  [JobStatus.drafting]: ["drafter", "pls_assistant", "office_manager"],
  [JobStatus.drafted]: ["drafter", "pls_assistant", "office_manager"],
  [JobStatus.pls_review]: ["office_manager"],
  [JobStatus.ready_for_delivery]: ["pls_reviewer", "office_manager"],
  [JobStatus.awaiting_corrections]: ["pls_reviewer", "office_manager"],
  [JobStatus.complete]: ["office_manager"],
};

const transitionSchema = z.object({
  toStatus: z.nativeEnum(JobStatus),
  notes: z.string().max(2000).optional(),
});

// Determine who to notify based on the new status
async function notifyForTransition(
  jobId: string,
  jobNumber: string,
  toStatus: JobStatus,
  actorId: string
): Promise<void> {
  const statusNotifyRoles: Partial<Record<JobStatus, UserRole[]>> = {
    [JobStatus.ready_for_drafting]: [UserRole.drafter, UserRole.pls_assistant],
    [JobStatus.pls_review]: [UserRole.pls_reviewer],
    [JobStatus.awaiting_corrections]: [UserRole.drafter, UserRole.pls_assistant],
    [JobStatus.ready_for_delivery]: [UserRole.office_manager],
    [JobStatus.complete]: [UserRole.office_manager],
  };

  const rolesToNotify = statusNotifyRoles[toStatus];
  if (!rolesToNotify?.length) return;

  const usersToNotify = await prisma.user.findMany({
    where: { role: { in: rolesToNotify }, isActive: true },
    select: { id: true },
  });

  const notifiableUsers = usersToNotify.filter((u) => u.id !== actorId);
  if (notifiableUsers.length === 0) return;

  const statusLabel = toStatus.replace(/_/g, " ");
  await prisma.notification.createMany({
    data: notifiableUsers.map((u) => ({
      userId: u.id,
      type: "job_status_changed",
      title: `Job ${jobNumber} moved to ${statusLabel}`,
      message: `Job #${jobNumber} is now ${statusLabel} and needs your attention.`,
      entityType: "job",
      entityId: jobId,
    })),
    skipDuplicates: true,
  });
}

router.post("/:id/transition", requireAuth, validateBody(transitionSchema), async (req, res) => {
  const io = req.app.get("io") as SocketServer | undefined;
  try {
    const { toStatus, notes } = req.body as z.infer<typeof transitionSchema>;
    const userId = req.user!.userId;
    const userRole = req.user!.role;

    const job = await prisma.job.findFirst({
      where: { id: req.params["id"]!, deletedAt: null },
      include: {
        order: { select: { deliveryPreference: true } },
        claimedBy: { select: { id: true } },
      },
    });
    if (!job) throw new NotFoundError("Job not found");

    // Validate transition
    if (!canTransition("job", job.status, toStatus)) {
      throw new ValidationError(`Cannot transition job from '${job.status}' to '${toStatus}'`);
    }

    // Role permission check for this specific transition
    const allowedRoles = TRANSITION_ROLES[toStatus];
    if (allowedRoles) {
      const permitted = allowedRoles.some(
        (r) => userRole === r || userRole === "super_admin" || userRole === "admin"
      );
      if (!permitted) {
        throw new ValidationError(`Role '${userRole}' cannot move a job to '${toStatus}'`);
      }
    }

    // Block on open critical flags (except when moving backwards to awaiting_corrections)
    const forwardStatuses: JobStatus[] = [
      JobStatus.ready_for_drafting, JobStatus.drafting, JobStatus.drafted,
      JobStatus.pls_review, JobStatus.ready_for_delivery, JobStatus.complete,
    ];
    if (forwardStatuses.includes(toStatus) && await hasOpenCriticalFlags(job.id)) {
      throw new ValidationError("Cannot advance job with open critical issue flags");
    }

    const updatedJob = await withTransaction(async (tx) => {
      const updated = await tx.job.update({
        where: { id: job.id },
        data: {
          status: toStatus,
          lastStatusChangedAt: new Date(),
          lastStatusChangedById: userId,
          updatedBy: userId,
        },
      });

      // Audit log
      await tx.entityAuditLog.create({
        data: {
          entityType: "job",
          entityId: job.id,
          entityNumber: job.jobNumber,
          action: "updated",
          userId,
          userName: req.user!.email,
          changedAt: new Date(),
          changes: { from: job.status, to: toStatus, ...(notes ? { notes } : {}) },
          changeSummary: `Status transitioned from '${job.status}' to '${toStatus}'`,
          source: "web_portal",
        },
      });

      // Delivery workflow on complete
      if (toStatus === JobStatus.complete) {
        const deliveryMethod: DeliveryMethod =
          (job.order?.deliveryPreference as DeliveryMethod | null | undefined) ?? "pdf_only";
        await tx.deliveryChecklist.create({
          data: {
            orderId: job.orderId,
            jobId: job.id,
            deliveryMethod,
            status: DeliveryChecklistStatus.not_started,
            items: { create: buildChecklistItems(deliveryMethod) },
          },
        });
        await tx.deliveryTracking.create({
          data: {
            orderId: job.orderId,
            jobId: job.id,
            deliveryMethod,
            status: DeliveryTrackingStatus.preparing,
          },
        });
      }

      return updated;
    });

    await createSystemEvent(job.id, job.status, toStatus, userId, io);

    // Notify relevant users (outside transaction for performance)
    await notifyForTransition(job.id, job.jobNumber, toStatus, userId).catch((e) =>
      logger.warn("Transition notification failed", { error: e })
    );

    // Emit real-time pipeline board update
    io?.to(ROOM_PREFIXES.PIPELINE_BOARD).emit("pipeline:job-moved", {
      jobId: job.id,
      fromStatus: job.status,
      toStatus,
      jobCard: {
        id: updatedJob.id,
        jobNumber: updatedJob.jobNumber,
        status: updatedJob.status,
        internalDueDate: updatedJob.internalDueDate,
        daysUntilDue: updatedJob.internalDueDate
          ? Math.ceil((updatedJob.internalDueDate.getTime() - Date.now()) / 86400000)
          : null,
        daysInCurrentStatus: 0,
        claimedBy: null,
        hasOpenCriticalFlags: false,
        isAlta: updatedJob.isAlta,
        complexityTag: updatedJob.complexityTag,
        plsReviewRoundTrips: updatedJob.plsReviewRoundTrips,
      },
    });

    // Also emit to the job-specific room and active-jobs dashboard
    io?.to(ROOM_PREFIXES.JOB(job.id)).emit("job:status-changed", { jobId: job.id, status: toStatus });
    io?.to(ROOM_PREFIXES.DASHBOARD_ACTIVE_JOBS).emit("job:status-changed", { jobId: job.id });

    logger.info("Job transitioned", { jobId: job.id, from: job.status, to: toStatus, userId });
    sendSuccess(res, updatedJob);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /:id/tag ────────────────────────────────────────────────────────────
router.post(
  "/:id/tag",
  requireAuth,
  requireRole("office_manager", "pls_assistant"),
  async (req, res) => {
    try {
      const { complexityTag } = z.object({ complexityTag: z.enum(["complex", "standard"]) }).parse(req.body);
      const job = await prisma.job.findFirst({ where: { id: req.params["id"]!, deletedAt: null } });
      if (!job) throw new NotFoundError("Job not found");
      const updated = await prisma.job.update({
        where: { id: req.params["id"]! },
        data: { complexityTag, updatedBy: req.user!.userId },
      });
      logger.info("Job complexity tagged", { jobId: updated.id, complexityTag });
      sendSuccess(res, updated);
    } catch (err) {
      if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
      else sendError(res, err);
    }
  }
);

// PATCH /files/:id/move — move document to different job (T028)
router.patch("/files/:docId/move", requireAuth, requireRole("office_manager", "pls_assistant"), async (req, res) => {
  try {
    const { jobId: targetJobId } = z.object({ jobId: z.string().uuid() }).parse(req.body);
    const targetJob = await prisma.job.findUnique({ where: { id: targetJobId }, select: { id: true } });
    if (!targetJob) { sendError(res, new NotFoundError("Target job")); return; }

    const docMeta = await prisma.documentMetadata.findUnique({ where: { id: req.params["docId"]! } });
    if (!docMeta) { sendError(res, new NotFoundError("Document")); return; }

    const updated = await prisma.documentMetadata.update({
      where: { id: docMeta.id },
      data: { jobId: targetJobId },
    });

    logger.info("Document moved between jobs", { docId: docMeta.id, from: docMeta.jobId, to: targetJobId });
    sendSuccess(res, updated);
  } catch (err) {
    if (err instanceof z.ZodError) sendError(res, new ValidationError(err.errors[0]?.message ?? "Validation error"));
    else sendError(res, err);
  }
});

// ─── GET /:id/payments ────────────────────────────────────────────────────────

router.get("/:id/payments", requireAuth, async (req, res) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id! },
      select: {
        id: true,
        jobNumber: true,
        orderId: true,
        order: {
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
        },
      },
    });

    if (!job) throw new NotFoundError("Job not found");

    const order = job.order;
    const { canCollectPayment } = await import("../services/payment-gate.service");
    const eligibility = await canCollectPayment(order.id);

    const price = Number(order.price ?? 0);
    const balanceRemaining = Number(order.balanceRemaining);

    sendSuccess(res, {
      jobId: job.id,
      jobNumber: job.jobNumber,
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
