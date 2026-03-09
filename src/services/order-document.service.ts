import type { ResearchDocumentType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateS3Key, getUploadPresignedUrl, getDownloadPresignedUrl } from "../lib/s3";
import { ValidationError, NotFoundError } from "../lib/errors";
import { orderLogger as logger } from "../lib/logger";

const MAX_FILE_SIZE = 26_214_400; // 25 MB

const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const REQUIRED_RESEARCH_DOC_TYPES: ResearchDocumentType[] = [
  "plat_of_subdivision",
  "sidwell_map",
  "title_commitment",
  "recorded_deed",
  "legal_description",
  "certificate_of_correction",
  "order_form",
];

export interface UploadUrlResult {
  uploadUrl: string;
  s3Key: string;
  expiresIn: number;
}

export async function generateUploadUrl(
  orderId: string,
  filename: string,
  contentType: string,
  fileSize: number,
  researchDocType: string,
): Promise<UploadUrlResult> {
  logger.info("[OrderDocument] Generating upload URL", { orderId, filename, contentType, fileSize, researchDocType });
  if (fileSize > MAX_FILE_SIZE) {
    throw new ValidationError(`File size exceeds maximum of 25 MB (got ${Math.round(fileSize / 1_048_576)} MB)`);
  }

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new ValidationError(`Content type '${contentType}' is not allowed. Accepted: PDF, JPEG, PNG, TIFF, WebP, DOC, DOCX`);
  }

  const s3Key = generateS3Key("orders", orderId, filename);
  const expiresIn = 3600;
  const uploadUrl = await getUploadPresignedUrl(s3Key, contentType, expiresIn);

  return { uploadUrl, s3Key, expiresIn };
}

export async function confirmUpload(
  orderId: string,
  s3Key: string,
  filename: string,
  contentType: string,
  fileSize: number,
  researchDocType: string,
  userId: string,
  displayName?: string,
) {
  const doc = await prisma.documentMetadata.create({
    data: {
      orderId,
      documentType: "research",
      filename,
      displayName: displayName || null,
      s3Key,
      fileSize: BigInt(fileSize),
      mimeType: contentType,
      researchDocType: researchDocType as ResearchDocumentType,
      uploadedBy: userId,
      uploadedAt: new Date(),
    },
    include: {
      uploadedByUser: { select: { id: true, name: true } },
    },
  });

  logger.info("[OrderDocument] Upload confirmed", {
    docId: doc.id,
    orderId,
    filename,
    researchDocType,
  });

  return {
    id: doc.id,
    orderId: doc.orderId,
    filename: doc.filename,
    displayName: doc.displayName,
    researchDocType: doc.researchDocType,
    fileSize: Number(doc.fileSize),
    mimeType: doc.mimeType,
    s3Key: doc.s3Key,
    uploadedBy: doc.uploadedBy,
    uploadedAt: doc.uploadedAt,
    uploadedByUser: doc.uploadedByUser,
  };
}

export async function listDocuments(orderId: string) {
  const docs = await prisma.documentMetadata.findMany({
    where: { orderId, documentType: "research" },
    include: {
      uploadedByUser: { select: { id: true, name: true } },
    },
    orderBy: { uploadedAt: "desc" },
  });

  return docs.map((doc) => ({
    id: doc.id,
    filename: doc.filename,
    displayName: doc.displayName,
    researchDocType: doc.researchDocType,
    fileSize: Number(doc.fileSize),
    mimeType: doc.mimeType,
    uploadedBy: doc.uploadedBy,
    uploadedByUser: doc.uploadedByUser,
    uploadedAt: doc.uploadedAt,
  }));
}

export async function getDownloadUrl(docId: string) {
  const doc = await prisma.documentMetadata.findUnique({
    where: { id: docId },
    select: { s3Key: true, filename: true },
  });

  if (!doc) throw new NotFoundError(`Document ${docId} not found`);

  const downloadUrl = await getDownloadPresignedUrl(doc.s3Key, doc.filename);
  return { downloadUrl, filename: doc.filename, expiresIn: 3600 };
}

export async function getPreviewUrl(docId: string) {
  const doc = await prisma.documentMetadata.findUnique({
    where: { id: docId },
    select: { s3Key: true, mimeType: true },
  });

  if (!doc) throw new NotFoundError(`Document ${docId} not found`);

  const previewUrl = await getDownloadPresignedUrl(doc.s3Key, "preview");
  return { previewUrl, mimeType: doc.mimeType, expiresIn: 3600 };
}

export async function updateDocType(docId: string, researchDocType: string) {
  const doc = await prisma.documentMetadata.findUnique({
    where: { id: docId },
    select: { id: true, orderId: true, filename: true },
  });

  if (!doc) throw new NotFoundError(`Document ${docId} not found`);

  const updated = await prisma.documentMetadata.update({
    where: { id: docId },
    data: { researchDocType: researchDocType as ResearchDocumentType },
    include: { uploadedByUser: { select: { id: true, name: true } } },
  });

  logger.info("[OrderDocument] Document type updated", {
    docId,
    orderId: doc.orderId,
    filename: doc.filename,
    researchDocType,
  });

  return {
    id: updated.id,
    orderId: updated.orderId,
    researchDocType: updated.researchDocType,
  };
}

export async function deleteDocument(docId: string, userId: string, userName: string) {
  const doc = await prisma.documentMetadata.findUnique({
    where: { id: docId },
    select: { id: true, orderId: true, filename: true },
  });

  if (!doc) throw new NotFoundError(`Document ${docId} not found`);

  await prisma.documentMetadata.delete({ where: { id: docId } });

  logger.info("[OrderDocument] Document deleted", {
    docId,
    orderId: doc.orderId,
    filename: doc.filename,
    deletedBy: userId,
  });

  return { orderId: doc.orderId };
}

export interface CompletenessResult {
  total: number;
  uploaded: number;
  missing: string[];
}

export async function computeCompleteness(orderId: string): Promise<CompletenessResult> {
  const docs = await prisma.documentMetadata.findMany({
    where: { orderId, documentType: "research" },
    select: { researchDocType: true },
  });

  const uploadedTypes = new Set(
    docs.map((d) => d.researchDocType).filter((t): t is ResearchDocumentType => t !== null && t !== "other"),
  );

  const missing = REQUIRED_RESEARCH_DOC_TYPES.filter((t) => !uploadedTypes.has(t));

  return {
    total: REQUIRED_RESEARCH_DOC_TYPES.length,
    uploaded: REQUIRED_RESEARCH_DOC_TYPES.length - missing.length,
    missing,
  };
}
