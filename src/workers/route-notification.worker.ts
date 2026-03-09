import { Worker, Queue } from "bullmq";
import sgMail from "@sendgrid/mail";
import { prisma } from "../lib/prisma";
import { workerLogger as logger } from "../lib/logger";
import { getBullMQConnection } from "../lib/bullmq-connection";
import { envStore } from "../env-store";
import { routeReminderNotificationHtml } from "../services/email-templates";

export const ROUTE_NOTIFICATION_QUEUE = "route-crew-notifications";

export interface RouteNotificationPayload {
  routeId: string;
  crewName: string;
  routeDate: string;
  jobs: Array<{ jobNumber: string; address: string }>;
  estimatedDriveTime: number | null;
  recipientEmails: string[];
}

let _queue: Queue | null = null;

export function getRouteNotificationQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(ROUTE_NOTIFICATION_QUEUE, { connection: getBullMQConnection() });
  }
  return _queue;
}

export function startRouteNotificationWorker(): Worker {
  if (envStore.SENDGRID_API_KEY) {
    sgMail.setApiKey(envStore.SENDGRID_API_KEY);
  }

  const worker = new Worker<RouteNotificationPayload>(
    ROUTE_NOTIFICATION_QUEUE,
    async (job) => {
      const p = job.data;

      if (p.recipientEmails.length === 0) {
        logger.info("No recipients for route notification", { routeId: p.routeId });
        return;
      }

      const html = routeReminderNotificationHtml({
        crewName: p.crewName,
        routeDate: p.routeDate,
        jobs: p.jobs,
        estimatedDriveTime: p.estimatedDriveTime,
      });

      const fromEmail = envStore.SENDGRID_FROM_EMAIL ?? "noreply@pisurveying.com";

      if (!envStore.SENDGRID_API_KEY) {
        logger.info("[MOCK] Route reminder email skipped (no API key)", {
          routeId: p.routeId,
          to: p.recipientEmails,
        });
        return;
      }

      await sgMail.sendMultiple({
        to: p.recipientEmails,
        from: { email: fromEmail, name: "Pi Surveying" },
        subject: `Route Reminder — ${p.routeDate}`,
        html,
      });

      logger.info("Route reminder email sent", {
        routeId: p.routeId,
        recipientCount: p.recipientEmails.length,
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 3,
    }
  );

  worker.on("completed", (job) => {
    logger.info(`Route notification job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`Route notification job ${job?.id} failed`, { error: err });
  });

  return worker;
}
