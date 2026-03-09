/**
 * Pi Surveying — Branded email templates (SendGrid Transactional)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Immediate, event-triggered emails sent directly via SendGrid in 
 * response to user actions. Single email per trigger event.
 * 
 * TEMPLATES IN THIS FILE:
 * - magicLinkEmailHtml()           → User requests sign-in link
 * - otpEmailHtml()                 → User requests OTP for auth  
 * - orderConfirmationEmailHtml()   → Order created (client-facing)
 * - orderFormReminder1Html()       → Day 1 abandoned-form reminder
 * - orderFormReminder2Html()       → Day 2 abandoned-form reminder
 * - orderFormReminder3Html()       → Day 3 abandoned-form reminder
 * - orderFormReminder4Html()       → Day 4 final abandoned-form reminder
 * 
 * For Customer.io event-driven sequences (drip campaigns, nurturing, reminders),
 * see: backend/src/services/customerio.service.ts
 * 
 * Brand primary: #FF8401 (orange), hover: #E67601
 * All templates use inline styles for maximum email client compatibility.
 */

import type { VerificationPurpose } from "./verification.service";

// ─── Display Label Mappings ─────────────────────────────────────────────────

const SURVEY_TYPE_LABELS: Record<string, string> = {
  boundary: "Boundary Survey",
  alta: "ALTA/NSPS Survey",
  condominium: "Condominium Survey",
  topography: "Topographic Survey",
  other: "Land Survey",
};

export function getSurveyTypeLabel(value: string): string {
  return SURVEY_TYPE_LABELS[value] ?? value;
}

// ─── Site Access Notification ────────────────────────────────────────────────

interface SiteAccessParams {
  propertyAddress: string;
  fieldDate: string;
  visitWindowStart: string;
  visitWindowEnd: string;
  siteContactName: string;
  jobNumber: string;
  siteContactPhone?: string;
}

export function siteAccessNotificationHtml(p: SiteAccessParams): string {
  return layout(`
    <h2 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#18181B;">Site Visit Notice</h2>
    <p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#3F3F46;">
      Dear ${p.siteContactName},
    </p>
    <p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#3F3F46;">
      Pi Surveying will be conducting a land survey at the property below. Please ensure site access is available during the stated window.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:12px 16px;background:#F4F4F5;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#71717A;">Property</td></tr>
      <tr><td style="padding:12px 16px;font-size:15px;color:#18181B;">${p.propertyAddress}</td></tr>
      <tr><td style="padding:12px 16px;background:#F4F4F5;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#71717A;">Scheduled Date</td></tr>
      <tr><td style="padding:12px 16px;font-size:15px;color:#18181B;">${p.fieldDate}</td></tr>
      <tr><td style="padding:12px 16px;background:#F4F4F5;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#71717A;">Visit Window</td></tr>
      <tr><td style="padding:12px 16px;font-size:15px;color:#18181B;">${p.visitWindowStart} – ${p.visitWindowEnd}</td></tr>
    </table>
    <p style="margin:0 0 8px;font-size:14px;line-height:22px;color:#71717A;">
      If you have any questions or need to reschedule, please call us at
      <strong style="color:#18181B;">${p.siteContactPhone ?? "our office"}</strong> or reply to this email.
    </p>
    <p style="margin:0;font-size:12px;color:#A1A1AA;">Job reference: ${p.jobNumber}</p>
  `);
}

// ─── Route Notifications ─────────────────────────────────────────────────────

interface RoutePublishedParams {
  crewName: string;
  routeDate: string;
  jobs: Array<{ jobNumber: string; address: string }>;
}

export function routePublishedNotificationHtml(p: RoutePublishedParams): string {
  const jobRows = p.jobs
    .map(
      (j, i) => `<tr>
        <td style="padding:8px 12px;font-size:13px;color:#71717A;border-bottom:1px solid #F4F4F5;">${i + 1}.</td>
        <td style="padding:8px 12px;font-size:13px;font-weight:600;color:#18181B;border-bottom:1px solid #F4F4F5;">${j.jobNumber}</td>
        <td style="padding:8px 12px;font-size:13px;color:#3F3F46;border-bottom:1px solid #F4F4F5;">${j.address}</td>
      </tr>`
    )
    .join("");

  return layout(`
    <h2 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#18181B;">Route Published</h2>
    <p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#3F3F46;">
      Hi ${p.crewName}, your route for <strong>${p.routeDate}</strong> has been published.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;margin-bottom:20px;">
      <thead>
        <tr style="background:#F4F4F5;">
          <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717A;">#</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717A;">Job</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717A;">Address</th>
        </tr>
      </thead>
      <tbody>${jobRows}</tbody>
    </table>
  `);
}

export function routeCancelledNotificationHtml(p: {
  crewName: string;
  routeDate: string;
  reason: string;
}): string {
  return layout(`
    <h2 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#18181B;">Route Cancelled</h2>
    <p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#3F3F46;">
      Hi ${p.crewName}, your route scheduled for <strong>${p.routeDate}</strong> has been cancelled.
    </p>
    <p style="margin:0 0 8px;font-size:14px;line-height:22px;color:#71717A;">
      <strong>Reason:</strong> ${p.reason}
    </p>
    <p style="margin:0;font-size:14px;line-height:22px;color:#71717A;">
      Please check the app for updates. If you have questions, contact your crew manager.
    </p>
  `);
}

// ─── Route Reminder Notification (24h before) ───────────────────────────────

export function routeReminderNotificationHtml(p: {
  crewName: string;
  routeDate: string;
  jobs: Array<{ jobNumber: string; address: string }>;
  estimatedDriveTime?: number | null;
}): string {
  const jobRows = p.jobs
    .map(
      (j, i) => `<tr>
        <td style="padding:8px 12px;font-size:13px;color:#71717A;border-bottom:1px solid #F4F4F5;">${i + 1}.</td>
        <td style="padding:8px 12px;font-size:13px;font-weight:600;color:#18181B;border-bottom:1px solid #F4F4F5;">${j.jobNumber}</td>
        <td style="padding:8px 12px;font-size:13px;color:#3F3F46;border-bottom:1px solid #F4F4F5;">${j.address}</td>
      </tr>`
    )
    .join("");

  const driveTimeLine = p.estimatedDriveTime
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:22px;color:#71717A;">Estimated total drive time: <strong>${p.estimatedDriveTime} minutes</strong></p>`
    : "";

  return layout(`
    <h2 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#18181B;">Route Reminder — Tomorrow</h2>
    <p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#3F3F46;">
      Hi ${p.crewName}, this is a reminder that you have a route scheduled for <strong>${p.routeDate}</strong>.
    </p>
    ${driveTimeLine}
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;margin-bottom:20px;">
      <thead>
        <tr style="background:#F4F4F5;">
          <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717A;">#</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717A;">Job</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717A;">Address</th>
        </tr>
      </thead>
      <tbody>${jobRows}</tbody>
    </table>
    <p style="margin:0;font-size:14px;line-height:22px;color:#71717A;">
      Please review your route and prepare for field work. Contact your crew manager if you have any questions.
    </p>
  `);
}

// ─── Route Updated Notification ─────────────────────────────────────────────

export function routeUpdatedNotificationHtml(p: {
  crewName: string;
  routeDate: string;
  changeDescription: string;
  frontendUrl: string;
}): string {
  return layout(`
    <h2 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#18181B;">Route Updated</h2>
    <p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#3F3F46;">
      Hi ${p.crewName}, your route for <strong>${p.routeDate}</strong> has been updated.
    </p>
    <p style="margin:0 0 16px;font-size:14px;line-height:22px;color:#71717A;">
      <strong>Change:</strong> ${p.changeDescription}
    </p>
    ${ctaButton(p.frontendUrl, "View Updated Route")}
  `);
}

// ─── Chat Mention (PLS Assistant) ────────────────────────────────────────────

export function chatMentionPLSAssistantHtml(p: {
  mentionedByName: string;
  jobNumber: string;
  propertyAddress: string;
  messageExcerpt: string;
  jobUrl: string;
}): string {
  const truncated = p.messageExcerpt.length > 500
    ? p.messageExcerpt.slice(0, 497) + "..."
    : p.messageExcerpt;

  return layout(`
    <h2 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#18181B;">You were mentioned in a job chat</h2>
    <p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#3F3F46;">
      <strong>${p.mentionedByName}</strong> mentioned you in the chat for
      <strong>Job #${p.jobNumber}</strong> — ${p.propertyAddress}.
    </p>
    <div style="background:#F4F4F5;border-left:4px solid #FF8401;padding:12px 16px;margin:0 0 20px;border-radius:4px;">
      <p style="margin:0;font-size:14px;line-height:22px;color:#3F3F46;font-style:italic;">"${truncated}"</p>
    </div>
    ${ctaButton(p.jobUrl, "View Job Chat")}
  `);
}

const DELIVERY_PREFERENCE_LABELS: Record<string, string> = {
  pdf_only: "PDF via Email",
  pdf_usps: "PDF + USPS Mail",
  pdf_fedex: "PDF + FedEx",
};

export function getDeliveryPreferenceLabel(value: string): string {
  return DELIVERY_PREFERENCE_LABELS[value] ?? value;
}

// ─── Shared Layout Components ───────────────────────────────────────────────

function layout(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pi Surveying</title>
</head>
<body style="margin:0;padding:0;background-color:#F4F4F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F4F5;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background-color:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <!-- Header bar -->
          <tr>
            <td style="background-color:#FF8401;padding:24px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-size:20px;font-weight:700;color:#FFFFFF;letter-spacing:-0.3px;">Pi Surveying</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:0 32px 28px 32px;border-top:1px solid #E4E4E7;">
              <p style="margin:20px 0 0;font-size:12px;line-height:18px;color:#71717A;text-align:center;">
                &copy; ${new Date().getFullYear()} Pi Surveying &middot; All rights reserved
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function ctaButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto;">
  <tr>
    <td align="center" style="background-color:#FF8401;border-radius:8px;">
      <a href="${href}" target="_blank" style="display:inline-block;padding:14px 36px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">
        ${label}
      </a>
    </td>
  </tr>
</table>`;
}

// ─── Magic Link Email ───────────────────────────────────────────────────────

export function magicLinkEmailHtml(
  magicLinkUrl: string,
  purpose: VerificationPurpose,
): string {
  const isInvitation = purpose === "invitation";
  const heading = isInvitation
    ? "Complete your account setup"
    : "Sign in to Pi Surveying";
  const intro = isInvitation
    ? "You've been invited to join the Pi Surveying team. Click the button below to verify your email and activate your account."
    : "Click the button below to securely sign in. No password needed.";

  return layout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181B;line-height:28px;">${heading}</h1>
    <p style="margin:0 0 4px;font-size:15px;line-height:24px;color:#71717A;">${intro}</p>
    ${ctaButton(magicLinkUrl, isInvitation ? "Verify &amp; Activate" : "Sign in to Pi Surveying")}
    <p style="margin:0;font-size:13px;line-height:20px;color:#A1A1AA;">This link expires in <strong style="color:#71717A;">15 minutes</strong> and can only be used once. If you didn't request this, you can safely ignore this email.</p>
    <p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#A1A1AA;">Or copy and paste this URL into your browser:</p>
    <p style="margin:6px 0 0;font-size:12px;line-height:18px;color:#FF8401;word-break:break-all;">${magicLinkUrl}</p>
  `);
}

// ─── OTP Code Email ─────────────────────────────────────────────────────────

export function otpEmailHtml(
  code: string,
  purpose: VerificationPurpose,
): string {
  const isInvitation = purpose === "invitation";
  const heading = isInvitation
    ? "Your verification code"
    : "Your sign-in code";
  const intro = isInvitation
    ? "Enter this code on the setup page to verify your email and activate your Pi Surveying account."
    : "Enter this code on the sign-in page to access Pi Surveying.";

  return layout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181B;line-height:28px;">${heading}</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#71717A;">${intro}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
      <tr>
        <td align="center" style="background-color:#FFF3E6;border:2px solid #FF8401;border-radius:12px;padding:20px 40px;">
          <span style="font-size:36px;font-weight:700;color:#18181B;letter-spacing:8px;font-family:'Courier New',Courier,monospace;">${code}</span>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:13px;line-height:20px;color:#A1A1AA;">This code expires in <strong style="color:#71717A;">10 minutes</strong>. If you didn't request this, you can safely ignore this email.</p>
  `);
}

// ─── Order Confirmation Email ────────────────────────────────────────────────

export interface OrderConfirmationTemplateParams {
  orderNumber: string;
  clientFirstName: string;
  surveyType: string;
  propertyAddressLine1: string;
  propertyAddressLine2?: string;
  propertyCity: string;
  propertyState: string;
  propertyZip: string;
  propertyCounty?: string;
  pin: string;
  closingDate?: string;
  deliveryPreference?: string;
  onsiteContactName?: string;
  onsiteContactPhone?: string;
}

export function orderConfirmationEmailHtml(
  params: OrderConfirmationTemplateParams,
): string {
  const {
    orderNumber,
    clientFirstName,
    surveyType,
    propertyAddressLine1,
    propertyAddressLine2,
    propertyCity,
    propertyState,
    propertyZip,
    propertyCounty,
    pin,
    closingDate,
    deliveryPreference,
    onsiteContactName,
    onsiteContactPhone,
  } = params;

  const surveyTypeLabel = getSurveyTypeLabel(surveyType);
  const deliveryLabel = deliveryPreference
    ? getDeliveryPreferenceLabel(deliveryPreference)
    : null;

  const fullAddress = [
    propertyAddressLine1,
    propertyAddressLine2,
    `${propertyCity}, ${propertyState} ${propertyZip}`,
  ]
    .filter(Boolean)
    .join("<br/>");

  const detailRows: Array<{ label: string; value: string }> = [
    { label: "Survey Type", value: surveyTypeLabel },
    { label: "Property", value: fullAddress },
  ];

  if (propertyCounty) {
    detailRows.push({ label: "County", value: propertyCounty });
  }

  detailRows.push({ label: "PIN / Parcel ID", value: pin });

  if (closingDate) {
    detailRows.push({ label: "Closing Date", value: closingDate });
  }

  if (deliveryLabel) {
    detailRows.push({ label: "Delivery", value: deliveryLabel });
  }

  const detailsHtml = detailRows
    .map(
      (row, i) => `
      <tr style="background-color:${i % 2 === 0 ? "#FFFFFF" : "#F9FAFB"};">
        <td style="padding:12px 16px;font-size:14px;color:#71717A;font-weight:500;width:40%;border-bottom:1px solid #E4E4E7;">${row.label}</td>
        <td style="padding:12px 16px;font-size:14px;color:#18181B;border-bottom:1px solid #E4E4E7;word-break:break-word;">${row.value}</td>
      </tr>`,
    )
    .join("");

  const onsiteSection =
    onsiteContactName || onsiteContactPhone
      ? `
    <div style="margin-top:24px;">
      <h3 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">On-Site Contact</h3>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;">
        ${onsiteContactName ? `<tr style="background-color:#FFFFFF;"><td style="padding:12px 16px;font-size:14px;color:#71717A;font-weight:500;width:40%;border-bottom:1px solid #E4E4E7;">Name</td><td style="padding:12px 16px;font-size:14px;color:#18181B;border-bottom:1px solid #E4E4E7;">${onsiteContactName}</td></tr>` : ""}
        ${onsiteContactPhone ? `<tr style="background-color:#F9FAFB;"><td style="padding:12px 16px;font-size:14px;color:#71717A;font-weight:500;width:40%;">Phone</td><td style="padding:12px 16px;font-size:14px;color:#18181B;">${onsiteContactPhone}</td></tr>` : ""}
      </table>
    </div>`
      : "";

  return layout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181B;line-height:28px;">Order Confirmation</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#71717A;">Hi ${clientFirstName},</p>
    <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#71717A;">Thank you for your order! We've received your survey request and will be in touch within 1-2 business days to confirm scheduling and payment details.</p>
    
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;width:100%;">
      <tr>
        <td align="center" style="background-color:#FFF3E6;border:2px solid #FF8401;border-radius:12px;padding:20px;">
          <span style="font-size:13px;font-weight:500;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">Order Number</span>
          <br/>
          <span style="font-size:32px;font-weight:700;color:#FF8401;letter-spacing:-0.5px;">#${orderNumber}</span>
        </td>
      </tr>
    </table>

    <div style="margin-bottom:24px;">
      <h3 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">Order Details</h3>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;">
        ${detailsHtml}
      </table>
    </div>

    ${onsiteSection}

    <p style="margin:28px 0 0;font-size:13px;line-height:20px;color:#A1A1AA;">Questions? Simply reply to this email or call us — we're happy to help.</p>
  `);
}

// ─── Admin Order Notification Email ─────────────────────────────────────────

export interface AdminOrderNotificationTemplateParams {
  orderNumber: string;
  clientName: string;
  surveyType: string;
  propertyAddressLine1: string;
  propertyAddressLine2?: string;
  propertyCity: string;
  propertyState: string;
  propertyZip: string;
  price?: number | string | null;
  source?: string | null;
  portalUrl: string;
}

export function adminOrderNotificationEmailHtml(
  params: AdminOrderNotificationTemplateParams,
): string {
  const {
    orderNumber,
    clientName,
    surveyType,
    propertyAddressLine1,
    propertyAddressLine2,
    propertyCity,
    propertyState,
    propertyZip,
    price,
    source,
    portalUrl,
  } = params;

  const surveyTypeLabel = getSurveyTypeLabel(surveyType);

  const fullAddress = [
    propertyAddressLine1,
    propertyAddressLine2,
    `${propertyCity}, ${propertyState} ${propertyZip}`,
  ]
    .filter(Boolean)
    .join("<br/>");

  const sourceLabel =
    source === "website"
      ? "Public Website"
      : source === "quote_acceptance"
        ? "Quote Acceptance"
        : "Internal Portal";

  const detailRows: Array<{ label: string; value: string }> = [
    { label: "Client", value: clientName },
    { label: "Survey Type", value: surveyTypeLabel },
    { label: "Property", value: fullAddress },
    { label: "Source", value: sourceLabel },
  ];

  if (price != null && Number(price) > 0) {
    detailRows.push({
      label: "Price",
      value: `$${Number(price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    });
  }

  const detailsHtml = detailRows
    .map(
      (row, i) => `
      <tr style="background-color:${i % 2 === 0 ? "#FFFFFF" : "#F9FAFB"};">
        <td style="padding:12px 16px;font-size:14px;color:#71717A;font-weight:500;width:40%;border-bottom:1px solid #E4E4E7;">${row.label}</td>
        <td style="padding:12px 16px;font-size:14px;color:#18181B;border-bottom:1px solid #E4E4E7;word-break:break-word;">${row.value}</td>
      </tr>`,
    )
    .join("");

  return layout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181B;line-height:28px;">New Order Received</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#71717A;">A new order has been submitted and is ready for review.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;width:100%;">
      <tr>
        <td align="center" style="background-color:#FFF3E6;border:2px solid #FF8401;border-radius:12px;padding:20px;">
          <span style="font-size:13px;font-weight:500;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">Order Number</span>
          <br/>
          <span style="font-size:32px;font-weight:700;color:#FF8401;letter-spacing:-0.5px;">#${orderNumber}</span>
        </td>
      </tr>
    </table>

    <div style="margin-bottom:28px;">
      <h3 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">Order Details</h3>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;">
        ${detailsHtml}
      </table>
    </div>

    ${ctaButton(portalUrl, "View Order in Portal")}

    <p style="margin:0;font-size:13px;line-height:20px;color:#A1A1AA;">Pi Surveying Portal &mdash; Internal Notification</p>
  `);
}

// ─── Admin Quote Notification Email ─────────────────────────────────────────

export interface AdminQuoteNotificationTemplateParams {
  quoteNumber: string;
  clientName: string;
  surveyType: string;
  propertyAddressLine1: string;
  propertyAddressLine2?: string;
  propertyCity: string;
  propertyState: string;
  propertyZip: string;
  source?: string | null;
  portalUrl: string;
}

export function adminQuoteNotificationEmailHtml(
  params: AdminQuoteNotificationTemplateParams,
): string {
  const {
    quoteNumber,
    clientName,
    surveyType,
    propertyAddressLine1,
    propertyAddressLine2,
    propertyCity,
    propertyState,
    propertyZip,
    source,
    portalUrl,
  } = params;

  const surveyTypeLabel = getSurveyTypeLabel(surveyType);

  const fullAddress = [
    propertyAddressLine1,
    propertyAddressLine2,
    `${propertyCity}, ${propertyState} ${propertyZip}`,
  ]
    .filter(Boolean)
    .join("<br/>");

  const sourceLabel =
    source === "website"
      ? "Public Website"
      : source === "quote_acceptance"
        ? "Quote Acceptance"
        : "Internal Portal";

  const detailRows: Array<{ label: string; value: string }> = [
    { label: "Client", value: clientName },
    { label: "Survey Type", value: surveyTypeLabel },
    { label: "Property", value: fullAddress },
    { label: "Source", value: sourceLabel },
  ];

  const detailsHtml = detailRows
    .map(
      (row, i) => `
      <tr style="background-color:${i % 2 === 0 ? "#FFFFFF" : "#F9FAFB"};">
        <td style="padding:12px 16px;font-size:14px;color:#71717A;font-weight:500;width:40%;border-bottom:1px solid #E4E4E7;">${row.label}</td>
        <td style="padding:12px 16px;font-size:14px;color:#18181B;border-bottom:1px solid #E4E4E7;word-break:break-word;">${row.value}</td>
      </tr>`,
    )
    .join("");

  return layout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181B;line-height:28px;">New Quote Received</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#71717A;">A new quote request has been submitted and is ready for review.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;width:100%;">
      <tr>
        <td align="center" style="background-color:#FFF3E6;border:2px solid #FF8401;border-radius:12px;padding:20px;">
          <span style="font-size:13px;font-weight:500;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">Quote Number</span>
          <br/>
          <span style="font-size:32px;font-weight:700;color:#FF8401;letter-spacing:-0.5px;">#${quoteNumber}</span>
        </td>
      </tr>
    </table>

    <div style="margin-bottom:28px;">
      <h3 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">Quote Details</h3>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;">
        ${detailsHtml}
      </table>
    </div>

    ${ctaButton(portalUrl, "View Quote in Portal")}

    <p style="margin:0;font-size:13px;line-height:20px;color:#A1A1AA;">Pi Surveying Portal &mdash; Internal Notification</p>
  `);
}

// ─── Order Form Abandoned — Reminder Sequence ────────────────────────────────
//
// Four-day drip triggered by ORDER_FORM_STARTED when ORDER_FORM_COMPLETED has
// not fired. Paste these HTML bodies into the corresponding Customer.io
// campaign templates. Available event attributes:
//   {{first_name}}       – client first name
//   {{form_resume_url}}  – pre-filled link back to the public order form
//   {{order_number}}     – draft order number

export interface OrderFormReminderParams {
  clientFirstName: string;
  formResumeUrl: string;
  orderNumber: string;
}

// ─── Day 1 ────────────────────────────────────────────────────────────────────
// Subject: "You're almost there — finish your survey order"
// Send: ~4 hours after ORDER_FORM_STARTED (while intent is fresh)

export function orderFormReminder1Html(params: OrderFormReminderParams): string {
  const { clientFirstName, formResumeUrl, orderNumber } = params;
  return layout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181B;line-height:28px;">You're almost there, ${clientFirstName}!</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:24px;color:#71717A;">
      We noticed you started a survey order but haven't quite finished — no worries, your progress has been saved and it takes just a few minutes to complete.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;width:100%;">
      <tr>
        <td align="center" style="background-color:#FFF3E6;border:2px solid #FF8401;border-radius:12px;padding:16px 20px;">
          <span style="font-size:12px;font-weight:500;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">Draft Order</span>
          <br/>
          <span style="font-size:26px;font-weight:700;color:#FF8401;letter-spacing:-0.5px;">#${orderNumber}</span>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 4px;font-size:15px;line-height:24px;color:#71717A;">
      Simply click below to pick up right where you left off:
    </p>
    ${ctaButton(formResumeUrl, "Continue My Order")}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;margin:0 0 24px;">
      <tr style="background-color:#FFFFFF;">
        <td style="padding:12px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:28px;vertical-align:top;padding-right:10px;">
                <div style="width:20px;height:20px;background-color:#FFF3E6;border-radius:50%;text-align:center;line-height:20px;">
                  <span style="font-size:11px;color:#FF8401;font-weight:700;">1</span>
                </div>
              </td>
              <td style="font-size:14px;color:#3F3F46;">Fill in property &amp; survey details</td>
            </tr>
          </table>
        </td>
      </tr>
      <tr style="background-color:#F9FAFB;">
        <td style="padding:12px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:28px;vertical-align:top;padding-right:10px;">
                <div style="width:20px;height:20px;background-color:#FFF3E6;border-radius:50%;text-align:center;line-height:20px;">
                  <span style="font-size:11px;color:#FF8401;font-weight:700;">2</span>
                </div>
              </td>
              <td style="font-size:14px;color:#3F3F46;">Review and submit</td>
            </tr>
          </table>
        </td>
      </tr>
      <tr style="background-color:#FFFFFF;">
        <td style="padding:12px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:28px;vertical-align:top;padding-right:10px;">
                <div style="width:20px;height:20px;background-color:#FFF3E6;border-radius:50%;text-align:center;line-height:20px;">
                  <span style="font-size:11px;color:#FF8401;font-weight:700;">3</span>
                </div>
              </td>
              <td style="font-size:14px;color:#3F3F46;">We'll reach out within 1–2 business days to confirm</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:0;font-size:13px;line-height:20px;color:#A1A1AA;">Have questions? Simply reply to this email — we're here to help.</p>
  `);
}

// ─── Day 2 ────────────────────────────────────────────────────────────────────
// Subject: "Your survey order is still waiting for you"
// Send: 24 hours after ORDER_FORM_STARTED

export function orderFormReminder2Html(params: OrderFormReminderParams): string {
  const { clientFirstName, formResumeUrl, orderNumber } = params;
  return layout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181B;line-height:28px;">Your order is still saved, ${clientFirstName}</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:24px;color:#71717A;">
      Good news — your draft is exactly where you left it. All of your contact information is already filled in, so finishing takes just a couple of minutes.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;width:100%;">
      <tr>
        <td style="background-color:#F9FAFB;border:1px solid #E4E4E7;border-radius:10px;padding:20px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding-bottom:10px;border-bottom:1px solid #E4E4E7;">
                <span style="font-size:12px;font-weight:600;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">Draft Order &nbsp;</span>
                <span style="font-size:14px;font-weight:700;color:#FF8401;">#${orderNumber}</span>
              </td>
            </tr>
            <tr>
              <td style="padding-top:12px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="font-size:13px;color:#71717A;padding-bottom:6px;">&#10003;&nbsp; Contact information saved</td>
                  </tr>
                  <tr>
                    <td style="font-size:13px;color:#A1A1AA;padding-bottom:6px;">&#9675;&nbsp; Property details — not yet entered</td>
                  </tr>
                  <tr>
                    <td style="font-size:13px;color:#A1A1AA;padding-bottom:6px;">&#9675;&nbsp; Survey type &amp; scheduling — not yet entered</td>
                  </tr>
                  <tr>
                    <td style="font-size:13px;color:#A1A1AA;">&#9675;&nbsp; On-site contact — not yet entered</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 4px;font-size:15px;line-height:24px;color:#71717A;">Ready to finish? Your saved form is one click away:</p>
    ${ctaButton(formResumeUrl, "Finish My Order")}

    <p style="margin:0;font-size:13px;line-height:20px;color:#A1A1AA;">Questions or need help with any step? Reply to this email and we'll walk you through it.</p>
  `);
}

// ─── Day 3 ────────────────────────────────────────────────────────────────────
// Subject: "Can we help you finish your survey order?"
// Send: 48 hours after ORDER_FORM_STARTED

export function orderFormReminder3Html(params: OrderFormReminderParams): string {
  const { clientFirstName, formResumeUrl, orderNumber } = params;
  return layout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181B;line-height:28px;">Need a hand, ${clientFirstName}?</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#71717A;">
      We're following up on your survey order <strong style="color:#18181B;">#${orderNumber}</strong>. If something stopped you from finishing — a question about the form, uncertainty about the survey type, or anything else — we're happy to help.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;margin:0 0 28px;">
      <tr style="background-color:#FFFFFF;">
        <td style="padding:14px 20px;border-bottom:1px solid #E4E4E7;">
          <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#18181B;">Not sure which survey type you need?</p>
          <p style="margin:0;font-size:13px;color:#71717A;">Reply to this email and we'll point you in the right direction — no pressure.</p>
        </td>
      </tr>
      <tr style="background-color:#F9FAFB;">
        <td style="padding:14px 20px;border-bottom:1px solid #E4E4E7;">
          <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#18181B;">Don't have your PIN / Parcel ID handy?</p>
          <p style="margin:0;font-size:13px;color:#71717A;">You can find it on your property tax bill or through your county assessor's website. We can also look it up for you.</p>
        </td>
      </tr>
      <tr style="background-color:#FFFFFF;">
        <td style="padding:14px 20px;">
          <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#18181B;">Have a tight deadline?</p>
          <p style="margin:0;font-size:13px;color:#71717A;">Let us know your closing or project date in the form — we'll do our best to accommodate rush requests.</p>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 4px;font-size:15px;line-height:24px;color:#71717A;">Your progress is still saved — continue whenever you're ready:</p>
    ${ctaButton(formResumeUrl, "Complete My Order")}

    <p style="margin:0;font-size:13px;line-height:20px;color:#A1A1AA;">Prefer to talk to someone? Simply reply to this email and a member of our team will get back to you.</p>
  `);
}

// ─── Day 4 ────────────────────────────────────────────────────────────────────
// Subject: "Last reminder: your Pi Surveying order draft"
// Send: 72 hours after ORDER_FORM_STARTED (final email in sequence)

export function orderFormReminder4Html(params: OrderFormReminderParams): string {
  const { clientFirstName, formResumeUrl, orderNumber } = params;
  return layout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181B;line-height:28px;">One last reminder, ${clientFirstName}</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:24px;color:#71717A;">
      This is our final follow-up on your saved survey order. Your draft <strong style="color:#18181B;">#${orderNumber}</strong> is still on file — submit it today and we'll get your survey scheduled.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;width:100%;">
      <tr>
        <td align="center" style="background-color:#FFF3E6;border:2px solid #FF8401;border-radius:12px;padding:20px 24px;">
          <span style="font-size:13px;font-weight:500;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">Saved Draft</span>
          <br/>
          <span style="font-size:32px;font-weight:700;color:#FF8401;letter-spacing:-0.5px;">#${orderNumber}</span>
          <br/>
          <span style="font-size:13px;color:#A1A1AA;margin-top:4px;display:inline-block;">Ready to complete</span>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 4px;font-size:15px;line-height:24px;color:#71717A;">
      Once submitted, our team will review your order and follow up within <strong style="color:#18181B;">1–2 business days</strong> with scheduling and pricing details.
    </p>
    ${ctaButton(formResumeUrl, "Submit My Order Now")}

    <p style="margin:0 0 8px;font-size:13px;line-height:20px;color:#A1A1AA;">After this email we won't send any more reminders about this draft. If you decide to order a survey in the future, you're always welcome to start a new request at any time.</p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#A1A1AA;">Questions? Reply to this email or give us a call — we're happy to help you get started.</p>
  `);
}

// ─── Research Escalation Email ──────────────────────────────────────────────

interface ResearchEscalationParams {
  orderNumber: string;
  propertyAddress: string;
  missingDocLabels: string[];
  note?: string;
  escalatedByName: string;
  portalUrl: string;
}

export function researchEscalationEmailHtml(p: ResearchEscalationParams): string {
  const missingList = p.missingDocLabels
    .map((label) => `<li style="margin:0 0 6px;font-size:14px;color:#3F3F46;">${label}</li>`)
    .join("");

  const noteSection = p.note
    ? `<div style="margin:16px 0;padding:12px 16px;background-color:#FEF3C7;border-radius:6px;border-left:4px solid #F59E0B;">
        <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#92400E;text-transform:uppercase;">Note from ${p.escalatedByName}</p>
        <p style="margin:0;font-size:14px;color:#78350F;">${p.note}</p>
      </div>`
    : "";

  return layout(`
    <h2 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#18181B;">Missing Documents Escalation</h2>
    <p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#3F3F46;">
      <strong>${p.escalatedByName}</strong> has escalated missing documents for
      <strong>Order #${p.orderNumber}</strong>.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;margin:0 0 20px;">
      <tr style="background-color:#F4F4F5;">
        <td style="padding:10px 16px;">
          <p style="margin:0;font-size:12px;font-weight:600;color:#71717A;text-transform:uppercase;">Property Address</p>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 16px;">
          <p style="margin:0;font-size:14px;color:#18181B;">${p.propertyAddress}</p>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 8px;font-size:14px;font-weight:600;color:#18181B;">Missing Documents (${p.missingDocLabels.length}):</p>
    <ul style="margin:0 0 20px;padding-left:20px;">
      ${missingList}
    </ul>

    ${noteSection}

    ${ctaButton(p.portalUrl, "View Order in Portal")}

    <p style="margin:0;font-size:13px;line-height:20px;color:#A1A1AA;">
      Please follow up to obtain the missing documents as soon as possible.
    </p>
  `);
}

// ─── Research Complete Notification Email ────────────────────────────────────

export interface ResearchCompleteTemplateParams {
  orderNumber: string;
  clientName: string;
  surveyType: string;
  propertyAddressLine1: string;
  propertyAddressLine2?: string;
  propertyCity: string;
  propertyState: string;
  propertyZip: string;
  portalUrl: string;
}

export function researchCompleteNotificationEmailHtml(
  params: ResearchCompleteTemplateParams,
): string {
  const {
    orderNumber,
    clientName,
    surveyType,
    propertyAddressLine1,
    propertyAddressLine2,
    propertyCity,
    propertyState,
    propertyZip,
    portalUrl,
  } = params;

  const surveyTypeLabel = getSurveyTypeLabel(surveyType);

  const fullAddress = [
    propertyAddressLine1,
    propertyAddressLine2,
    `${propertyCity}, ${propertyState} ${propertyZip}`,
  ]
    .filter(Boolean)
    .join("<br/>");

  const detailRows: Array<{ label: string; value: string }> = [
    { label: "Client", value: clientName },
    { label: "Survey Type", value: surveyTypeLabel },
    { label: "Property", value: fullAddress },
  ];

  const detailsHtml = detailRows
    .map(
      (row, i) => `
      <tr style="background-color:${i % 2 === 0 ? "#FFFFFF" : "#F9FAFB"};">
        <td style="padding:12px 16px;font-size:14px;color:#71717A;font-weight:500;width:40%;border-bottom:1px solid #E4E4E7;">${row.label}</td>
        <td style="padding:12px 16px;font-size:14px;color:#18181B;border-bottom:1px solid #E4E4E7;word-break:break-word;">${row.value}</td>
      </tr>`,
    )
    .join("");

  return layout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181B;line-height:28px;">Research Complete</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#71717A;">Research has been completed for the following order and is ready for the next stage.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;width:100%;">
      <tr>
        <td align="center" style="background-color:#FFF3E6;border:2px solid #FF8401;border-radius:12px;padding:20px;">
          <span style="font-size:13px;font-weight:500;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">Order Number</span>
          <br/>
          <span style="font-size:32px;font-weight:700;color:#FF8401;letter-spacing:-0.5px;">#${orderNumber}</span>
        </td>
      </tr>
    </table>

    <div style="margin-bottom:28px;">
      <h3 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">Order Details</h3>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;">
        ${detailsHtml}
      </table>
    </div>

    ${ctaButton(portalUrl, "View Order Details")}

    <p style="margin:0;font-size:13px;line-height:20px;color:#A1A1AA;">
      This order is ready for the next stage of processing.
    </p>
  `);
}

// ─── Crew Assignment Notification ─────────────────────────────────────────────

interface CrewAssignmentParams {
  jobNumber: string;
  fieldDate: string;
  propertyAddress: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  portalUrl: string;
}

export function crewAssignmentEmailHtml(p: CrewAssignmentParams): string {
  const detailRows: Array<{ label: string; value: string }> = [
    { label: "Job Number", value: `#${p.jobNumber}` },
    { label: "Field Date", value: p.fieldDate },
    { label: "Property", value: p.propertyAddress },
    { label: "Client", value: p.clientName },
    { label: "Client Email", value: p.clientEmail },
    { label: "Client Phone", value: p.clientPhone },
  ];

  const detailsHtml = detailRows
    .map(
      (row, i) => `
      <tr style="background-color:${i % 2 === 0 ? "#FFFFFF" : "#F9FAFB"};">
        <td style="padding:12px 16px;font-size:14px;color:#71717A;font-weight:500;width:40%;border-bottom:1px solid #E4E4E7;">${row.label}</td>
        <td style="padding:12px 16px;font-size:14px;color:#18181B;border-bottom:1px solid #E4E4E7;word-break:break-word;">${row.value}</td>
      </tr>`,
    )
    .join("");

  return layout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181B;line-height:28px;">Job Assigned to Your Crew</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#71717A;">You have been assigned a new job. Please review the details below.</p>

    <div style="margin-bottom:28px;">
      <h3 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">Job Details</h3>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;">
        ${detailsHtml}
      </table>
    </div>

    ${ctaButton(p.portalUrl, "View Job Details")}
  `);
}

// ─── Crew Reassignment Notification (Old Crew) ───────────────────────────────

interface CrewReassignmentParams {
  jobNumber: string;
  fieldDate: string;
  propertyAddress: string;
}

export function crewReassignmentEmailHtml(p: CrewReassignmentParams): string {
  return layout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181B;line-height:28px;">Job Reassigned</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#71717A;">The following job has been reassigned to another crew. You are no longer assigned to this job.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:12px 16px;background:#F4F4F5;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#71717A;">Job Number</td></tr>
      <tr><td style="padding:12px 16px;font-size:15px;color:#18181B;">#${p.jobNumber}</td></tr>
      <tr><td style="padding:12px 16px;background:#F4F4F5;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#71717A;">Field Date</td></tr>
      <tr><td style="padding:12px 16px;font-size:15px;color:#18181B;">${p.fieldDate}</td></tr>
      <tr><td style="padding:12px 16px;background:#F4F4F5;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#71717A;">Property</td></tr>
      <tr><td style="padding:12px 16px;font-size:15px;color:#18181B;">${p.propertyAddress}</td></tr>
    </table>

    <p style="margin:0;font-size:13px;line-height:20px;color:#A1A1AA;">
      If you believe this was done in error, please contact your crew manager.
    </p>
  `);
}

// ─── Crew Field Date Change Notification ──────────────────────────────────────

interface CrewFieldDateChangeParams {
  jobNumber: string;
  oldFieldDate: string;
  newFieldDate: string;
  propertyAddress: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
}

export function crewFieldDateChangeEmailHtml(p: CrewFieldDateChangeParams): string {
  const detailRows: Array<{ label: string; value: string }> = [
    { label: "Job Number", value: `#${p.jobNumber}` },
    { label: "Previous Date", value: `<span style="text-decoration:line-through;color:#A1A1AA;">${p.oldFieldDate}</span>` },
    { label: "New Date", value: `<strong style="color:#FF8401;">${p.newFieldDate}</strong>` },
    { label: "Property", value: p.propertyAddress },
    { label: "Client", value: p.clientName },
    { label: "Client Email", value: p.clientEmail },
    { label: "Client Phone", value: p.clientPhone },
  ];

  const detailsHtml = detailRows
    .map(
      (row, i) => `
      <tr style="background-color:${i % 2 === 0 ? "#FFFFFF" : "#F9FAFB"};">
        <td style="padding:12px 16px;font-size:14px;color:#71717A;font-weight:500;width:40%;border-bottom:1px solid #E4E4E7;">${row.label}</td>
        <td style="padding:12px 16px;font-size:14px;color:#18181B;border-bottom:1px solid #E4E4E7;word-break:break-word;">${row.value}</td>
      </tr>`,
    )
    .join("");

  return layout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181B;line-height:28px;">Field Date Changed</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#71717A;">The field date for a job assigned to your crew has been updated. Please review the new schedule below.</p>

    <div style="margin-bottom:28px;">
      <h3 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#71717A;text-transform:uppercase;letter-spacing:0.5px;">Updated Job Details</h3>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E4E4E7;border-radius:8px;overflow:hidden;">
        ${detailsHtml}
      </table>
    </div>

    <p style="margin:0;font-size:13px;line-height:20px;color:#A1A1AA;">
      Please adjust your schedule accordingly. Contact your crew manager with any questions.
    </p>
  `);
}
