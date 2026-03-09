import type { Server as SocketServer } from "socket.io";
import type { OrderSource } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generalLogger as logger } from "../lib/logger";
import { envStore } from "../env-store";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { sendEmail, sendOrderCreatedEmail } from "./email.service";
import { sendPushToUser } from "../lib/web-push";
import {
  adminOrderNotificationEmailHtml,
  adminQuoteNotificationEmailHtml,
  researchCompleteNotificationEmailHtml,
  crewAssignmentEmailHtml,
  crewReassignmentEmailHtml,
  crewFieldDateChangeEmailHtml,
} from "./email-templates";
import { sendExpoPushToUser } from "../lib/expo-push";

// ─── Minimal shape contracts ─────────────────────────────────────────────────

interface OrderForNotification {
  id: string;
  orderNumber: string;
  price: { toString(): string } | number | string | null;
  surveyType: string | null;
  propertyAddressLine1: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  source?: OrderSource | null;
}

interface QuoteForNotification {
  client: {
    firstName: string;
    lastName: string;
    email: string;
  };
}

interface UserRecipient {
  id: string;
  email: string;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Dispatches a new-order notification to Holly across three independent
 * channels: in-app (Socket.io + DB record), email (SendGrid), and browser
 * push (Web Push API).
 *
 * Each channel is wrapped in its own try/catch — a failure in one channel
 * never blocks the others. This function is always safe to call fire-and-forget.
 */
export async function notifyHollyOrderCreated(
  order: OrderForNotification,
  quote: QuoteForNotification,
  io: SocketServer | undefined,
): Promise<void> {
  const hollyEmail = envStore.HOLLY_EMAIL;
  if (!hollyEmail) {
    logger.warn("[NotificationService] HOLLY_EMAIL not configured, skipping order notification", {
      orderId: order.id,
      orderNumber: order.orderNumber,
    });
    return;
  }

  const holly = await prisma.user.findFirst({
    where: { email: hollyEmail, isActive: true },
    select: { id: true, email: true },
  });

  if (!holly) {
    logger.warn("[NotificationService] Holly user not found by HOLLY_EMAIL", {
      hollyEmail,
      orderId: order.id,
    });
    return;
  }

  const clientName = `${quote.client.firstName} ${quote.client.lastName}`;
  const propertyAddress = `${order.propertyAddressLine1}, ${order.propertyCity}, ${order.propertyState} ${order.propertyZip}`;
  const surveyType = order.surveyType ?? "Land Survey";
  const price = Number(order.price).toFixed(2);

  const title = `New Order #${order.orderNumber}`;
  const message = `${clientName} — ${propertyAddress}`;

  logger.info("[NotificationService] Dispatching order created notifications", {
    orderNumber: order.orderNumber,
    hollyId: holly.id,
    channels: ["in-app", "email", "push"],
  });

  await dispatchToUser(holly, title, message, "order_created", order, io, clientName);
}

// ─── Shared 3-channel dispatcher ─────────────────────────────────────────────

async function dispatchToUser(
  user: UserRecipient,
  title: string,
  message: string,
  notificationType: string,
  order: OrderForNotification,
  io: SocketServer | undefined,
  clientName?: string,
): Promise<void> {
  await Promise.all([
    (async () => {
      try {
        const notification = await prisma.notification.create({
          data: {
            userId: user.id,
            type: notificationType,
            title,
            message,
            entityType: "order",
            entityId: order.id,
          },
        });
        if (io) {
          io.to(ROOM_PREFIXES.USER(user.id)).emit("notification:new", {
            id: notification.id,
            title: notification.title,
            message: notification.message,
            type: notification.type,
            entityType: notification.entityType,
            entityId: notification.entityId,
            isRead: notification.isRead,
            readAt: notification.readAt,
            createdAt: notification.createdAt,
          });
        }
      } catch (err) {
        logger.error("[NotificationService] In-app failed", {
          error: err instanceof Error ? err.message : String(err),
          userId: user.id,
          orderNumber: order.orderNumber,
        });
      }
    })(),
    (async () => {
      try {
        const portalUrl = `${envStore.FRONTEND_URL}/orders/${order.id}`;
        await sendEmail({
          to: user.email,
          subject: title,
          html: adminOrderNotificationEmailHtml({
            orderNumber: order.orderNumber,
            clientName: clientName ?? "Client",
            surveyType: order.surveyType ?? "other",
            propertyAddressLine1: order.propertyAddressLine1 ?? "",
            propertyCity: order.propertyCity ?? "",
            propertyState: order.propertyState ?? "",
            propertyZip: order.propertyZip ?? "",
            price: order.price != null ? String(order.price) : null,
            source: order.source,
            portalUrl,
          }),
        });
      } catch (err) {
        logger.error("[NotificationService] Email failed", {
          error: err instanceof Error ? err.message : String(err),
          userId: user.id,
          orderNumber: order.orderNumber,
        });
      }
    })(),
    (async () => {
      try {
        await sendPushToUser(user.id, {
          title,
          body: message,
          icon: "/icons/icon-192x192.png",
          badge: "/icons/badge-72x72.png",
          data: {
            url: `/orders/${order.id}`,
            orderId: order.id,
            orderNumber: order.orderNumber,
          },
        });
      } catch (err) {
        logger.error("[NotificationService] Push failed", {
          error: err instanceof Error ? err.message : String(err),
          userId: user.id,
          orderNumber: order.orderNumber,
        });
      }
    })(),
  ]);
}

// ─── Resolve user by env-var email ───────────────────────────────────────────

async function resolveUserByEnvEmail(
  envKey: string,
  email: string,
  context: string,
): Promise<UserRecipient | null> {
  if (!email) {
    logger.warn(`[NotificationService] ${envKey} not configured, skipping ${context}`);
    return null;
  }
  const user = await prisma.user.findFirst({
    where: { email, isActive: true },
    select: { id: true, email: true },
  });
  if (!user) {
    logger.warn(`[NotificationService] User not found for ${envKey}`, { email, context });
    return null;
  }
  return user;
}

// ─── T007: Resolve Research Leaders ──────────────────────────────────────────

async function resolveResearchLeaders(): Promise<UserRecipient[]> {
  const roleUsers = await prisma.user.findMany({
    where: { role: "pls_reviewer", isActive: true },
    select: { id: true, email: true },
  });

  if (roleUsers.length > 0) {
    return roleUsers;
  }

  // Fallback: env-var email match
  const fallbackEmail = envStore.RESEARCH_LEADER_EMAIL;
  if (!fallbackEmail) {
    logger.warn("[NotificationService] No research_leader users and RESEARCH_LEADER_EMAIL not configured");
    return [];
  }

  const fallbackUser = await prisma.user.findFirst({
    where: { email: fallbackEmail, isActive: true },
    select: { id: true, email: true },
  });

  if (!fallbackUser) {
    logger.warn("[NotificationService] RESEARCH_LEADER_EMAIL user not found", { email: fallbackEmail });
    return [];
  }

  return [fallbackUser];
}

// ─── T008: Notify Research Leader(s) ─────────────────────────────────────────

export async function notifyResearchLeader(
  order: OrderForNotification,
  clientName: string,
  io: SocketServer | undefined,
): Promise<void> {
  const leaders = await resolveResearchLeaders();
  if (leaders.length === 0) {
    logger.warn("[NotificationService] No Research Leader recipients, skipping", {
      orderNumber: order.orderNumber,
    });
    return;
  }

  const propertyAddress = formatPropertyAddress(order);
  const title = `Research Ready: Order #${order.orderNumber}`;
  const message = `${clientName} — ${propertyAddress} is ready for research.`;

  logger.info("[NotificationService] Dispatching research leader notifications", {
    orderNumber: order.orderNumber,
    recipientCount: leaders.length,
  });

  await Promise.all(
    leaders.map((leader) =>
      dispatchToUser(leader, title, message, "research_ready", order, io, clientName),
    ),
  );
}

// ─── T009: Notify Admins (Holly + Alex) on order "new" ──────────────────────

export async function notifyAdminsOrderNew(
  order: OrderForNotification,
  clientName: string,
  io: SocketServer | undefined,
): Promise<void> {
  const source = order.source ?? "internal";
  const isPublic = source === "website";

  const recipients: UserRecipient[] = [];

  const holly = await resolveUserByEnvEmail(
    "HOLLY_EMAIL",
    envStore.HOLLY_EMAIL,
    "admin order new notification",
  );
  if (holly) recipients.push(holly);

  if (isPublic) {
    const alex = await resolveUserByEnvEmail(
      "ALEX_EMAIL",
      envStore.ALEX_EMAIL,
      "admin order new notification (public)",
    );
    if (alex) recipients.push(alex);
  }

  if (recipients.length === 0) {
    logger.warn("[NotificationService] No admin recipients for order new notification", {
      orderNumber: order.orderNumber,
      source,
    });
    return;
  }

  const propertyAddress = formatPropertyAddress(order);
  const sourceLabel = isPublic ? "Public Website" : "Internal";
  const title = `New Order #${order.orderNumber}`;
  const message = `${clientName} — ${propertyAddress} (Source: ${sourceLabel})`;

  logger.info("[NotificationService] Dispatching admin order-new notifications", {
    orderNumber: order.orderNumber,
    source,
    recipientCount: recipients.length,
  });

  await Promise.all(
    recipients.map((user) =>
      dispatchToUser(user, title, message, "order_created", order, io, clientName),
    ),
  );
}

// ─── Notify Admins on quote "new" (same source-based logic) ──────────────────

interface QuoteForAdminNotification {
  id: string;
  quoteNumber: string;
  source: string | null;
  surveyType: string | null;
  propertyAddressLine1: string | null;
  propertyAddressLine2?: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
}

export async function notifyAdminsQuoteNew(
  quote: QuoteForAdminNotification,
  clientName: string,
  io: SocketServer | undefined,
): Promise<void> {
  const source = quote.source ?? "internal";
  const isPublic = source === "website";

  const recipients: UserRecipient[] = [];

  const holly = await resolveUserByEnvEmail(
    "HOLLY_EMAIL",
    envStore.HOLLY_EMAIL,
    "admin quote new notification",
  );
  if (holly) recipients.push(holly);

  if (isPublic) {
    const alex = await resolveUserByEnvEmail(
      "ALEX_EMAIL",
      envStore.ALEX_EMAIL,
      "admin quote new notification (public)",
    );
    if (alex) recipients.push(alex);
  }

  if (recipients.length === 0) {
    logger.warn("[NotificationService] No admin recipients for quote new notification", {
      quoteNumber: quote.quoteNumber,
      source,
    });
    return;
  }

  const propertyParts = [
    quote.propertyAddressLine1,
    quote.propertyCity,
    quote.propertyState ? `${quote.propertyState} ${quote.propertyZip ?? ""}`.trim() : null,
  ].filter(Boolean);
  const propertyAddress = propertyParts.join(", ") || "Address pending";
  const sourceLabel = isPublic ? "Public Website" : "Internal";
  const title = `New Quote #${quote.quoteNumber}`;
  const message = `${clientName} — ${propertyAddress} (Source: ${sourceLabel})`;

  logger.info("[NotificationService] Dispatching admin quote-new notifications", {
    quoteNumber: quote.quoteNumber,
    source,
    recipientCount: recipients.length,
  });

  await Promise.all(
    recipients.map((user) =>
      dispatchQuoteToUser(user, title, message, "quote_created", quote, io, clientName),
    ),
  );
}

// ─── Quote-specific 3-channel dispatcher ────────────────────────────────────

async function dispatchQuoteToUser(
  user: UserRecipient,
  title: string,
  message: string,
  notificationType: string,
  quote: QuoteForAdminNotification,
  io: SocketServer | undefined,
  clientName?: string,
): Promise<void> {
  await Promise.all([
    (async () => {
      try {
        const notification = await prisma.notification.create({
          data: {
            userId: user.id,
            type: notificationType,
            title,
            message,
            entityType: "quote",
            entityId: quote.id,
          },
        });
        if (io) {
          io.to(ROOM_PREFIXES.USER(user.id)).emit("notification:new", {
            id: notification.id,
            title: notification.title,
            message: notification.message,
            type: notification.type,
            entityType: notification.entityType,
            entityId: notification.entityId,
            isRead: notification.isRead,
            readAt: notification.readAt,
            createdAt: notification.createdAt,
          });
        }
      } catch (err) {
        logger.error("[NotificationService] In-app failed (quote)", {
          error: err instanceof Error ? err.message : String(err),
          userId: user.id,
          quoteNumber: quote.quoteNumber,
        });
      }
    })(),
    (async () => {
      try {
        const portalUrl = `${envStore.FRONTEND_URL}/quotes/${quote.id}`;
        await sendEmail({
          to: user.email,
          subject: title,
          html: adminQuoteNotificationEmailHtml({
            quoteNumber: quote.quoteNumber,
            clientName: clientName ?? "Client",
            surveyType: quote.surveyType ?? "other",
            propertyAddressLine1: quote.propertyAddressLine1 ?? "",
            propertyAddressLine2: quote.propertyAddressLine2 ?? undefined,
            propertyCity: quote.propertyCity ?? "",
            propertyState: quote.propertyState ?? "",
            propertyZip: quote.propertyZip ?? "",
            source: quote.source,
            portalUrl,
          }),
        });
      } catch (err) {
        logger.error("[NotificationService] Email failed (quote)", {
          error: err instanceof Error ? err.message : String(err),
          userId: user.id,
          quoteNumber: quote.quoteNumber,
        });
      }
    })(),
    (async () => {
      try {
        await sendPushToUser(user.id, {
          title,
          body: message,
          icon: "/icons/icon-192x192.png",
          badge: "/icons/badge-72x72.png",
          data: {
            url: `/quotes/${quote.id}`,
            quoteId: quote.id,
            quoteNumber: quote.quoteNumber,
          },
        });
      } catch (err) {
        logger.error("[NotificationService] Push failed (quote)", {
          error: err instanceof Error ? err.message : String(err),
          userId: user.id,
          quoteNumber: quote.quoteNumber,
        });
      }
    })(),
  ]);
}

// ─── Resolve Admin & Office Manager recipients ─────────────────────────────

async function resolveAdminAndOfficeManagers(): Promise<UserRecipient[]> {
  const users = await prisma.user.findMany({
    where: { role: { in: ["admin", "office_manager"] }, isActive: true },
    select: { id: true, email: true },
  });

  if (users.length === 0) {
    logger.warn("[NotificationService] No active admin/office_manager users found for notification");
  }

  return users;
}

// ─── Notify Admins/OMs on Research Complete ─────────────────────────────────

export async function notifyAdminsResearchComplete(
  order: OrderForNotification,
  clientName: string,
  io: SocketServer | undefined,
): Promise<void> {
  const recipients = await resolveAdminAndOfficeManagers();
  if (recipients.length === 0) {
    return;
  }

  const propertyAddress = formatPropertyAddress(order);
  const title = `Research Complete: Order #${order.orderNumber}`;
  const message = `${clientName} — ${propertyAddress}`;

  logger.info("[NotificationService] Dispatching research-complete notifications", {
    orderNumber: order.orderNumber,
    recipientCount: recipients.length,
  });

  await Promise.all(
    recipients.map((user) =>
      dispatchResearchCompleteToUser(user, title, message, order, io, clientName),
    ),
  );
}

async function dispatchResearchCompleteToUser(
  user: UserRecipient,
  title: string,
  message: string,
  order: OrderForNotification,
  io: SocketServer | undefined,
  clientName: string,
): Promise<void> {
  await Promise.all([
    (async () => {
      try {
        const notification = await prisma.notification.create({
          data: {
            userId: user.id,
            type: "research_complete",
            title,
            message,
            entityType: "order",
            entityId: order.id,
          },
        });
        if (io) {
          io.to(ROOM_PREFIXES.USER(user.id)).emit("notification:new", {
            id: notification.id,
            title: notification.title,
            message: notification.message,
            type: notification.type,
            entityType: notification.entityType,
            entityId: notification.entityId,
            isRead: notification.isRead,
            readAt: notification.readAt,
            createdAt: notification.createdAt,
          });
        }
      } catch (err) {
        logger.error("[NotificationService] In-app failed (research_complete)", {
          error: err instanceof Error ? err.message : String(err),
          userId: user.id,
          orderNumber: order.orderNumber,
        });
      }
    })(),
    (async () => {
      try {
        const portalUrl = `${envStore.FRONTEND_URL}/orders/${order.id}`;
        await sendEmail({
          to: user.email,
          subject: title,
          html: researchCompleteNotificationEmailHtml({
            orderNumber: order.orderNumber,
            clientName,
            surveyType: order.surveyType ?? "other",
            propertyAddressLine1: order.propertyAddressLine1 ?? "",
            propertyCity: order.propertyCity ?? "",
            propertyState: order.propertyState ?? "",
            propertyZip: order.propertyZip ?? "",
            portalUrl,
          }),
        });
      } catch (err) {
        logger.error("[NotificationService] Email failed (research_complete)", {
          error: err instanceof Error ? err.message : String(err),
          userId: user.id,
          orderNumber: order.orderNumber,
        });
      }
    })(),
    (async () => {
      try {
        await sendPushToUser(user.id, {
          title,
          body: message,
          icon: "/icons/icon-192x192.png",
          badge: "/icons/badge-72x72.png",
          data: {
            url: `/orders/${order.id}`,
            orderId: order.id,
            orderNumber: order.orderNumber,
          },
        });
      } catch (err) {
        logger.error("[NotificationService] Push failed (research_complete)", {
          error: err instanceof Error ? err.message : String(err),
          userId: user.id,
          orderNumber: order.orderNumber,
        });
      }
    })(),
  ]);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPropertyAddress(order: OrderForNotification): string {
  const parts = [
    order.propertyAddressLine1,
    order.propertyCity,
    order.propertyState ? `${order.propertyState} ${order.propertyZip ?? ""}`.trim() : null,
  ].filter(Boolean);
  return parts.join(", ") || "Address pending";
}

// ─── Crew Assignment Notification Types ──────────────────────────────────────

export interface JobForCrewNotification {
  id: string;
  jobNumber: string;
  fieldDate: Date | null;
  orderId: string;
  propertyAddressLine1: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
}

export interface CrewWithMembers {
  id: string;
  name: string;
  members: UserRecipient[];
}

interface ClientInfo {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

function formatJobPropertyAddress(job: JobForCrewNotification): string {
  const parts = [
    job.propertyAddressLine1,
    job.propertyCity,
    job.propertyState ? `${job.propertyState} ${job.propertyZip ?? ""}`.trim() : null,
  ].filter(Boolean);
  return parts.join(", ") || "Address pending";
}

function formatFieldDate(date: Date | null): string {
  if (!date) return "TBD";
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export async function loadJobNotificationData(
  jobId: string,
): Promise<{ job: JobForCrewNotification; client: ClientInfo | null } | null> {
  const jobData = await prisma.job.findFirst({
    where: { id: jobId, deletedAt: null },
    select: {
      id: true,
      jobNumber: true,
      fieldDate: true,
      orderId: true,
      propertyAddressLine1: true,
      propertyCity: true,
      propertyState: true,
      propertyZip: true,
      order: {
        select: {
          client: {
            select: { firstName: true, lastName: true, email: true, phone: true },
          },
        },
      },
    },
  });
  if (!jobData) return null;

  return {
    job: {
      id: jobData.id,
      jobNumber: jobData.jobNumber,
      fieldDate: jobData.fieldDate,
      orderId: jobData.orderId,
      propertyAddressLine1: jobData.propertyAddressLine1,
      propertyCity: jobData.propertyCity,
      propertyState: jobData.propertyState,
      propertyZip: jobData.propertyZip,
    },
    client: jobData.order?.client ?? null,
  };
}

export async function loadCrewWithMembers(crewId: string): Promise<CrewWithMembers | null> {
  const crew = await prisma.crew.findFirst({
    where: { id: crewId, isActive: true },
    select: {
      id: true,
      name: true,
      members: {
        where: { isActive: true },
        select: { id: true, email: true },
      },
    },
  });
  return crew;
}

// ─── US1: Notify Crew on Job Assignment ──────────────────────────────────────

export async function notifyCrewJobAssigned(
  job: JobForCrewNotification,
  crew: CrewWithMembers,
  client: ClientInfo | null,
  io: SocketServer | undefined,
): Promise<void> {
  if (crew.members.length === 0) {
    logger.warn("[NotificationService] Crew has no active members, skipping assignment notification", {
      crewId: crew.id,
      jobNumber: job.jobNumber,
    });
    return;
  }

  const propertyAddress = formatJobPropertyAddress(job);
  const fieldDate = formatFieldDate(job.fieldDate);
  const clientName = client ? `${client.firstName} ${client.lastName}` : "N/A";
  const clientEmail = client?.email ?? "N/A";
  const clientPhone = client?.phone ?? "N/A";
  const portalUrl = `${envStore.FRONTEND_URL}/jobs/${job.id}`;

  const title = `Job #${job.jobNumber} Assigned`;
  const message = `${propertyAddress} — ${fieldDate}`;

  logger.info("[NotificationService] Dispatching crew assignment notifications", {
    jobNumber: job.jobNumber,
    crewId: crew.id,
    crewName: crew.name,
    memberCount: crew.members.length,
    channels: ["in-app", "email", "push"],
  });

  await Promise.all(
    crew.members.map((member) =>
      dispatchCrewNotification(member, title, message, "job_assigned", job, io, {
        propertyAddress,
        fieldDate,
        clientName,
        clientEmail,
        clientPhone,
        portalUrl,
      }),
    ),
  );
}

// ─── US2: Notify Old Crew on Reassignment ────────────────────────────────────

export async function notifyCrewJobReassigned(
  job: JobForCrewNotification,
  oldCrewMembers: UserRecipient[],
  io: SocketServer | undefined,
): Promise<void> {
  if (oldCrewMembers.length === 0) return;

  const propertyAddress = formatJobPropertyAddress(job);
  const fieldDate = formatFieldDate(job.fieldDate);

  const title = `Job #${job.jobNumber} Reassigned`;
  const message = `You have been removed from this job.`;

  logger.info("[NotificationService] Dispatching crew reassignment notifications", {
    jobNumber: job.jobNumber,
    oldCrewMemberCount: oldCrewMembers.length,
  });

  await Promise.all(
    oldCrewMembers.map(async (member) => {
      await Promise.all([
        (async () => {
          try {
            const notification = await prisma.notification.create({
              data: {
                userId: member.id,
                type: "job_reassigned",
                title,
                message,
                entityType: "job",
                entityId: job.id,
              },
            });
            if (io) {
              io.to(ROOM_PREFIXES.USER(member.id)).emit("notification:new", {
                id: notification.id,
                title: notification.title,
                message: notification.message,
                type: notification.type,
                entityType: notification.entityType,
                entityId: notification.entityId,
                isRead: notification.isRead,
                readAt: notification.readAt,
                createdAt: notification.createdAt,
              });
            }
          } catch (err) {
            logger.error("[NotificationService] In-app failed (reassignment)", {
              error: err instanceof Error ? err.message : String(err),
              userId: member.id,
              jobNumber: job.jobNumber,
            });
          }
        })(),
        (async () => {
          try {
            await sendEmail({
              to: member.email,
              subject: title,
              html: crewReassignmentEmailHtml({
                jobNumber: job.jobNumber,
                fieldDate,
                propertyAddress,
              }),
            });
          } catch (err) {
            logger.error("[NotificationService] Email failed (reassignment)", {
              error: err instanceof Error ? err.message : String(err),
              userId: member.id,
              jobNumber: job.jobNumber,
            });
          }
        })(),
      ]);
    }),
  );
}

// ─── US4: Notify Crew on Field Date Change ───────────────────────────────────

export async function notifyCrewFieldDateChanged(
  job: JobForCrewNotification,
  crew: CrewWithMembers,
  oldFieldDate: Date,
  newFieldDate: Date,
  client: ClientInfo | null,
  io: SocketServer | undefined,
): Promise<void> {
  if (crew.members.length === 0) return;

  const propertyAddress = formatJobPropertyAddress(job);
  const oldDateStr = formatFieldDate(oldFieldDate);
  const newDateStr = formatFieldDate(newFieldDate);
  const clientName = client ? `${client.firstName} ${client.lastName}` : "N/A";
  const clientEmail = client?.email ?? "N/A";
  const clientPhone = client?.phone ?? "N/A";

  const title = `Job #${job.jobNumber} — Date Changed`;
  const message = `Field date updated: ${oldDateStr} → ${newDateStr}`;

  logger.info("[NotificationService] Dispatching field date change notifications", {
    jobNumber: job.jobNumber,
    crewId: crew.id,
    oldFieldDate: oldDateStr,
    newFieldDate: newDateStr,
    memberCount: crew.members.length,
  });

  await Promise.all(
    crew.members.map(async (member) => {
      await Promise.all([
        (async () => {
          try {
            const notification = await prisma.notification.create({
              data: {
                userId: member.id,
                type: "job_field_date_changed",
                title,
                message,
                entityType: "job",
                entityId: job.id,
              },
            });
            if (io) {
              io.to(ROOM_PREFIXES.USER(member.id)).emit("notification:new", {
                id: notification.id,
                title: notification.title,
                message: notification.message,
                type: notification.type,
                entityType: notification.entityType,
                entityId: notification.entityId,
                isRead: notification.isRead,
                readAt: notification.readAt,
                createdAt: notification.createdAt,
              });
            }
          } catch (err) {
            logger.error("[NotificationService] In-app failed (field_date_changed)", {
              error: err instanceof Error ? err.message : String(err),
              userId: member.id,
              jobNumber: job.jobNumber,
            });
          }
        })(),
        (async () => {
          try {
            await sendEmail({
              to: member.email,
              subject: title,
              html: crewFieldDateChangeEmailHtml({
                jobNumber: job.jobNumber,
                oldFieldDate: oldDateStr,
                newFieldDate: newDateStr,
                propertyAddress,
                clientName,
                clientEmail,
                clientPhone,
              }),
            });
          } catch (err) {
            logger.error("[NotificationService] Email failed (field_date_changed)", {
              error: err instanceof Error ? err.message : String(err),
              userId: member.id,
              jobNumber: job.jobNumber,
            });
          }
        })(),
      ]);
    }),
  );
}

// ─── Shared crew dispatcher (in-app + email + push) ─────────────────────────

interface CrewEmailData {
  propertyAddress: string;
  fieldDate: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  portalUrl: string;
}

async function dispatchCrewNotification(
  member: UserRecipient,
  title: string,
  message: string,
  notificationType: string,
  job: JobForCrewNotification,
  io: SocketServer | undefined,
  emailData: CrewEmailData,
): Promise<void> {
  await Promise.all([
    (async () => {
      try {
        const notification = await prisma.notification.create({
          data: {
            userId: member.id,
            type: notificationType,
            title,
            message,
            entityType: "job",
            entityId: job.id,
          },
        });
        if (io) {
          io.to(ROOM_PREFIXES.USER(member.id)).emit("notification:new", {
            id: notification.id,
            title: notification.title,
            message: notification.message,
            type: notification.type,
            entityType: notification.entityType,
            entityId: notification.entityId,
            isRead: notification.isRead,
            readAt: notification.readAt,
            createdAt: notification.createdAt,
          });
        }
      } catch (err) {
        logger.error("[NotificationService] In-app failed (crew)", {
          error: err instanceof Error ? err.message : String(err),
          userId: member.id,
          jobNumber: job.jobNumber,
        });
      }
    })(),
    (async () => {
      try {
        await sendEmail({
          to: member.email,
          subject: title,
          html: crewAssignmentEmailHtml({
            jobNumber: job.jobNumber,
            fieldDate: emailData.fieldDate,
            propertyAddress: emailData.propertyAddress,
            clientName: emailData.clientName,
            clientEmail: emailData.clientEmail,
            clientPhone: emailData.clientPhone,
            portalUrl: emailData.portalUrl,
          }),
        });
      } catch (err) {
        logger.error("[NotificationService] Email failed (crew)", {
          error: err instanceof Error ? err.message : String(err),
          userId: member.id,
          jobNumber: job.jobNumber,
        });
      }
    })(),
    (async () => {
      try {
        await sendExpoPushToUser(member.id, {
          title,
          body: message,
          data: {
            url: `/jobs/${job.id}`,
            jobId: job.id,
            jobNumber: job.jobNumber,
          },
        });
      } catch (err) {
        logger.error("[NotificationService] Expo push failed (crew)", {
          error: err instanceof Error ? err.message : String(err),
          userId: member.id,
          jobNumber: job.jobNumber,
        });
      }
    })(),
  ]);
}
