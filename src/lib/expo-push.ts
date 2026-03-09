import Expo, { type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { prisma } from "./prisma";
import { generalLogger as logger } from "./logger";

const expo = new Expo();

export interface ExpoPushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export async function sendExpoPushToUser(
  userId: string,
  payload: ExpoPushPayload,
): Promise<void> {
  const tokens = await prisma.expoPushToken.findMany({
    where: { userId },
    select: { id: true, token: true },
  });

  if (tokens.length === 0) {
    logger.debug("[ExpoPush] No tokens for user, skipping", { userId });
    return;
  }

  const messages: ExpoPushMessage[] = tokens
    .filter((t) => Expo.isExpoPushToken(t.token))
    .map((t) => ({
      to: t.token,
      sound: "default" as const,
      title: payload.title,
      body: payload.body,
      data: payload.data,
    }));

  if (messages.length === 0) {
    logger.warn("[ExpoPush] All tokens invalid for user", { userId, tokenCount: tokens.length });
    return;
  }

  const chunks = expo.chunkPushNotifications(messages);

  for (const chunk of chunks) {
    try {
      const tickets: ExpoPushTicket[] = await expo.sendPushNotificationsAsync(chunk);

      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i]!;
        if (ticket.status === "error") {
          const targetToken = chunk[i]?.to as string | undefined;
          logger.warn("[ExpoPush] Ticket error", {
            userId,
            token: targetToken,
            errorMessage: ticket.message,
            errorDetails: ticket.details,
          });

          if (ticket.details?.error === "DeviceNotRegistered" && targetToken) {
            await pruneStaleToken(targetToken);
          }
        }
      }
    } catch (err) {
      logger.error("[ExpoPush] Failed to send chunk", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function pruneStaleToken(token: string): Promise<void> {
  try {
    const deleted = await prisma.expoPushToken.deleteMany({ where: { token } });
    if (deleted.count > 0) {
      logger.info("[ExpoPush] Pruned stale token", { token, count: deleted.count });
    }
  } catch (err) {
    logger.warn("[ExpoPush] Failed to prune stale token", {
      token,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
