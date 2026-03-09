import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { envStore } from "../env-store";

const s3 = new S3Client({ region: envStore.AWS_REGION });

const BUCKET = envStore.AWS_S3_BUCKET;

export function generateS3Key(prefix: string, entityId: string, filename: string): string {
  const sanitized = filename.replace(/[^a-zA-Z0-9.-]/g, "_");
  const uniqueId = randomUUID().slice(0, 8);
  return `${prefix}/${entityId}/${Date.now()}-${uniqueId}-${sanitized}`;
}

export async function getUploadPresignedUrl(
  key: string,
  contentType: string,
  expiresIn = 3600
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3, command, { expiresIn });
}

export async function getDownloadPresignedUrl(
  key: string,
  filename: string,
  expiresIn = 3600
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  });
  return getSignedUrl(s3, command, { expiresIn });
}
