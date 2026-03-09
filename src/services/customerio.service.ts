/**
 * Pi Surveying — Customer.io Event-Driven Sequences
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PURPOSE: Automated email sequences and drip campaigns triggered by user behavior.
 * Events are tracked here; Customer.io decides when/if to send emails based on
 * configured workflows in the Customer.io dashboard.
 *
 * UNIFIED EVENTS (preferred — work for both quotes and orders):
 * - PROPOSAL_SENT          → Proposal sent to client (source_type: "quote" | "order")
 * - PROPOSAL_SIGNED        → Client signs proposal (source_type: "quote" | "order")
 * - PAYMENT_REMINDER_START → Payment required (source_type: "quote" | "order")
 * - PAYMENT_REMINDER_STOP  → Payment received (source_type: "quote" | "order")
 *
 * FORM EVENTS (separate — distinct user journeys):
 * - QUOTE_FORM_STARTED     → Draft quote request created (nurture sequence)
 * - QUOTE_FORM_COMPLETED   → Quote request finalized (confirmation + next steps)
 * - ORDER_FORM_STARTED     → Draft order created (nurture sequence)
 * - ORDER_FORM_COMPLETED   → Order finalized (post-order nurture)
 *
 * LEGACY EVENTS (kept for backward compatibility during transition):
 * - QUOTE_SENT, QUOTE_PROPOSAL_SIGNED, ORDER_PROPOSAL_SENT,
 *   ORDER_PROPOSAL_SIGNED, ORDER_PAYMENT_REMINDER_START,
 *   ORDER_PAYMENT_REMINDER_STOP
 *   These fire alongside the unified events until Customer.io workflows are migrated.
 *
 * For immediate transactional emails (auth, order confirmations, internal notifications),
 * see: backend/src/services/email-templates.ts (SendGrid templates)
 *
 * NOTE: Email templates for Customer.io events are managed in the Customer.io dashboard,
 * not in this codebase.
 */

import { Queue } from "bullmq";
import { envStore, DcsEnv } from "../env-store";
import { generalLogger as logger } from "../lib/logger";
import { getBullMQConnection } from "../lib/bullmq-connection";
import { getStagingEmailOrOriginal } from "../lib/staging-email";

export enum CustomerIoEventsNames {
  // ─── Form events (distinct user journeys — NOT unified) ─────────────────────
  QUOTE_FORM_STARTED = "quote_form_started",
  QUOTE_FORM_COMPLETED = "quote_form_completed",
  ORDER_FORM_STARTED = "order_form_started",
  ORDER_FORM_COMPLETED = "order_form_completed",

  // ─── Unified events (work for both quotes and orders) ───────────────────────
  PROPOSAL_SENT = "proposal_sent",
  PROPOSAL_SIGNED = "proposal_signed",
  PAYMENT_REMINDER_START = "payment_reminder_start",
  PAYMENT_REMINDER_STOP = "payment_reminder_stop",

  // ─── Legacy events (kept during transition — remove after CIO migration) ────
  /** @deprecated Use PROPOSAL_SENT with source_type: "quote" */
  QUOTE_SENT = "quote_sent",
  /** @deprecated Use PROPOSAL_SIGNED with source_type: "quote" */
  QUOTE_PROPOSAL_SIGNED = "quote_proposal_signed",
  /** @deprecated Use PROPOSAL_SENT with source_type: "order" */
  ORDER_PROPOSAL_SENT = "order_proposal_sent",
  /** @deprecated Use PROPOSAL_SIGNED with source_type: "order" */
  ORDER_PROPOSAL_SIGNED = "order_proposal_signed",
  /** @deprecated Use PAYMENT_REMINDER_START with source_type: "order" */
  ORDER_PAYMENT_REMINDER_START = "order_payment_reminder_start",
  /** @deprecated Use PAYMENT_REMINDER_STOP with source_type: "order" */
  ORDER_PAYMENT_REMINDER_STOP = "order_payment_reminder_stop",
}

let _customerioQueue: Queue | null = null;

function getCustomerioQueue(): Queue {
  if (!_customerioQueue) {
    _customerioQueue = new Queue("customerio-events", {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
  }
  return _customerioQueue;
}

// ─── URL Helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the public quote request form URL.
 * Used as `unsubscribe_url` in Customer.io event attributes so recipients
 * always have a manual opt-out path back to the form.
 */
export function getUnsubscribeUrl(): string {
  return `${envStore.FRONTEND_URL}/request-quote`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isEnabled(): boolean {
  return !!(envStore.CUSTOMERIO_SITE_ID && envStore.CUSTOMERIO_API_KEY);
}

/**
 * Runs every string attribute whose key contains "email" through the staging
 * trap so non-production environments never touch real Customer.io contacts.
 */
function trapEmailAttributes<T extends Record<string, unknown>>(attrs: T): T {
  if (process.env.DCS_ENV === DcsEnv.PROD) return attrs;

  const result = { ...attrs };
  for (const key of Object.keys(result)) {
    const val = result[key];
    if (key.toLowerCase().includes("email") && typeof val === "string") {
      (result as Record<string, unknown>)[key] = getStagingEmailOrOriginal(val);
    }
  }
  return result;
}

// ─── trackEvent ───────────────────────────────────────────────────────────────

export async function trackEvent(
  contactId: string,
  eventName: string,
  attributes: Record<string, unknown>,
): Promise<void> {
  if (!isEnabled()) {
    logger.debug("CustomerIO disabled (no credentials), skipping track", { eventName });
    return;
  }

  const enrichedAttrs = { ...attributes, unsubscribe_url: getUnsubscribeUrl() };

  await getCustomerioQueue().add("track", {
    type: "track",
    contactId,
    eventName,
    attributes: trapEmailAttributes(enrichedAttrs),
    enqueuedAt: new Date().toISOString(),
  });
  logger.debug("CustomerIO event queued", { contactId, eventName });
}

// ─── identifyContact ──────────────────────────────────────────────────────────

export async function identifyContact(
  contactId: string,
  attributes: Record<string, unknown> & { email?: string },
): Promise<void> {
  if (!isEnabled()) {
    logger.debug("CustomerIO disabled (no credentials), skipping identify", { contactId });
    return;
  }

  await getCustomerioQueue().add("identify", {
    type: "identify",
    contactId,
    attributes: trapEmailAttributes(attributes),
    enqueuedAt: new Date().toISOString(),
  });

  logger.debug("CustomerIO identify queued", { contactId });
}

// ─── identifyAndTrackEvent ───────────────────────────────────────────────────
// Identifies a contact and fires an event in a single call. Both jobs are
// enqueued independently so a failure in one does not block the other.

export async function identifyAndTrackEvent(
  contactId: string,
  identifyAttributes: Record<string, unknown> & { email?: string },
  eventName: string,
  eventAttributes: Record<string, unknown>,
): Promise<void> {
  await Promise.all([
    identifyContact(contactId, identifyAttributes),
    trackEvent(contactId, eventName, eventAttributes),
  ]);
}

// ─── fireUnifiedEvent ────────────────────────────────────────────────────────
// Fires a unified event and optionally dual-fires a legacy event for backward
// compatibility during the Customer.io workflow migration period.

interface FireUnifiedEventOptions {
  contactId: string;
  identifyAttributes: Record<string, unknown> & { email?: string };
  unifiedEventName: string;
  legacyEventName?: string;
  attributes: Record<string, unknown>;
}

export function fireUnifiedEvent(opts: FireUnifiedEventOptions): void {
  void identifyAndTrackEvent(
    opts.contactId,
    opts.identifyAttributes,
    opts.unifiedEventName,
    opts.attributes,
  ).catch((err: unknown) =>
    logger.warn("Unified CIO event failed", {
      err,
      event: opts.unifiedEventName,
    }),
  );

  if (opts.legacyEventName) {
    void trackEvent(
      opts.contactId,
      opts.legacyEventName,
      opts.attributes,
    ).catch((err: unknown) =>
      logger.warn("Legacy CIO event failed", {
        err,
        event: opts.legacyEventName,
      }),
    );
  }
}
