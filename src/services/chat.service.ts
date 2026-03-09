import { prisma } from "../lib/prisma";
import { ChatEntityType, UserRole } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { chatLogger as logger } from "../lib/logger";
import { sendEmail } from "./email.service";
import { chatMentionPLSAssistantHtml } from "./email-templates";

const AUTHOR_SELECT = { id: true, name: true, role: true, image: true } as const;

export interface CreateSystemEventOptions {
  entityType: ChatEntityType;
  entityId: string;
  eventType: string;
  content: string;
  metadata?: Record<string, unknown>;
  userId?: string;
  io?: SocketServer;
}

interface MentionMetadata {
  userId: string;
  name: string;
  offset: number;
  length: number;
}

async function buildMentionMetadata(
  content: string,
  mentionUserIds: string[],
): Promise<MentionMetadata[]> {
  const realIds = mentionUserIds.filter((id) => id !== "everyone");
  if (realIds.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: realIds } },
    select: { id: true, name: true },
  });

  const mentions: MentionMetadata[] = [];
  for (const user of users) {
    const mention = `@${user.name}`;
    const offset = content.indexOf(mention);
    if (offset >= 0) {
      mentions.push({ userId: user.id, name: user.name, offset, length: mention.length });
    }
  }
  return mentions;
}

export async function getMessages(
  entityType: ChatEntityType,
  entityId: string,
  limit: number,
  before?: string,
) {
  const where: Prisma.ChatMessageWhereInput = {
    entityType,
    entityId,
    deletedAt: null,
    ...(before ? { createdAt: { lt: new Date(before) } } : {}),
  };

  const [messages, total] = await Promise.all([
    prisma.chatMessage.findMany({
      where,
      include: { author: { select: AUTHOR_SELECT } },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.chatMessage.count({ where: { entityType, entityId, deletedAt: null } }),
  ]);

  const ordered = messages.reverse();
  const hasMore = messages.length === limit && total > limit;
  const oldestCursor = ordered[0]?.createdAt.toISOString() ?? null;

  return {
    data: ordered,
    meta: { limit, total, hasMore, oldestCursor },
  };
}

export async function postMessage(
  entityType: ChatEntityType,
  entityId: string,
  userId: string,
  content: string,
  mentionUserIds: string[],
  io?: SocketServer,
) {
  const mentions = await buildMentionMetadata(content, mentionUserIds);

  const message = await prisma.chatMessage.create({
    data: {
      entityType,
      entityId,
      authorId: userId,
      content,
      mentionedUserIds: mentionUserIds,
      metadata: mentions.length > 0 ? ({ mentions } as unknown as Prisma.InputJsonValue) : undefined,
    },
    include: { author: { select: AUTHOR_SELECT } },
  });

  const postingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });

  const realMentionIds = mentionUserIds.filter((id) => id !== "everyone");
  if (realMentionIds.length > 0) {
    const mentionedUsers = await prisma.user.findMany({
      where: { id: { in: realMentionIds } },
      select: { id: true, role: true },
    });

    const notifications = mentionedUsers.map((u) => ({
      userId: u.id,
      type: "chat_mention",
      title: `${postingUser?.name ?? "Someone"} mentioned you`,
      message: content.substring(0, 200),
      entityType: entityType as string,
      entityId,
    }));

    if (notifications.length > 0) {
      await prisma.notification.createMany({ data: notifications });
    }

    for (const u of mentionedUsers) {
      io?.to(ROOM_PREFIXES.USER(u.id)).emit("notification:new", {
        userId: u.id,
        type: "chat_mention",
        title: `${postingUser?.name ?? "Someone"} mentioned you`,
        message: content.substring(0, 200),
        entityType: entityType as string,
        entityId,
      });
    }

    if (entityType === ChatEntityType.job) {
      const plsAssistantIds = mentionedUsers
        .filter((u) => u.role === UserRole.pls_assistant)
        .map((u) => u.id);

      if (plsAssistantIds.length > 0) {
        await sendPlsAssistantEmail(entityId, userId, content, plsAssistantIds, postingUser?.name);
      }
    }
  }

  io?.to(ROOM_PREFIXES.ENTITY_CHAT(entityType, entityId)).emit("chat:message:new", message);

  return message;
}

async function sendPlsAssistantEmail(
  jobId: string,
  authorId: string,
  content: string,
  plsAssistantIds: string[],
  authorName?: string | null,
) {
  const [job, plsUsers] = await Promise.all([
    prisma.job.findUnique({
      where: { id: jobId },
      select: {
        jobNumber: true,
        order: { select: { propertyAddressLine1: true, propertyCity: true, propertyState: true } },
      },
    }),
    prisma.user.findMany({
      where: { id: { in: plsAssistantIds } },
      select: { id: true, email: true, name: true },
    }),
  ]);

  const propertyAddress = job
    ? [job.order?.propertyAddressLine1, job.order?.propertyCity, job.order?.propertyState]
        .filter(Boolean).join(", ")
    : "Unknown property";

  const frontendUrl = process.env["FRONTEND_URL"] ?? "http://localhost:3000";

  for (const pls of plsUsers) {
    if (!pls.email) continue;
    const html = chatMentionPLSAssistantHtml({
      mentionedByName: authorName ?? "A team member",
      jobNumber: job?.jobNumber ?? jobId,
      propertyAddress,
      messageExcerpt: content,
      jobUrl: `${frontendUrl}/jobs/${jobId}`,
    });

    sendEmail({
      to: pls.email,
      subject: `You were mentioned in Job #${job?.jobNumber ?? jobId} chat`,
      html,
    }).catch((err: unknown) => logger.error("Failed to send chat mention email", { err, userId: pls.id }));
  }
}

export async function createSystemEvent(options: CreateSystemEventOptions) {
  const { entityType, entityId, eventType, content, metadata, userId, io } = options;

  const entry = await prisma.chatMessage.create({
    data: {
      entityType,
      entityId,
      authorId: userId ?? null,
      content,
      isSystemEvent: true,
      eventType,
      metadata: metadata ? (metadata as Prisma.InputJsonValue) : undefined,
      mentionedUserIds: [],
    },
    include: { author: { select: AUTHOR_SELECT } },
  });

  io?.to(ROOM_PREFIXES.ENTITY_CHAT(entityType, entityId)).emit("chat:message:new", entry);

  return entry;
}

export async function deleteByEntity(entityType: ChatEntityType, entityId: string): Promise<number> {
  const result = await prisma.chatMessage.deleteMany({
    where: { entityType, entityId },
  });
  return result.count;
}
