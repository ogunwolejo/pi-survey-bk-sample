import { ChatEntityType } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { jobLogger as logger } from "../lib/logger";
import {
  getMessages,
  postMessage as chatPostMessage,
  createSystemEvent as createChatSystemEvent,
} from "./chat.service";

export interface UnifiedActivityEntry {
  id: string;
  jobId: string;
  userId: string | null;
  eventType: string;
  content: string;
  metadata: unknown;
  createdAt: string;
  user: { id: string; name: string; image?: string | null; role?: string } | null;
  source: "chat" | "activity";
}

export async function getActivityFeed(
  jobId: string,
  _page: number,
  limit: number,
): Promise<{ data: unknown[]; total: number }> {
  const result = await getMessages(ChatEntityType.job, jobId, limit);
  return { data: result.data, total: result.meta.total };
}

export async function postActivityMessage(
  jobId: string,
  userId: string,
  content: string,
  mentionUserIds: string[],
  io: SocketServer | undefined,
): Promise<unknown> {
  logger.info("Posting job activity message via chat service", { jobId, userId, mentionCount: mentionUserIds.length });
  return chatPostMessage(ChatEntityType.job, jobId, userId, content, mentionUserIds, io);
}

export async function createSystemEvent(
  jobId: string,
  eventType: string,
  content: string,
  metadata: Record<string, unknown> | undefined,
  userId: string | undefined,
  io: SocketServer | undefined,
): Promise<void> {
  await createChatSystemEvent({
    entityType: ChatEntityType.job,
    entityId: jobId,
    eventType,
    content,
    metadata,
    userId,
    io,
  });
}
