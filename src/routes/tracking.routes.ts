import { Router, Request, Response } from "express";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { envStore } from "../env-store";
import { prisma } from "../lib/prisma";
import { sendSuccess, sendError } from "../lib/response";
import { NotFoundError } from "../lib/errors";
import { orderLogger as logger } from "../lib/logger";

const router = Router();

const s3 = new S3Client({ region: envStore.AWS_REGION });
const S3_BUCKET = envStore.AWS_S3_BUCKET;

// GET /:trackingToken → public, no auth required
// Returns delivery tracking info with timeline events and document download links
router.get("/:trackingToken", async (req: Request, res: Response) => {
  try {
    const { trackingToken } = req.params;

    const tracking = await prisma.deliveryTracking.findUnique({
      where: { trackingToken },
      include: {
        events: {
          orderBy: { occurredAt: "desc" },
          select: {
            status: true,
            title: true,
            description: true,
            occurredAt: true,
          },
        },
        order: {
          select: {
            id: true,
            documentMetadata: {
              select: {
                id: true,
                documentType: true,
                filename: true,
                s3Key: true,
                versionNumber: true,
                uploadedAt: true,
              },
            },
          },
        },
      },
    });

    if (!tracking) throw new NotFoundError("Tracking record not found");

    logger.info("Tracking record retrieved", { trackingToken, status: tracking.status });

    // Generate pre-signed download links for order documents
    const downloadLinks = await Promise.all(
      tracking.order.documentMetadata.map(async (doc) => {
        const command = new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: doc.s3Key,
          ResponseContentDisposition: `attachment; filename="${doc.filename}"`,
        });
        const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
        return {
          id: doc.id,
          documentType: doc.documentType,
          filename: doc.filename,
          versionNumber: doc.versionNumber,
          uploadedAt: doc.uploadedAt,
          downloadUrl: url,
        };
      })
    );

    sendSuccess(res, {
      status: tracking.status,
      deliveryMethod: tracking.deliveryMethod,
      trackingNumber: tracking.trackingNumber,
      carrier: tracking.carrier,
      carrierUrl: tracking.carrierUrl,
      estimatedDelivery: tracking.estimatedDelivery,
      deliveredAt: tracking.deliveredAt,
      emailSentAt: tracking.emailSentAt,
      timeline_events: tracking.events,
      download_links: downloadLinks,
    });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
