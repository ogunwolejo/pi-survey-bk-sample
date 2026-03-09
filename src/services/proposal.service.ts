import { prisma } from "../lib/prisma";
import { NotFoundError, ValidationError, ConflictError } from "../lib/errors";
import { quoteLogger as logger } from "../lib/logger";
import { detectPaymentRequirement } from "./payment-detection.service";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProposalQuote {
  id: string;
  quoteNumber: string;
  propertyAddress: string;
  surveyType: string | null;
  price: number;
  priceBreakdown: unknown;
  estimatedTimeframe: string | null;
  county: string | null;
}

interface ProposalClient {
  name: string;
  email: string;
}

interface ProposalPayment {
  required: boolean;
  terms: string;
  depositPercentage: number;
  depositAmount: number;
  processingFee: { cardRate: number; achRate: number };
}

interface ProposalCompany {
  companyName: string;
  companyPhone: string;
  companyEmail: string;
  companyAddress: string;
  termsAndConditions: string;
}

interface ProposalToken {
  expiresAt: string;
  alreadyAccepted: boolean;
}

export interface ProposalData {
  quote: ProposalQuote;
  client: ProposalClient;
  payment: ProposalPayment;
  proposal: ProposalCompany;
  token: ProposalToken;
}

interface AlreadyAcceptedResponse {
  alreadyAccepted: true;
  quoteId: string;
  quoteNumber: string;
}

const TERMS_AND_CONDITIONS = [
  "By signing this proposal, you agree to the scope of work described herein.",
  "Payment is due per the terms stated. Late payments may incur a 1.5% monthly finance charge.",
  "Pi Surveying PLLC will complete the survey within the estimated timeframe, subject to weather, access, and title document availability.",
  "The client is responsible for providing clear access to the property and marking any known boundary features.",
  "This proposal is valid for 30 days from the date of issue.",
  "Cancellation after work has commenced may result in charges for work performed to date.",
  "All survey work is performed in accordance with the Illinois Minimum Standards for boundary surveys.",
  "Pi Surveying PLLC maintains professional liability insurance. Liability is limited to the fee paid for the survey.",
].join(" ");

// ─── getDepositPercentageForTerms ─────────────────────────────────────────────

function getDepositPercentageForTerms(terms: string): number {
  switch (terms) {
    case "pre_pay":
    case "full_with_discount":
      return 100;
    case "fifty_fifty":
      return 50;
    case "post_closing":
      return 0;
    default:
      return 100;
  }
}

// ─── assembleAddress ──────────────────────────────────────────────────────────

function assembleAddress(
  line1: string,
  line2: string | null,
  city: string,
  state: string,
  zip: string,
): string {
  const parts = [line1];
  if (line2) parts.push(line2);
  parts.push(`${city}, ${state} ${zip}`);
  return parts.join(", ");
}

// ─── getProposalData ──────────────────────────────────────────────────────────

export async function getProposalData(
  token: string,
): Promise<ProposalData | AlreadyAcceptedResponse> {
  logger.info("Loading proposal data", { tokenPrefix: token.slice(0, 8) });
  const tokenRecord = await prisma.quoteToken.findUnique({
    where: { token },
    include: {
      quote: { include: { client: true } },
    },
  });

  if (!tokenRecord) {
    logger.warn("Proposal load failed — token not found", { tokenPrefix: token.slice(0, 8) });
    throw new NotFoundError("Proposal link not found");
  }

  if (tokenRecord.expiresAt < new Date()) {
    logger.warn("Proposal load failed — token expired", { tokenPrefix: token.slice(0, 8) });
    throw new ValidationError("This proposal link has expired");
  }

  const quote = tokenRecord.quote;
  if (!quote || quote.deletedAt) {
    logger.warn("Proposal load failed — quote not found");
    throw new NotFoundError("Quote not found");
  }

  if (tokenRecord.usedAt && quote.status === "accepted") {
    logger.info("Proposal already accepted", { quoteId: quote.id });
    return {
      alreadyAccepted: true,
      quoteId: quote.id,
      quoteNumber: quote.quoteNumber,
    };
  }

  if (quote.status === "accepted") {
    throw new ConflictError("This quote has already been accepted");
  }

  const client = quote.client;
  const quotePrice = Number(quote.price);

  let paymentDetection: { paymentRequired: boolean; paymentTerms: string; depositPercentage: number; depositAmount: number };

  if (quote.paymentRequired !== null) {
    const terms = quote.paymentTerms ?? "post_closing";
    const pct = quote.paymentRequired ? getDepositPercentageForTerms(terms) : 0;
    paymentDetection = {
      paymentRequired: quote.paymentRequired,
      paymentTerms: terms,
      depositPercentage: pct,
      depositAmount: Math.round(quotePrice * (pct / 100) * 100) / 100,
    };
  } else {
    paymentDetection = detectPaymentRequirement({
      customerType: client.customerType,
      paymentTerms: quote.paymentTerms,
      quotePrice,
    });
  }

  logger.info("Proposal data loaded", { token, quoteId: quote.id });

  return buildProposalResponse(quote, client, paymentDetection, tokenRecord);
}

// ─── flattenPriceBreakdown ────────────────────────────────────────────────────

function flattenPriceBreakdown(
  raw: unknown,
): { description: string; amount: number }[] | null {
  if (!raw || typeof raw !== "object") return null;

  if (Array.isArray(raw)) return raw as { description: string; amount: number }[];

  const obj = raw as Record<string, unknown>;
  const items: { description: string; amount: number }[] = [];

  const basePrice = Number(obj["basePrice"] ?? 0);
  if (basePrice > 0) {
    items.push({ description: "Base Price", amount: basePrice });
  }

  const lineItems = obj["lineItems"];
  if (Array.isArray(lineItems)) {
    for (const li of lineItems) {
      const item = li as Record<string, unknown>;
      items.push({
        description: String(item["label"] ?? item["description"] ?? ""),
        amount: Number(item["amount"] ?? 0),
      });
    }
  }

  const rushFee = Number(obj["rushFee"] ?? 0);
  if (rushFee > 0) {
    items.push({ description: "Rush Fee", amount: rushFee });
  }

  return items.length > 0 ? items : null;
}

// ─── buildProposalResponse ────────────────────────────────────────────────────

function buildProposalResponse(
  quote: {
    id: string;
    quoteNumber: string;
    propertyAddressLine1: string;
    propertyAddressLine2: string | null;
    propertyCity: string;
    propertyState: string;
    propertyZip: string;
    surveyType: string | null;
    price: unknown;
    priceBreakdown: unknown;
    estimatedTimeframe: string | null;
    propertyCounty: string | null;
  },
  client: { firstName: string; lastName: string; email: string },
  payment: { paymentRequired: boolean; paymentTerms: string; depositPercentage: number; depositAmount: number },
  tokenRecord: { expiresAt: Date; usedAt: Date | null },
): ProposalData {
  return {
    quote: {
      id: quote.id,
      quoteNumber: quote.quoteNumber,
      propertyAddress: assembleAddress(
        quote.propertyAddressLine1,
        quote.propertyAddressLine2,
        quote.propertyCity,
        quote.propertyState,
        quote.propertyZip,
      ),
      surveyType: quote.surveyType,
      price: Number(quote.price),
      priceBreakdown: flattenPriceBreakdown(quote.priceBreakdown),
      estimatedTimeframe: quote.estimatedTimeframe,
      county: quote.propertyCounty,
    },
    client: {
      name: `${client.firstName} ${client.lastName}`,
      email: client.email,
    },
    payment: {
      required: payment.paymentRequired,
      terms: payment.paymentTerms,
      depositPercentage: payment.depositPercentage,
      depositAmount: payment.depositAmount,
      processingFee: { cardRate: 0.03, achRate: 0 },
    },
    proposal: {
      companyName: "Pi Surveying PLLC",
      companyPhone: "(312) 555-0100",
      companyEmail: "info@pisurveying.com",
      companyAddress: "123 S Michigan Ave, Chicago, IL 60603",
      termsAndConditions: TERMS_AND_CONDITIONS,
    },
    token: {
      expiresAt: tokenRecord.expiresAt.toISOString(),
      alreadyAccepted: tokenRecord.usedAt !== null,
    },
  };
}
