import { ChatEntityType } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { quoteLogger as logger } from "../lib/logger";
import {
  getMessages,
  postMessage as chatPostMessage,
  createSystemEvent as createChatSystemEvent,
} from "./chat.service";

export interface MentionMetadata {
  userId: string;
  name: string;
  offset: number;
  length: number;
}

export interface ActivityEntryResult {
  id: string;
  quoteId: string;
  userId: string | null;
  eventType: string;
  content: string;
  metadata: unknown;
  createdAt: Date;
  user: { id: string; name: string; image: string | null } | null;
}

export async function getActivityFeed(
  quoteId: string,
  _page: number,
  limit: number,
): Promise<{ data: unknown[]; total: number }> {
  const result = await getMessages(ChatEntityType.quote, quoteId, limit);
  return { data: result.data, total: result.meta.total };
}

export async function postMessage(
  quoteId: string,
  userId: string,
  content: string,
  mentionUserIds: string[],
  io: SocketServer | undefined,
): Promise<unknown> {
  logger.info("Posting quote activity message via chat service", { quoteId, userId, mentionCount: mentionUserIds.length });
  return chatPostMessage(ChatEntityType.quote, quoteId, userId, content, mentionUserIds, io);
}

export async function createSystemEvent(
  quoteId: string,
  eventType: string,
  content: string,
  metadata: Record<string, unknown> | undefined,
  userId: string | undefined,
  io: SocketServer | undefined,
): Promise<void> {
  await createChatSystemEvent({
    entityType: ChatEntityType.quote,
    entityId: quoteId,
    eventType,
    content,
    metadata,
    userId,
    io,
  });
}
