import sgMail from "@sendgrid/mail";
import type { MailDataRequired } from "@sendgrid/mail";
import { envStore, AppEnv } from "../env-store";
import { emailLogger as logger } from "../lib/logger";
import { getStagingEmailOrOriginal } from "../lib/staging-email";

// ─── Initialise SendGrid ────────────────────────────────────────────────────

let initialised = false;

function ensureInitialised(): void {
  if (initialised) return;
  sgMail.setApiKey(envStore.SENDGRID_API_KEY);
  initialised = true;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface EmailRecipient {
  email: string;
  name?: string;
}

type Recipient = string | EmailRecipient;

interface BaseEmailOptions {
  to: Recipient | Recipient[];
  cc?: Recipient | Recipient[];
  bcc?: Recipient | Recipient[];
  from?: EmailRecipient;
  replyTo?: EmailRecipient;
  subject: string;
  customArgs?: Record<string, string>;
}

export interface PlainEmailOptions extends BaseEmailOptions {
  text?: string;
  html: string;
}

export interface TemplateEmailOptions extends BaseEmailOptions {
  templateId: string;
  dynamicTemplateData: Record<string, unknown>;
}

export interface OrderConfirmationEmailParams {
  orderNumber: string;
  clientEmail: string;
  clientFirstName: string;
  clientLastName: string;
  surveyType: string;
  propertyAddressLine1: string;
  propertyAddressLine2?: string;
  propertyCity: string;
  propertyState: string;
  propertyZip: string;
  propertyCounty?: string;
  pin: string;
  closingDate?: Date | null;
  deliveryPreference?: string | null;
  onsiteContactFirstName?: string | null;
  onsiteContactLastName?: string | null;
  onsiteContactPhone?: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalise(r: Recipient): EmailRecipient {
  return typeof r === "string" ? { email: r } : r;
}

function normaliseList(
  r: Recipient | Recipient[] | undefined,
): EmailRecipient[] | undefined {
  if (r === undefined) return undefined;
  const list = Array.isArray(r) ? r : [r];
  return list.map(normalise);
}

/**
 * Applies the staging trap to every recipient address.
 * In production the addresses pass through unchanged.
 * In all other environments, if STAGING_TRAP_EMAIL is set, addresses are
 * rewritten so email never reaches real users (golden-tax pattern).
 */
function trapRecipients(
  recipients: EmailRecipient[] | undefined,
): EmailRecipient[] | undefined {
  if (!recipients) return undefined;
  return recipients.map((r) => ({
    ...r,
    email: getStagingEmailOrOriginal(r.email),
  }));
}

function defaultFrom(): EmailRecipient {
  return {
    email: envStore.SENDGRID_FROM_EMAIL,
    name: envStore.SENDGRID_FROM_NAME,
  };
}

// ─── Skipped environments ───────────────────────────────────────────────────

const SKIP_ENVS: string[] = [AppEnv.LOCAL, AppEnv.TEST];

function shouldSkipSend(): boolean {
  return SKIP_ENVS.includes(envStore.NODE_ENV);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Send a plain-text / HTML email through SendGrid.
 * The staging trap is applied automatically to all recipients.
 */
export async function sendEmail(opts: PlainEmailOptions): Promise<string | null> {
  const to = trapRecipients(normaliseList(opts.to));
  const cc = trapRecipients(normaliseList(opts.cc));
  const bcc = trapRecipients(normaliseList(opts.bcc));
  const from = opts.from ?? defaultFrom();

  if (shouldSkipSend()) {
    logger.info("[Email] Skipped (local/test)", {
      to,
      subject: opts.subject,
    });
    return null;
  }

  ensureInitialised();

  const msg: MailDataRequired = {
    to,
    cc: cc ?? undefined,
    bcc: bcc ?? undefined,
    from,
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    subject: opts.subject,
    ...(opts.text ? { text: opts.text } : {}),
    html: opts.html,
    ...(opts.customArgs ? { customArgs: opts.customArgs } : {}),
  };

  try {
    const [response] = await sgMail.send(msg);
    const messageId =
      (response?.headers?.["x-message-id"] as string | undefined) ?? null;
    logger.info("[Email] Sent", {
      to,
      subject: opts.subject,
      messageId,
    });
    return messageId;
  } catch (error) {
    logger.error("[Email] Send failed", {
      error: extractSendGridError(error),
      to,
      subject: opts.subject,
    });
    throw error;
  }
}

/**
 * Send an email using a SendGrid dynamic template.
 * The staging trap is applied automatically to all recipients.
 */
export async function sendTemplateEmail(
  opts: TemplateEmailOptions,
): Promise<string | null> {
  const to = trapRecipients(normaliseList(opts.to));
  const cc = trapRecipients(normaliseList(opts.cc));
  const bcc = trapRecipients(normaliseList(opts.bcc));
  const from = opts.from ?? defaultFrom();

  if (shouldSkipSend()) {
    logger.info("[Email] Skipped template (local/test)", {
      to,
      templateId: opts.templateId,
      subject: opts.subject,
    });
    return null;
  }

  ensureInitialised();

  const msg: MailDataRequired = {
    to,
    cc: cc ?? undefined,
    bcc: bcc ?? undefined,
    from,
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    subject: opts.subject,
    templateId: opts.templateId,
    dynamicTemplateData: opts.dynamicTemplateData,
    ...(opts.customArgs ? { customArgs: opts.customArgs } : {}),
  };

  try {
    const [response] = await sgMail.send(msg);
    const messageId =
      (response?.headers?.["x-message-id"] as string | undefined) ?? null;
    logger.info("[Email] Template sent", {
      to,
      templateId: opts.templateId,
      subject: opts.subject,
      messageId,
    });
    return messageId;
  } catch (error) {
    logger.error("[Email] Template send failed", {
      error: extractSendGridError(error),
      to,
      templateId: opts.templateId,
    });
    throw error;
  }
}

// ─── Auth Verification Emails ───────────────────────────────────────────────

import type { VerificationPurpose } from "./verification.service";
import { magicLinkEmailHtml, otpEmailHtml, orderConfirmationEmailHtml } from "./email-templates";

const ANSI_YELLOW = "\x1b[33m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_RESET = "\x1b[0m";

export function logDevBanner(label: string, fields: Record<string, string>): void {

  const entries = Object.entries(fields);
  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
  const lines = entries.map(
    ([k, v]) => `  ${k.padEnd(maxKeyLen)}  ${v}`,
  );
  const contentWidth = Math.max(...lines.map((l) => l.length), label.length + 4);
  const bar = "=".repeat(contentWidth + 4);
  const colorBar = `${ANSI_YELLOW}${bar}${ANSI_RESET}`;
  const colorLabel = `${ANSI_YELLOW}${ANSI_BOLD}  ** ${label} **${ANSI_RESET}`;

  console.log("\n");
  console.log(colorBar);
  console.log(colorLabel);
  console.log(colorBar);
  for (const line of lines) console.log(line);
  console.log(colorBar);
  console.log("\n");
}

export async function sendMagicLinkEmail(
  email: string,
  magicLinkUrl: string,
  purpose: VerificationPurpose,
): Promise<string | null> {
  const deliveryEmail = getStagingEmailOrOriginal(email);

  logDevBanner("MAGIC LINK", {
    Email: email,
    ...(deliveryEmail !== email ? { "Delivers to": deliveryEmail } : {}),
    Purpose: purpose,
    URL: magicLinkUrl,
  });

  const subject =
    purpose === "invitation"
      ? "Complete your Pi Surveying account setup"
      : "Sign in to Pi Surveying";

  return sendEmail({
    to: email,
    subject,
    html: magicLinkEmailHtml(magicLinkUrl, purpose),
  });
}

export async function sendOtpEmail(
  email: string,
  code: string,
  purpose: VerificationPurpose,
): Promise<string | null> {
  const deliveryEmail = getStagingEmailOrOriginal(email);

  logDevBanner("OTP CODE", {
    Email: email,
    ...(deliveryEmail !== email ? { "Delivers to": deliveryEmail } : {}),
    Purpose: purpose,
    Code: code,
  });

  const subject =
    purpose === "invitation"
      ? `Your Pi Surveying verification code: ${code}`
      : `Your Pi Surveying sign-in code: ${code}`;

  return sendEmail({
    to: email,
    subject,
    html: otpEmailHtml(code, purpose),
  });
}

// ─── Error extraction ───────────────────────────────────────────────────────

function extractSendGridError(err: unknown): string {
  if (err instanceof Error) {
    const sgErr = err as Error & {
      response?: { body?: { errors?: Array<{ message: string }> } };
    };
    const nested = sgErr.response?.body?.errors;
    if (Array.isArray(nested) && nested.length > 0) {
      return nested.map((e) => e.message).join("; ");
    }
    return sgErr.message;
  }
  return String(err);
}

// ─── Order Created Notification Email ───────────────────────────────────────

export interface OrderCreatedEmailParams {
  orderNumber: string;
  clientName: string;
  propertyAddress: string;
  surveyType: string;
  price: string;
  orderId: string;
}

export async function sendOrderCreatedEmail(
  params: OrderCreatedEmailParams,
): Promise<void> {
  const hollyEmail = envStore.HOLLY_EMAIL;
  if (!hollyEmail) {
    logger.warn("[Email] HOLLY_EMAIL not configured, skipping order created email", {
      orderId: params.orderId,
      orderNumber: params.orderNumber,
    });
    return;
  }

  const { orderNumber, clientName, propertyAddress, surveyType, price, orderId } = params;

  const portalUrl = `${envStore.FRONTEND_URL}/orders/${orderId}`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>New Order Created</title></head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <div style="background: #FF8401; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">New Order Created</h1>
  </div>
  <div style="background: #f9f9f9; padding: 24px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px;">
    <p style="margin-top: 0;">A new order has been created and is ready for processing.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <td style="padding: 8px; font-weight: bold; color: #666; width: 40%;">Order Number</td>
        <td style="padding: 8px; font-weight: bold; color: #FF8401;">#${orderNumber}</td>
      </tr>
      <tr style="background: #fff;">
        <td style="padding: 8px; font-weight: bold; color: #666;">Client</td>
        <td style="padding: 8px;">${clientName}</td>
      </tr>
      <tr>
        <td style="padding: 8px; font-weight: bold; color: #666;">Property</td>
        <td style="padding: 8px;">${propertyAddress}</td>
      </tr>
      <tr style="background: #fff;">
        <td style="padding: 8px; font-weight: bold; color: #666;">Survey Type</td>
        <td style="padding: 8px;">${surveyType}</td>
      </tr>
      <tr>
        <td style="padding: 8px; font-weight: bold; color: #666;">Price</td>
        <td style="padding: 8px;">$${price}</td>
      </tr>
    </table>
    <div style="text-align: center; margin: 24px 0;">
      <a href="${portalUrl}" style="background: #FF8401; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; display: inline-block;">View Order Details</a>
    </div>
    <p style="color: #888; font-size: 12px; margin-bottom: 0;">Pi Surveying Portal &mdash; Internal Notification</p>
  </div>
</body>
</html>`;

  try {
    await sendEmail({
      to: hollyEmail,
      subject: `New Order #${orderNumber} — ${clientName}`,
      html,
    });
    logger.info("[Email] Order created email sent to Holly", {
      orderNumber,
      orderId,
      to: hollyEmail,
    });
  } catch (error) {
    logger.error("[Email] Failed to send order created email to Holly", {
      error: error instanceof Error ? error.message : String(error),
      orderNumber,
      orderId,
    });
  }
}

// ─── Order Confirmation Email (Client-Facing) ────────────────────────────────

function formatDateForEmail(date: Date | null | undefined): string | undefined {
  if (!date) return undefined;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export async function sendOrderConfirmationEmail(
  params: OrderConfirmationEmailParams,
): Promise<void> {
  const { clientEmail, orderNumber, clientFirstName, clientLastName } = params;

  if (!clientEmail || clientEmail.trim() === "") {
    logger.info("[Email] Order confirmation skipped (no client email)", {
      orderNumber,
    });
    return;
  }

  const onsiteContactName =
    params.onsiteContactFirstName || params.onsiteContactLastName
      ? `${params.onsiteContactFirstName ?? ""} ${params.onsiteContactLastName ?? ""}`.trim()
      : undefined;

  const html = orderConfirmationEmailHtml({
    orderNumber,
    clientFirstName: clientFirstName || "there",
    surveyType: params.surveyType,
    propertyAddressLine1: params.propertyAddressLine1,
    propertyAddressLine2: params.propertyAddressLine2,
    propertyCity: params.propertyCity,
    propertyState: params.propertyState,
    propertyZip: params.propertyZip,
    propertyCounty: params.propertyCounty,
    pin: params.pin,
    closingDate: formatDateForEmail(params.closingDate),
    deliveryPreference: params.deliveryPreference ?? undefined,
    onsiteContactName,
    onsiteContactPhone: params.onsiteContactPhone ?? undefined,
  });

  const clientName =
    clientFirstName && clientLastName
      ? `${clientFirstName} ${clientLastName}`
      : clientFirstName || undefined;

  logger.info("[Email] Sending order confirmation to client", {
    orderNumber,
    clientEmail,
    clientName,
  });

  try {
    await sendEmail({
      to: clientName ? { email: clientEmail, name: clientName } : clientEmail,
      subject: `Your Pi Surveying Order #${orderNumber} - Confirmed`,
      html,
    });
    logger.info("[Email] Order confirmation sent to client", {
      orderNumber,
      clientEmail,
    });
  } catch (error) {
    logger.error("[Email] Failed to send order confirmation to client", {
      error: error instanceof Error ? error.message : String(error),
      orderNumber,
      clientEmail,
    });
  }
}
