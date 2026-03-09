import { prisma } from "../lib/prisma";
import { generateS3Key, getUploadPresignedUrl, getDownloadPresignedUrl } from "../lib/s3";
import { NotFoundError, ValidationError } from "../lib/errors";
import { fileLogger as logger } from "../lib/logger";

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
const UPLOAD_URL_EXPIRY = 900; // 15 min
const DOWNLOAD_URL_EXPIRY = 3600; // 1 hr

export type EntityType = "job" | "order";

export interface UploadResult {
  id: string;
  presignedUploadUrl: string;
  s3Key: string;
  expiresIn: number;
}

export interface FileService {
  upload(
    entityType: EntityType,
    entityId: string,
    filename: string,
    contentType: string,
    fileSize: number,
    documentType: string,
    uploadedBy?: string
  ): Promise<UploadResult>;

  download(documentId: string): Promise<{ downloadUrl: string; filename: string; documentType: string; expiresIn: number }>;

  listByEntity(
    entityType: EntityType,
    entityId: string,
    page?: number,
    limit?: number
  ): Promise<{ data: unknown[]; total: number }>;

  delete(documentId: string): Promise<void>;
}

export const fileService: FileService = {
  async upload(entityType, entityId, filename, contentType, fileSize, documentType, uploadedBy) {
    logger.info("Initiating file upload", { entityType, entityId, filename, contentType, fileSize, documentType, uploadedBy });
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      logger.warn("File upload rejected — invalid content type", { contentType, filename });
      throw new ValidationError(`Content type '${contentType}' is not allowed`);
    }
    if (fileSize > MAX_FILE_SIZE_BYTES) {
      logger.warn("File upload rejected — file too large", { fileSize, maxSize: MAX_FILE_SIZE_BYTES, filename });
      throw new ValidationError("File size exceeds the 100 MB limit");
    }

    if (entityType === "job") {
      const job = await prisma.job.findFirst({ where: { id: entityId, deletedAt: null } });
      if (!job) throw new NotFoundError("Job not found");
    } else {
      const order = await prisma.order.findFirst({ where: { id: entityId, deletedAt: null } });
      if (!order) throw new NotFoundError("Order not found");
    }

    const s3Key = generateS3Key(entityType, entityId, filename);
    const presignedUploadUrl = await getUploadPresignedUrl(s3Key, contentType, UPLOAD_URL_EXPIRY);

    const document = await prisma.documentMetadata.create({
      data: {
        ...(entityType === "job" ? { jobId: entityId } : {}),
        ...(entityType === "order" ? { orderId: entityId } : {}),
        documentType,
        filename,
        s3Key,
        fileSize: BigInt(fileSize),
        uploadedBy,
        uploadedAt: new Date(),
      },
    });

    logger.info("Document upload initiated", { documentId: document.id, entityType, entityId });

    return {
      id: document.id,
      presignedUploadUrl,
      s3Key,
      expiresIn: UPLOAD_URL_EXPIRY,
    };
  },

  async download(documentId) {
    logger.info("Generating download URL", { documentId });
    const document = await prisma.documentMetadata.findUnique({ where: { id: documentId } });
    if (!document) {
      logger.warn("Document download failed — not found", { documentId });
      throw new NotFoundError("Document not found");
    }

    const downloadUrl = await getDownloadPresignedUrl(document.s3Key, document.filename, DOWNLOAD_URL_EXPIRY);

    return {
      downloadUrl,
      filename: document.filename,
      documentType: document.documentType,
      expiresIn: DOWNLOAD_URL_EXPIRY,
    };
  },

  async listByEntity(entityType, entityId, page = 1, limit = 20) {
    const where =
      entityType === "job" ? { jobId: entityId } : { orderId: entityId };

    const [total, documents] = await Promise.all([
      prisma.documentMetadata.count({ where }),
      prisma.documentMetadata.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { uploadedAt: "desc" },
        include: {
          uploadedByUser: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    const data = documents.map((doc) => ({ ...doc, fileSize: Number(doc.fileSize) }));
    return { data, total };
  },

  async delete(documentId) {
    logger.info("Deleting document", { documentId });
    const document = await prisma.documentMetadata.findUnique({ where: { id: documentId } });
    if (!document) {
      logger.warn("Document delete failed — not found", { documentId });
      throw new NotFoundError("Document not found");
    }
    await prisma.documentMetadata.delete({ where: { id: documentId } });
    logger.info("Document deleted", { documentId });
  },
};
