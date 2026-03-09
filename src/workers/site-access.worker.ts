/**
 * Site Access Worker — processes BullMQ `send-site-access-email` jobs.
 *
 * Each job payload contains the site contact info, job details, and visit window.
 * Sends an email via SendGrid to the site contact.
 * Bounce detection: logs to job record and notifies office manager.
 */

import { Worker, Queue } from "bullmq";
import sgMail from "@sendgrid/mail";
import { prisma } from "../lib/prisma";
import { workerLogger as logger } from "../lib/logger";
import { getBullMQConnection } from "../lib/bullmq-connection";
import { envStore } from "../env-store";
import { UserRole } from "@prisma/client";
import { siteAccessNotificationHtml } from "../services/email-templates";

export const SITE_ACCESS_QUEUE = "site-access-emails";

export interface SiteAccessJobPayload {
  routeJobId: string;
  jobId: string;
  jobNumber: string;
  propertyAddress: string;
  fieldDate: string; // ISO date string
  visitWindowStart: string; // e.g. "8:00 AM"
  visitWindowEnd: string;   // e.g. "5:00 PM"
  siteContactName: string;
  siteContactEmail: string;
  siteContactPhone?: string;
}

let _queue: Queue | null = null;

export function getSiteAccessQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(SITE_ACCESS_QUEUE, { connection: getBullMQConnection() });
  }
  return _queue;
}

export function startSiteAccessWorker(): Worker {
  if (envStore.SENDGRID_API_KEY) {
    sgMail.setApiKey(envStore.SENDGRID_API_KEY);
  }

  const worker = new Worker<SiteAccessJobPayload>(
    SITE_ACCESS_QUEUE,
    async (job) => {
      const p = job.data;

      const html = siteAccessNotificationHtml({
        propertyAddress: p.propertyAddress,
        visitWindowStart: p.visitWindowStart,
        visitWindowEnd: p.visitWindowEnd,
        fieldDate: new Date(p.fieldDate).toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        }),
        siteContactName: p.siteContactName,
        jobNumber: p.jobNumber,
        siteContactPhone: p.siteContactPhone,
      });

      const fromEmail = envStore.SENDGRID_FROM_EMAIL ?? "noreply@pisurveying.com";

      try {
        if (!envStore.SENDGRID_API_KEY) {
          logger.info("[MOCK] Site access email skipped (no API key)", { to: p.siteContactEmail });
          return;
        }

        await sgMail.send({
          to: p.siteContactEmail,
          from: { email: fromEmail, name: "Pi Surveying" },
          subject: `Site Visit Notice — ${new Date(p.fieldDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${p.propertyAddress}`,
          html,
        });

        logger.info("Site access email sent", { jobId: p.jobId, to: p.siteContactEmail });
      } catch (err) {
        logger.error("Site access email failed", { jobId: p.jobId, error: err });

        // Notify office managers of bounce/failure
        const officeManagers = await prisma.user.findMany({
          where: { role: UserRole.office_manager, isActive: true },
          select: { id: true },
        });

        if (officeManagers.length > 0) {
          await prisma.notification.createMany({
            data: officeManagers.map((u) => ({
              userId: u.id,
              type: "site_access_email_failed",
              title: `Site access email failed for Job ${p.jobNumber}`,
              message: `Could not send site access notification to ${p.siteContactEmail} for ${p.propertyAddress}.`,
              entityType: "job",
              entityId: p.jobId,
            })),
            skipDuplicates: true,
          });
        }

        throw err;
      }
    },
    { connection: getBullMQConnection(), concurrency: 3 }
  );

  worker.on("completed", (job) => {
    logger.info(`Site access email job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`Site access email job ${job?.id} failed`, { error: err });
  });

  return worker;
}
