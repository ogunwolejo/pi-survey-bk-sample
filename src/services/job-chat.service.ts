import { prisma } from "../lib/prisma";
import { ChatEntityType, UserRole } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { sendEmail } from "./email.service";
import { chatMentionPLSAssistantHtml } from "./email-templates";
import { jobLogger as logger } from "../lib/logger";
import { createSystemEvent as createChatSystemEvent } from "./chat.service";

export async function getMessages(jobId: string, page: number, limit: number) {
  const skip = (page - 1) * limit;
  const [messages, total] = await prisma.$transaction([
    prisma.jobChatMessage.findMany({
      where: { jobId, deletedAt: null },
      include: {
        author: { select: { id: true, name: true, role: true, image: true } },
        attachments: { select: { id: true, filename: true, mimeType: true, fileCategory: true, s3Key: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.jobChatMessage.count({ where: { jobId, deletedAt: null } }),
  ]);

  return {
    messages: messages.reverse(),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

function parseMentions(content: string): string[] {
  const mentionRegex = /@\[([^\]]+)\]/g;
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(content)) !== null) {
    if (match[1]) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

export async function postMessage(
  jobId: string,
  authorId: string,
  content: string,
  attachmentId?: string
) {
  const mentionedUserIds = parseMentions(content);

  const message = await prisma.jobChatMessage.create({
    data: {
      jobId,
      authorId,
      content,
      mentionedUserIds,
      ...(attachmentId ? { attachments: { connect: { id: attachmentId } } } : {}),
    },
    include: {
      author: { select: { id: true, name: true, role: true, image: true } },
      attachments: { select: { id: true, filename: true, mimeType: true, fileCategory: true } },
    },
  });

  // Create notifications for mentioned users
  if (mentionedUserIds.length > 0) {
    const mentionedUsers = await prisma.user.findMany({
      where: { id: { in: mentionedUserIds } },
      select: { id: true, role: true },
    });

    const notifications = mentionedUsers.map((u) => ({
      userId: u.id,
      type: "chat_mention",
      title: "You were mentioned in a job chat",
      message: content.slice(0, 200),
      entityType: "job",
      entityId: jobId,
    }));

    if (notifications.length > 0) {
      await prisma.notification.createMany({ data: notifications });
    }

    // Email PLS Assistants mentioned
    const plsAssistantIds = mentionedUsers
      .filter((u) => u.role === UserRole.pls_assistant)
      .map((u) => u.id);

    if (plsAssistantIds.length > 0) {
      const [author, job, plsUsers] = await Promise.all([
        prisma.user.findUnique({ where: { id: authorId }, select: { name: true } }),
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
          mentionedByName: author?.name ?? "A team member",
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
  }

  return message;
}

export async function createSystemEvent(
  jobId: string,
  fromStatus: string,
  toStatus: string,
  userId: string,
  io?: SocketServer,
) {
  return createChatSystemEvent({
    entityType: ChatEntityType.job,
    entityId: jobId,
    eventType: "status_change",
    content: `Status changed from **${fromStatus}** to **${toStatus}**`,
    metadata: { fromStatus, toStatus, changedBy: userId },
    userId,
    io,
  });
}
