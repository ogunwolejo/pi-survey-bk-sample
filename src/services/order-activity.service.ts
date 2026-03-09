import { ChatEntityType } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { orderLogger as logger } from "../lib/logger";
import {
  getMessages,
  postMessage as chatPostMessage,
  createSystemEvent as createChatSystemEvent,
} from "./chat.service";

export interface ActivityEntryResult {
  id: string;
  orderId: string;
  userId: string | null;
  eventType: string;
  content: string;
  metadata: unknown;
  createdAt: Date;
  user: { id: string; name: string; image: string | null } | null;
}

export async function getActivityFeed(
  orderId: string,
  _page: number,
  limit: number,
): Promise<{ data: unknown[]; total: number }> {
  const result = await getMessages(ChatEntityType.order, orderId, limit);
  return { data: result.data, total: result.meta.total };
}

export async function postMessage(
  orderId: string,
  userId: string,
  content: string,
  mentionUserIds: string[],
  io: SocketServer | undefined,
): Promise<unknown> {
  logger.info("Posting activity message via chat service", { orderId, userId, mentionCount: mentionUserIds.length });
  return chatPostMessage(ChatEntityType.order, orderId, userId, content, mentionUserIds, io);
}

export async function createSystemEvent(
  orderId: string,
  eventType: string,
  content: string,
  metadata: Record<string, unknown> | undefined,
  userId: string | undefined,
  io: SocketServer | undefined,
): Promise<void> {
  await createChatSystemEvent({
    entityType: ChatEntityType.order,
    entityId: orderId,
    eventType,
    content,
    metadata,
    userId,
    io,
  });
}
