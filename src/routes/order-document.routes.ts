import { Router } from "express";
import { z } from "zod";
import type { Server as SocketServer } from "socket.io";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { teamFilterMiddleware } from "../middleware/team-filter.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { sendSuccess, sendNoContent, sendError } from "../lib/response";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { fileLogger as logger } from "../lib/logger";
import * as docService from "../services/order-document.service";

const WRITE_ROLES = ["pls_reviewer", "super_admin", "admin", "office_manager"] as const;

const uploadUrlSchema = z.object({
  filename: z.string().min(1).max(255),
  displayName: z.string().max(255).optional(),
  contentType: z.string().min(1),
  fileSize: z.number().int().positive().max(26_214_400),
  researchDocType: z.enum([
    "plat_of_subdivision",
    "sidwell_map",
    "title_commitment",
    "recorded_deed",
    "legal_description",
    "certificate_of_correction",
    "order_form",
    "other",
  ]),
});

const updateDocTypeSchema = z.object({
  researchDocType: z.enum([
    "plat_of_subdivision",
    "sidwell_map",
    "title_commitment",
    "recorded_deed",
    "legal_description",
    "certificate_of_correction",
    "order_form",
    "other",
  ]),
});

const confirmUploadSchema = z.object({
  s3Key: z.string().min(1),
  filename: z.string().min(1).max(255),
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
  ]),
});

export function createOrderDocumentRouter(io: SocketServer): Router {
  const router = Router({ mergeParams: true });

  // POST /:id/documents/upload-url
  router.post(
    "/:id/documents/upload-url",
    requireAuth,
    requireRole(...WRITE_ROLES),
    validateBody(uploadUrlSchema),
    async (req, res) => {
      try {
        const body = req.body as z.infer<typeof uploadUrlSchema>;
        const result = await docService.generateUploadUrl(
          req.params["id"]!,
          body.filename,
          body.contentType,
          body.fileSize,
          body.researchDocType,
        );
        sendSuccess(res, result, 201);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // POST /:id/documents
  router.post(
    "/:id/documents",
    requireAuth,
    requireRole(...WRITE_ROLES),
    validateBody(confirmUploadSchema),
    async (req, res) => {
      try {
        const body = req.body as z.infer<typeof confirmUploadSchema>;
        const result = await docService.confirmUpload(
          req.params["id"]!,
          body.s3Key,
          body.filename,
          body.contentType,
          body.fileSize,
          body.researchDocType,
          req.user!.userId,
          body.displayName,
        );

        logger.info("Document uploaded", { orderId: req.params["id"]!, s3Key: body.s3Key, docType: body.researchDocType });
        io.to(ROOM_PREFIXES.ORDER(req.params["id"]!)).emit("order:document:new", result);
        sendSuccess(res, result, 201);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // GET /:id/documents
  router.get(
    "/:id/documents",
    requireAuth,
    teamFilterMiddleware,
    async (req, res) => {
      try {
        const [documents, completeness] = await Promise.all([
          docService.listDocuments(req.params["id"]!),
          docService.computeCompleteness(req.params["id"]!),
        ]);
        sendSuccess(res, { documents, completeness });
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // GET /:id/documents/:docId/download-url
  router.get(
    "/:id/documents/:docId/download-url",
    requireAuth,
    teamFilterMiddleware,
    async (req, res) => {
      try {
        const result = await docService.getDownloadUrl(req.params["docId"]!);
        sendSuccess(res, result);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // GET /:id/documents/:docId/preview-url
  router.get(
    "/:id/documents/:docId/preview-url",
    requireAuth,
    teamFilterMiddleware,
    async (req, res) => {
      try {
        const result = await docService.getPreviewUrl(req.params["docId"]!);
        sendSuccess(res, result);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // PATCH /:id/documents/:docId/type
  router.patch(
    "/:id/documents/:docId/type",
    requireAuth,
    requireRole(...WRITE_ROLES),
    validateBody(updateDocTypeSchema),
    async (req, res) => {
      try {
        const body = req.body as z.infer<typeof updateDocTypeSchema>;
        const result = await docService.updateDocType(
          req.params["docId"]!,
          body.researchDocType,
        );

        io.to(ROOM_PREFIXES.ORDER(req.params["id"]!)).emit("order:document:updated", result);
        sendSuccess(res, result);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // DELETE /:id/documents/:docId
  router.delete(
    "/:id/documents/:docId",
    requireAuth,
    requireRole(...WRITE_ROLES),
    async (req, res) => {
      try {
        const { orderId } = await docService.deleteDocument(
          req.params["docId"]!,
          req.user!.userId,
          req.user!.email,
        );

        logger.info("Document deleted", { orderId, docId: req.params["docId"]! });
        io.to(ROOM_PREFIXES.ORDER(orderId!)).emit("order:document:deleted", {
          docId: req.params["docId"]!,
        });
        sendNoContent(res);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  return router;
}
