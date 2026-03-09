import webpush from "web-push";
import { envStore } from "../env-store";
import { generalLogger as logger } from "./logger";
import { prisma } from "./prisma";

let vapidConfigured = false;

const { VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = envStore;

if (VAPID_SUBJECT && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
} else {
  logger.warn("[WebPush] VAPID keys not fully configured — push notifications disabled");
}

export async function sendPushToUser(userId: string, payload: object): Promise<void> {
  if (!vapidConfigured) {
    logger.warn(`[WebPush] VAPID keys not configured, skipping push for user ${userId}`);
    return;
  }

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subscriptions.length === 0) {
    logger.info(`[WebPush] No subscriptions for user ${userId}, skipping`);
    return;
  }

  let sent = 0;
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      );
      sent++;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 410) {
        logger.info(`[WebPush] Subscription expired (410) for user ${userId}, deleting endpoint ${sub.endpoint}`);
        await prisma.pushSubscription.delete({ where: { id: sub.id } });
      } else {
        logger.error(`[WebPush] Failed to send notification to user ${userId}`, {
          error: err instanceof Error ? err.message : String(err),
          endpoint: sub.endpoint,
        });
      }
    }
  }

  logger.info(`[WebPush] Push complete for user ${userId} (${sent}/${subscriptions.length} delivered)`);
}
