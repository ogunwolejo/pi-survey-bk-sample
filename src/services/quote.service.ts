import { v4 as uuidv4 } from "uuid";
import { addDays } from "date-fns";
import { Prisma, QuoteStatus, OrderStatus, SurveyType, PropertyType, QuoteSource, PaymentTerms, Priority, Team, LockedGates, DeliveryPreference, County } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { withTransaction } from "../lib/transaction";
import { getNextSequence } from "../lib/sequential-number";
import { NotFoundError, ValidationError, ConflictError } from "../lib/errors";
import { quoteLogger as logger } from "../lib/logger";
import { findOrCreateFromSubmission } from "./contact.service";
import { calculateDates } from "./date-calculation.service";
import { fireUnifiedEvent, CustomerIoEventsNames } from "./customerio.service";
import { detectPaymentRequirement, type PaymentDetectionResult } from "./payment-detection.service";
import { envStore } from "../env-store";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getBasePriceForCounty(county?: string | null): Promise<number> {
  logger.info("Looking up base price for county", { county });
  const [pricingSetting, defaultSetting] = await Promise.all([
    prisma.systemSetting.findUnique({ where: { key: "county_pricing" } }),
    prisma.systemSetting.findUnique({ where: { key: "base_survey_price" } }),
  ]);

  const defaultPrice =
    defaultSetting && typeof defaultSetting.value === "number" ? defaultSetting.value : 495;

  if (county && pricingSetting && typeof pricingSetting.value === "object" && pricingSetting.value !== null) {
    const countyMap = pricingSetting.value as Record<string, number>;
    const countyKey = county.toLowerCase();
    if (typeof countyMap[countyKey] === "number") {
      logger.info("County-specific price found", { county, price: countyMap[countyKey] });
      return countyMap[countyKey]!;
    }
  }

  logger.info("Using default base price", { defaultPrice });
  return defaultPrice;
}

function mapQuoteCustomerTypeToClientType(quoteType: string): "homeowner" | "attorney" | "title_company" | "other" {
  switch (quoteType) {
    case "attorney_law_office":
      return "attorney";
    case "individual_homeowner":
      return "homeowner";
    case "title_company":
      return "title_company";
    default:
      return "other";
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QuoteFilters {
  status?: string;
  dateFrom?: Date;
  dateTo?: Date;
  surveyType?: string;
  source?: string;
  county?: string;
  customerType?: string;
  propertyType?: string;
}

export interface CreateQuoteData {
  // Provide clientId OR contact info
  clientId?: string;
  clientFirstName?: string;
  clientLastName?: string;
  clientEmail?: string;
  clientPhone?: string;
  billingClientId?: string;

  propertyAddressLine1: string;
  propertyAddressLine2?: string;
  propertyCity: string;
  propertyState: string;
  propertyZip: string;
  propertyCounty: string;
  pin: string;
  additionalPins?: string[];
  surveyType: "boundary" | "alta" | "condominium" | "topography" | "other";
  propertyType?: "sfr" | "sfr_townhome" | "apartment" | "commercial" | "vacant_land" | "farm" | "other";
  closingDate?: string;
  requestedDate?: string;
  onsiteContactFirstName?: string;
  onsiteContactLastName?: string;
  onsiteContactPhone?: string;
  lockedGates?: "yes" | "no" | "na";
  deliveryPreference?: "pdf_only" | "pdf_usps" | "pdf_fedex";
  legalDescription?: string;
  price?: number;
  basePriceAtCreation?: number;
  priceOverrideReason?: string;
  estimatedTimeframe?: string;
  paymentTerms?: "pre_pay" | "fifty_fifty" | "full_with_discount" | "post_closing";
  source: "website" | "internal";
  priority?: "low" | "normal" | "high" | "urgent";
  assignedTo?: string;
  internalNotes?: string;
  referralSource?: string;
  team?: "residential" | "public";
  customerType?: string;
  billingAddressSameAsService?: boolean;
  billingAddressLine1?: string;
  billingAddressLine2?: string;
  billingCity?: string;
  billingState?: string;
  billingZip?: string;
}

export interface AcceptQuoteData {
  // Payer / contact info if creating a new contact on acceptance
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;

  // Order supplemental data
  closingDate?: string;
  requestedDate?: string;
  paymentTerms?: "pre_pay" | "fifty_fifty" | "full_with_discount" | "post_closing";
  onsiteContactFirstName?: string;
  onsiteContactLastName?: string;
  onsiteContactPhone?: string;
  lockedGates?: "yes" | "no" | "na";
  deliveryPreference?: "pdf_only" | "pdf_usps" | "pdf_fedex";
  legalDescription?: string;
}

// ─── calculateExpiry ──────────────────────────────────────────────────────────

export async function calculateExpiry(): Promise<Date> {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: "quote_expiry_days" },
  });
  const days =
    setting && typeof setting.value === "number" ? setting.value : 30;
  return addDays(new Date(), days);
}

// ─── create ───────────────────────────────────────────────────────────────────

export async function create(data: CreateQuoteData, userId?: string): Promise<object> {
  logger.info("Creating quote", { source: data.source, surveyType: data.surveyType, county: data.propertyCounty, userId });

  let clientId = data.clientId;
  if (!clientId) {
    if (!data.clientEmail || !data.clientFirstName || !data.clientLastName || !data.clientPhone) {
      logger.warn("Quote creation failed — missing contact info");
      throw new ValidationError(
        "clientId or contact info (firstName, lastName, email, phone) required"
      );
    }
    logger.info("Finding or creating contact for quote", { email: data.clientEmail });
    const contact = await findOrCreateFromSubmission({
      firstName: data.clientFirstName,
      lastName: data.clientLastName,
      email: data.clientEmail,
      phone: data.clientPhone,
      customerType: data.customerType ? mapQuoteCustomerTypeToClientType(data.customerType) : "homeowner",
      source: data.source === "website" ? "quote_form" : "internal",
    });
    clientId = (contact as { id: string }).id;
    logger.info("Contact resolved for quote", { clientId });
  }

  const defaultBasePrice = await getBasePriceForCounty(data.propertyCounty);
  const basePrice = data.basePriceAtCreation ?? defaultBasePrice;
  const expiryDate = await calculateExpiry();
  const quoteNumber = await getNextSequence("QUOTE");
  logger.info("Quote sequence generated", { quoteNumber, basePrice, expiryDate });

  return withTransaction(async (tx) => {
    const quote = await tx.quote.create({
      data: {
        quoteNumber,
        clientId: clientId!,
        billingClientId: data.billingClientId,
        propertyAddressLine1: data.propertyAddressLine1,
        propertyAddressLine2: data.propertyAddressLine2,
        propertyCity: data.propertyCity,
        propertyState: data.propertyState,
        propertyZip: data.propertyZip,
        propertyCounty: data.propertyCounty as County | undefined,
        pin: data.pin,
        additionalPins: data.additionalPins ?? [],
        surveyType: data.surveyType as SurveyType,
        propertyType: data.propertyType as PropertyType | undefined,
        closingDate: data.closingDate ? new Date(data.closingDate) : undefined,
        onsiteContactFirstName: data.onsiteContactFirstName,
        onsiteContactLastName: data.onsiteContactLastName,
        onsiteContactPhone: data.onsiteContactPhone,
        lockedGates: data.lockedGates as LockedGates | undefined,
        deliveryPreference: data.deliveryPreference as DeliveryPreference | undefined,
        legalDescription: data.legalDescription,
        price: data.price != null ? data.price : undefined,
        basePriceAtCreation: basePrice,
        priceOverrideReason: data.priceOverrideReason,
        estimatedTimeframe: data.estimatedTimeframe,
        paymentTerms: data.paymentTerms as PaymentTerms | undefined,
        expiryDate,
        source: data.source as QuoteSource,
        priority: (data.priority ?? "normal") as Priority,
        assignedTo: data.assignedTo,
        internalNotes: data.internalNotes,
        referralSource: data.referralSource,
        team: (data.team ?? "residential") as Team,
        customerType: data.customerType as any,
        billingAddressSameAsService: data.billingAddressSameAsService ?? true,
        billingAddressLine1: data.billingAddressLine1,
        billingAddressLine2: data.billingAddressLine2,
        billingCity: data.billingCity,
        billingState: data.billingState,
        billingZip: data.billingZip,
        createdBy: userId,
      },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    logger.info("Quote created", { quoteId: quote.id, quoteNumber, clientId });
    return quote;
  });
}

// ─── createDraft ────────────────────────────────────────────────────────────
// Creates a draft quote from just the contact step of the public form.
// Required property/survey fields use placeholder values until finalization.

export interface CreateDraftData {
  clientFirstName: string;
  clientLastName: string;
  clientEmail: string;
  clientPhone: string;
  team?: "residential" | "public";
  referralSource?: string;
  customerType?: string;
}

export async function createDraft(data: CreateDraftData): Promise<object> {
  logger.info("Creating draft quote", { email: data.clientEmail, team: data.team });
  const contact = await findOrCreateFromSubmission({
    firstName: data.clientFirstName,
    lastName: data.clientLastName,
    email: data.clientEmail,
    phone: data.clientPhone,
    customerType: data.customerType ? mapQuoteCustomerTypeToClientType(data.customerType) : "homeowner",
    source: "quote_form",
  });
  const clientId = (contact as { id: string }).id;

  const basePrice = await getBasePriceForCounty(null);
  const expiryDate = await calculateExpiry();
  const quoteNumber = await getNextSequence("QUOTE");

  return withTransaction(async (tx) => {
    const quote = await tx.quote.create({
      data: {
        quoteNumber,
        status: QuoteStatus.draft,
        clientId,
        propertyAddressLine1: "",
        propertyCity: "",
        propertyState: "",
        propertyZip: "",
        propertyCounty: null,
        pin: "",
        basePriceAtCreation: basePrice,
        expiryDate,
        source: "website",
        team: (data.team ?? "residential") as Team,
        referralSource: data.referralSource,
        customerType: data.customerType as any,
        lastCompletedStep: 1,
      },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    logger.info("Draft quote created", { quoteId: quote.id, quoteNumber, clientId });
    return quote;
  });
}

// ─── finalizeDraft ──────────────────────────────────────────────────────────
// Updates a draft quote with all form data and transitions status to "new".

export interface FinalizeDraftData {
  propertyAddressLine1: string;
  propertyAddressLine2?: string;
  propertyCity: string;
  propertyState: string;
  propertyZip: string;
  propertyCounty: string;
  pin: string;
  additionalPins?: string[];
  surveyType: "boundary" | "alta" | "condominium" | "topography" | "other";
  propertyType?: "sfr" | "sfr_townhome" | "apartment" | "commercial" | "vacant_land" | "farm" | "other";
  closingDate?: string;
  onsiteContactFirstName?: string;
  onsiteContactLastName?: string;
  onsiteContactPhone?: string;
  lockedGates?: "yes" | "no" | "na";
  deliveryPreference?: "pdf_only" | "pdf_usps" | "pdf_fedex";
  legalDescription?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  paymentTerms?: "pre_pay" | "fifty_fifty" | "full_with_discount" | "post_closing";
  referralSource?: string;
  team?: "residential" | "public";
  billingAddressSameAsService?: boolean;
  billingAddressLine1?: string;
  billingAddressLine2?: string;
  billingCity?: string;
  billingState?: string;
  billingZip?: string;
}

export async function finalizeDraft(quoteId: string, data: FinalizeDraftData): Promise<object> {
  logger.info("Finalizing draft quote", { quoteId, surveyType: data.surveyType, county: data.propertyCounty });
  const existing = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { id: true, status: true, deletedAt: true },
  });

  if (!existing || existing.deletedAt) {
    logger.warn("Finalize draft failed — quote not found", { quoteId });
    throw new NotFoundError(`Quote ${quoteId} not found`);
  }
  if (existing.status !== QuoteStatus.draft) {
    logger.warn("Finalize draft failed — not in draft status", { quoteId, currentStatus: existing.status });
    throw new ValidationError(`Quote is not in draft status (current: ${existing.status})`);
  }

  const basePrice = await getBasePriceForCounty(data.propertyCounty);
  const expiryDate = await calculateExpiry();

  return withTransaction(async (tx) => {
    const quote = await tx.quote.update({
      where: { id: quoteId },
      data: {
        status: QuoteStatus.new,
        propertyAddressLine1: data.propertyAddressLine1,
        propertyAddressLine2: data.propertyAddressLine2,
        propertyCity: data.propertyCity,
        propertyState: data.propertyState,
        propertyZip: data.propertyZip,
        propertyCounty: data.propertyCounty as County | undefined,
        pin: data.pin,
        additionalPins: data.additionalPins ?? [],
        surveyType: data.surveyType as SurveyType,
        propertyType: data.propertyType as PropertyType | undefined,
        closingDate: data.closingDate ? new Date(data.closingDate) : undefined,
        onsiteContactFirstName: data.onsiteContactFirstName,
        onsiteContactLastName: data.onsiteContactLastName,
        onsiteContactPhone: data.onsiteContactPhone,
        lockedGates: data.lockedGates as LockedGates | undefined,
        deliveryPreference: data.deliveryPreference as DeliveryPreference | undefined,
        legalDescription: data.legalDescription,
        basePriceAtCreation: basePrice,
        expiryDate,
        priority: (data.priority ?? "normal") as Priority,
        paymentTerms: data.paymentTerms as PaymentTerms | undefined,
        referralSource: data.referralSource,
        team: data.team ? (data.team as Team) : undefined,
        billingAddressSameAsService: data.billingAddressSameAsService ?? true,
        billingAddressLine1: data.billingAddressLine1,
        billingAddressLine2: data.billingAddressLine2,
        billingCity: data.billingCity,
        billingState: data.billingState,
        billingZip: data.billingZip,
      },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    logger.info("Draft quote finalized", { quoteId: quote.id, quoteNumber: quote.quoteNumber });
    return quote;
  });
}

// ─── list ─────────────────────────────────────────────────────────────────────

export async function list(
  filters: QuoteFilters,
  page: number,
  limit: number,
  teamFilter?: { team?: string }
): Promise<{ data: object[]; total: number }> {
  logger.info("Listing quotes", { page, limit, filters, teamFilter });
  const where: Prisma.QuoteWhereInput = {
    deletedAt: null,
    ...(teamFilter?.team ? { team: teamFilter.team as Team } : {}),
    ...(filters.status ? { status: filters.status as QuoteStatus } : {}),
    ...(filters.surveyType ? { surveyType: filters.surveyType as SurveyType } : {}),
    ...(filters.source ? { source: filters.source as QuoteSource } : {}),
    ...(filters.dateFrom || filters.dateTo
      ? {
          createdAt: {
            ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
            ...(filters.dateTo ? { lte: filters.dateTo } : {}),
          },
        }
      : {}),
    ...(filters.county
      ? { propertyCounty: { in: filters.county.split(",") as County[] } }
      : {}),
    ...(filters.customerType
      ? { customerType: { in: filters.customerType.split(",") as Prisma.EnumQuoteCustomerTypeNullableFilter<"Quote">["in"] } }
      : {}),
    ...(filters.propertyType
      ? { propertyType: { in: filters.propertyType.split(",") as PropertyType[] } }
      : {}),
  };

  const [data, total] = await Promise.all([
    prisma.quote.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, email: true } },
        order: { select: { id: true, orderNumber: true, status: true } },
      },
    }),
    prisma.quote.count({ where }),
  ]);

  return { data, total };
}

// ─── getById ──────────────────────────────────────────────────────────────────

export async function getById(id: string): Promise<object> {
  logger.info("Getting quote by ID", { quoteId: id });
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: {
      client: true,
      billingClient: true,
      order: {
        include: {
          jobs: { select: { id: true, jobNumber: true, status: true } },
        },
      },
      quoteTokens: { orderBy: { createdAt: "desc" }, take: 1 },
      contractSignatures: true,
    },
  });

  if (!quote || quote.deletedAt) {
    logger.warn("Quote not found", { quoteId: id });
    throw new NotFoundError(`Quote ${id} not found`);
  }

  logger.info("Quote retrieved", { quoteId: id, quoteNumber: quote.quoteNumber, status: quote.status });
  return quote;
}

// ─── update ───────────────────────────────────────────────────────────────────

export async function update(
  id: string,
  data: Partial<CreateQuoteData>,
  userId: string
): Promise<object> {
  logger.info("Updating quote", { quoteId: id, userId, fields: Object.keys(data) });
  const existing = await prisma.quote.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });

  if (!existing || existing.deletedAt) {
    logger.warn("Quote update failed — not found", { quoteId: id });
    throw new NotFoundError(`Quote ${id} not found`);
  }

  return prisma.quote.update({
    where: { id },
    data: {
      ...(data.billingClientId !== undefined ? { billingClientId: data.billingClientId } : {}),
      ...(data.propertyAddressLine1 ? { propertyAddressLine1: data.propertyAddressLine1 } : {}),
      ...(data.propertyAddressLine2 !== undefined
        ? { propertyAddressLine2: data.propertyAddressLine2 }
        : {}),
      ...(data.propertyCity ? { propertyCity: data.propertyCity } : {}),
      ...(data.propertyState ? { propertyState: data.propertyState } : {}),
      ...(data.propertyZip ? { propertyZip: data.propertyZip } : {}),
      ...(data.propertyCounty ? { propertyCounty: data.propertyCounty as County } : {}),
      ...(data.pin ? { pin: data.pin } : {}),
      ...(data.additionalPins !== undefined ? { additionalPins: data.additionalPins } : {}),
      ...(data.surveyType ? { surveyType: data.surveyType as SurveyType } : {}),
      ...(data.propertyType ? { propertyType: data.propertyType as PropertyType } : {}),
      ...(data.customerType !== undefined ? { customerType: data.customerType as any } : {}),
      ...(data.closingDate !== undefined
        ? { closingDate: data.closingDate ? new Date(data.closingDate) : null }
        : {}),
      ...(data.onsiteContactFirstName !== undefined
        ? { onsiteContactFirstName: data.onsiteContactFirstName }
        : {}),
      ...(data.onsiteContactLastName !== undefined
        ? { onsiteContactLastName: data.onsiteContactLastName }
        : {}),
      ...(data.onsiteContactPhone !== undefined
        ? { onsiteContactPhone: data.onsiteContactPhone }
        : {}),
      ...(data.lockedGates ? { lockedGates: data.lockedGates as LockedGates } : {}),
      ...(data.deliveryPreference
        ? { deliveryPreference: data.deliveryPreference as DeliveryPreference }
        : {}),
      ...(data.legalDescription !== undefined
        ? { legalDescription: data.legalDescription }
        : {}),
      ...(data.price !== undefined ? { price: data.price } : {}),
      ...(data.basePriceAtCreation !== undefined
        ? { basePriceAtCreation: data.basePriceAtCreation }
        : {}),
      ...(data.priceOverrideReason !== undefined
        ? { priceOverrideReason: data.priceOverrideReason }
        : {}),
      ...(data.estimatedTimeframe !== undefined
        ? { estimatedTimeframe: data.estimatedTimeframe }
        : {}),
      ...(data.paymentTerms ? { paymentTerms: data.paymentTerms as PaymentTerms } : {}),
      ...(data.priority ? { priority: data.priority as Priority } : {}),
      ...(data.assignedTo !== undefined ? { assignedTo: data.assignedTo } : {}),
      ...(data.internalNotes !== undefined ? { internalNotes: data.internalNotes } : {}),
      ...(data.referralSource !== undefined ? { referralSource: data.referralSource } : {}),
      ...(data.team ? { team: data.team as Team } : {}),
      ...(data.billingAddressSameAsService !== undefined
        ? { billingAddressSameAsService: data.billingAddressSameAsService }
        : {}),
      ...(data.billingAddressLine1 !== undefined
        ? { billingAddressLine1: data.billingAddressLine1 }
        : {}),
      ...(data.billingAddressLine2 !== undefined
        ? { billingAddressLine2: data.billingAddressLine2 }
        : {}),
      ...(data.billingCity !== undefined ? { billingCity: data.billingCity } : {}),
      ...(data.billingState !== undefined ? { billingState: data.billingState } : {}),
      ...(data.billingZip !== undefined ? { billingZip: data.billingZip } : {}),
      updatedBy: userId,
    },
  });
}

// ─── send ─────────────────────────────────────────────────────────────────────

export async function send(id: string, userId: string): Promise<object> {
  logger.info("Sending quote", { quoteId: id, userId });
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { client: { select: { id: true, email: true } } },
  });

  if (!quote || quote.deletedAt) {
    logger.warn("Quote send failed — not found", { quoteId: id });
    throw new NotFoundError(`Quote ${id} not found`);
  }

  if (quote.status !== QuoteStatus.new && quote.status !== QuoteStatus.pending_review) {
    logger.warn("Quote send failed — invalid status", { quoteId: id, status: quote.status });
    throw new ValidationError(`Cannot send quote with status '${quote.status}'`);
  }

  return withTransaction(async (tx) => {
    const quoteToken = await tx.quoteToken.create({
      data: {
        token: uuidv4(),
        quoteId: id,
        expiresAt: addDays(new Date(), 30),
      },
    });

    const updated = await tx.quote.update({
      where: { id },
      data: { status: QuoteStatus.sent, updatedBy: userId },
    });

    await tx.entityAuditLog.create({
      data: {
        entityType: "quote",
        entityId: id,
        entityNumber: quote.quoteNumber,
        action: "updated",
        userId,
        userName: userId,
        changedAt: new Date(),
        changes: { status: { from: quote.status, to: QuoteStatus.sent } },
        changeSummary: "Quote sent to client",
        source: "web_portal",
      },
    });

    logger.info("Quote sent to client", { quoteId: id, tokenId: quoteToken.id });
    return { ...updated, quoteToken };
  });
}

// ─── accept ───────────────────────────────────────────────────────────────────
// Atomic: verify token → optionally create contact → create order → mark quote
// accepted → mark token used. SERIALIZABLE isolation prevents double-acceptance.

export async function accept(
  quoteToken: string,
  orderData: AcceptQuoteData,
  userId?: string
): Promise<object> {
  logger.info("Accepting quote via token", { tokenPrefix: quoteToken.slice(0, 8), userId });

  const txResult = await withTransaction(
    async (tx) => {
      const tokenRecord = await tx.quoteToken.findUnique({
        where: { token: quoteToken },
        include: {
          quote: {
            include: { client: true },
          },
        },
      });

      if (!tokenRecord) {
        logger.warn("Quote acceptance failed — invalid token", { tokenPrefix: quoteToken.slice(0, 8) });
        throw new ValidationError("Invalid or expired quote acceptance link");
      }
      if (tokenRecord.usedAt) {
        logger.warn("Quote acceptance failed — token already used", { tokenId: tokenRecord.id });
        throw new ValidationError("This quote acceptance link has already been used");
      }
      if (tokenRecord.expiresAt < new Date()) {
        logger.warn("Quote acceptance failed — token expired", { tokenId: tokenRecord.id, expiresAt: tokenRecord.expiresAt });
        throw new ValidationError("This quote acceptance link has expired");
      }

      const quote = tokenRecord.quote;
      if (!quote || quote.deletedAt) {
        logger.warn("Quote acceptance failed — quote not found");
        throw new NotFoundError("Quote not found");
      }
      if (quote.status !== QuoteStatus.sent) {
        logger.warn("Quote acceptance failed — invalid status", { quoteId: quote.id, status: quote.status });
        throw new ValidationError(`Quote cannot be accepted in '${quote.status}' status`);
      }

      logger.info("Token validated for quote acceptance", { quoteId: quote.id, quoteNumber: quote.quoteNumber });

      // Resolve or create the accepting contact
      let clientId = quote.clientId;
      if (orderData.email && orderData.firstName && orderData.lastName && orderData.phone) {
        const existingContact = await tx.client.findUnique({
          where: { email: orderData.email },
        });
        if (!existingContact) {
          const newContact = await tx.client.create({
            data: {
              firstName: orderData.firstName,
              lastName: orderData.lastName,
              email: orderData.email,
              phone: orderData.phone,
              customerType: "homeowner",
              source: "quote_form",
            },
          });
          clientId = newContact.id;
        } else {
          clientId = existingContact.id;
        }
      }

      // Generate sequence number (runs in its own Serializable sub-transaction)
      const orderNumber = await getNextSequence("ORDER");

      const closingDate = orderData.closingDate ? new Date(orderData.closingDate) : null;
      const requestedDate = orderData.requestedDate ? new Date(orderData.requestedDate) : null;

      // calculateDates uses the global prisma client (read-only) — safe inside tx
      const dates = await calculateDates(closingDate, requestedDate, clientId);

      const order = await tx.order.create({
        data: {
          orderNumber,
          quoteId: quote.id,
          clientId,
          billingClientId: quote.billingClientId,
          status: OrderStatus.research_in_progress,
          orderType: "standard",
          propertyAddressLine1: quote.propertyAddressLine1,
          propertyAddressLine2: quote.propertyAddressLine2,
          propertyCity: quote.propertyCity,
          propertyState: quote.propertyState,
          propertyZip: quote.propertyZip,
          propertyCounty: quote.propertyCounty,
          pin: quote.pin,
          additionalPins: quote.additionalPins,
          pinLatitude: quote.pinLatitude,
          pinLongitude: quote.pinLongitude,
          surveyType: quote.surveyType!,
          price: quote.price,
          paymentTerms: (orderData.paymentTerms as PaymentTerms | undefined) ?? quote.paymentTerms ?? "pre_pay",
          closingDate,
          onsiteContactFirstName: orderData.onsiteContactFirstName,
          onsiteContactLastName: orderData.onsiteContactLastName,
          onsiteContactPhone: orderData.onsiteContactPhone,
          lockedGates: orderData.lockedGates,
          deliveryPreference: orderData.deliveryPreference,
          legalDescription: orderData.legalDescription,
          source: "quote_acceptance",
          team: quote.team,
          dropDeadDate: dates.dropDeadDate,
          internalClosingDate: dates.internalClosingDate,
          dueDate: dates.dueDate,
          isRush: dates.isRush,
          createdBy: userId,
        },
      });

      await tx.quote.update({
        where: { id: quote.id },
        data: { status: QuoteStatus.accepted, updatedBy: userId },
      });

      await tx.quoteToken.update({
        where: { token: quoteToken },
        data: { usedAt: new Date() },
      });

      logger.info("Quote accepted via token", {
        quoteId: quote.id,
        orderId: order.id,
        orderNumber,
        clientId,
      });

      return { quote: { ...quote, status: QuoteStatus.accepted }, order, client: quote.client };
    },
    "Serializable"
  );

  const result = txResult as {
    quote: { id: string; quoteNumber?: string };
    order: {
      id: string;
      orderNumber: string;
      status: string;
      price: unknown;
      surveyType: string | null;
      propertyAddressLine1: string | null;
      propertyCity: string | null;
      propertyState: string | null;
      propertyZip: string | null;
      source: string | null;
    };
    client: { id: string; email: string; firstName: string; lastName: string };
  };

  return { quote: result.quote, order: result.order, clientName: `${result.client.firstName} ${result.client.lastName}` };
}

// ─── checkExpired ─────────────────────────────────────────────────────────────

export async function checkExpired(): Promise<number> {
  logger.info("Checking for expired quotes");
  const result = await prisma.quote.updateMany({
    where: {
      status: { in: [QuoteStatus.draft, QuoteStatus.new, QuoteStatus.pending_review, QuoteStatus.sent] },
      expiryDate: { lt: new Date() },
      deletedAt: null,
    },
    data: { status: QuoteStatus.expired },
  });

  if (result.count > 0) {
    logger.info("Quotes batch-expired", { count: result.count });
  }

  return result.count;
}

// ─── Send Quote to Client (T014) ───────────────────────────────────────────

type QuoteWithClient = Prisma.QuoteGetPayload<{ include: { client: true } }>;

export interface SendToClientOptions {
  quoteId: string;
  userId: string;
  overrides?: {
    paymentRequired?: boolean;
    paymentTerms?: string;
    depositPercentage?: number;
  };
}

function resolvePayment(params: {
  quotePrice: number;
  clientType: string;
  clientPaymentTerms: string | null;
  overrides?: SendToClientOptions["overrides"];
}): PaymentDetectionResult {
  const auto = detectPaymentRequirement({
    customerType: params.clientType,
    paymentTerms: params.clientPaymentTerms,
    quotePrice: params.quotePrice,
  });
  if (params.overrides?.paymentRequired === undefined) return auto;

  const required = params.overrides.paymentRequired;
  const pct = required ? (params.overrides.depositPercentage ?? auto.depositPercentage) : 0;
  return {
    paymentRequired: required,
    paymentTerms: params.overrides.paymentTerms ?? auto.paymentTerms,
    depositPercentage: pct,
    depositAmount: Math.round(params.quotePrice * (pct / 100) * 100) / 100,
    reason: "Manual override",
    needsSelection: false,
    detectionSource: "client_customer_type" as const,
  };
}

export function buildQuoteSentEventAttributes(params: {
  quote: QuoteWithClient;
  tokenUrl: string;
  paymentDetection: PaymentDetectionResult;
}): Record<string, unknown> {
  const { quote, tokenUrl, paymentDetection: pd } = params;
  const client = quote.client;
  const useBilling = !quote.billingAddressSameAsService;

  const billingAddr = useBilling
    ? { line1: quote.billingAddressLine1 ?? "", line2: quote.billingAddressLine2 ?? "", city: quote.billingCity ?? "", state: quote.billingState ?? "", zip: quote.billingZip ?? "" }
    : { line1: quote.propertyAddressLine1, line2: quote.propertyAddressLine2 ?? "", city: quote.propertyCity, state: quote.propertyState, zip: quote.propertyZip };

  return {
    payment_required: pd.paymentRequired,
    billing_address: billingAddr,
    sequential_number: quote.quoteNumber,
    client_name: `${client.firstName} ${client.lastName}`,
    client_email: client.email,
    property_address: {
      line1: quote.propertyAddressLine1, line2: quote.propertyAddressLine2 ?? "",
      city: quote.propertyCity, state: quote.propertyState,
      zip: quote.propertyZip, county: quote.propertyCounty ?? "",
    },
    survey_type: quote.surveyType ?? "",
    county: quote.propertyCounty ?? "",
    price: Number(quote.price),
    price_breakdown: pd.paymentRequired ? (quote.priceBreakdown ?? null) : null,
    payment_terms: pd.paymentTerms,
    deposit_percentage: pd.paymentRequired ? pd.depositPercentage : null,
    deposit_amount: pd.paymentRequired ? pd.depositAmount : null,
    tokenized_link: tokenUrl,
    proposal_url: tokenUrl,
  };
}

function fireQuoteSentCioEvent(quote: QuoteWithClient, tokenUrl: string, detection: PaymentDetectionResult): void {
  const raw = buildQuoteSentEventAttributes({ quote, tokenUrl, paymentDetection: detection });
  const propertyAddr = [quote.propertyAddressLine1, quote.propertyCity, quote.propertyState]
    .filter(Boolean)
    .join(", ");

  fireUnifiedEvent({
    contactId: quote.id,
    identifyAttributes: {
      email: quote.client.email,
      first_name: quote.client.firstName,
      last_name: quote.client.lastName,
    },
    unifiedEventName: CustomerIoEventsNames.PROPOSAL_SENT,
    legacyEventName: CustomerIoEventsNames.QUOTE_SENT,
    attributes: {
      ...raw,
      source_type: "quote",
      source_id: quote.id,
      source_number: quote.quoteNumber,
      property_address: propertyAddr,
      amount: String(Number(quote.price)),
    },
  });
}

export async function sendQuoteToClient(opts: SendToClientOptions): Promise<object> {
  logger.info("Sending quote to client (T014)", { quoteId: opts.quoteId, userId: opts.userId, hasOverrides: !!opts.overrides });
  const quote = await prisma.quote.findUnique({ where: { id: opts.quoteId }, include: { client: true } });
  if (!quote || quote.deletedAt) {
    logger.warn("sendQuoteToClient failed — not found", { quoteId: opts.quoteId });
    throw new NotFoundError(`Quote ${opts.quoteId} not found`);
  }
  if (quote.status !== QuoteStatus.quoted) {
    logger.warn("sendQuoteToClient failed — invalid status", { quoteId: opts.quoteId, status: quote.status });
    throw new ValidationError(`Quote must be in 'quoted' status (current: ${quote.status})`);
  }
  if (Number(quote.price) <= 0) {
    logger.warn("sendQuoteToClient failed — invalid price", { quoteId: opts.quoteId, price: quote.price });
    throw new ValidationError("Quote price must be greater than 0");
  }

  const detection = resolvePayment({
    quotePrice: Number(quote.price), clientType: quote.client.customerType,
    clientPaymentTerms: quote.client.paymentTerms, overrides: opts.overrides,
  });

  const { updated, token } = await withTransaction(async (tx) => {
    const fresh = await tx.quote.findUniqueOrThrow({ where: { id: opts.quoteId }, select: { status: true } });
    if (fresh.status !== QuoteStatus.quoted) throw new ConflictError("Quote has already been sent");

    const tk = await tx.quoteToken.create({
      data: { token: uuidv4(), quoteId: opts.quoteId, tokenType: "proposal", expiresAt: addDays(new Date(), 30) },
    });
    const upd = await tx.quote.update({
      where: { id: opts.quoteId },
      data: {
        status: QuoteStatus.sent,
        paymentRequired: detection.paymentRequired,
        paymentRequiredReason: detection.reason,
        paymentTerms: (detection.paymentTerms as PaymentTerms) ?? PaymentTerms.post_closing,
        updatedBy: opts.userId,
      },
    });
    return { updated: upd, token: tk };
  }, "Serializable");

  const tokenUrl = `${envStore.FRONTEND_URL}/proposal/${token.token}`;
  fireQuoteSentCioEvent(quote, tokenUrl, detection);
  logger.info("Quote sent to client", { quoteId: opts.quoteId, tokenId: token.id });

  return {
    quote: { ...updated, paymentRequired: detection.paymentRequired },
    quoteToken: token,
    paymentDetection: {
      autoDetected: opts.overrides?.paymentRequired === undefined,
      reason: detection.reason, paymentTerms: detection.paymentTerms, depositPercentage: detection.depositPercentage,
    },
  };
}

// ─── Resend Quote to Client ─────────────────────────────────────────────────

export async function resendQuoteToClient(opts: SendToClientOptions): Promise<object> {
  logger.info("Resending quote to client", { quoteId: opts.quoteId, userId: opts.userId });
  const quote = await prisma.quote.findUnique({ where: { id: opts.quoteId }, include: { client: true } });
  if (!quote || quote.deletedAt) {
    logger.warn("resendQuoteToClient failed — not found", { quoteId: opts.quoteId });
    throw new NotFoundError(`Quote ${opts.quoteId} not found`);
  }
  if (quote.status !== QuoteStatus.sent) {
    logger.warn("resendQuoteToClient failed — invalid status", { quoteId: opts.quoteId, status: quote.status });
    throw new ValidationError(`Quote must be in 'sent' status to resend (current: ${quote.status})`);
  }
  if (Number(quote.price) <= 0) {
    logger.warn("resendQuoteToClient failed — invalid price", { quoteId: opts.quoteId, price: quote.price });
    throw new ValidationError("Quote price must be greater than 0");
  }

  const detection = resolvePayment({
    quotePrice: Number(quote.price), clientType: quote.client.customerType,
    clientPaymentTerms: quote.client.paymentTerms, overrides: opts.overrides,
  });

  const token = await withTransaction(async (tx) => {
    const fresh = await tx.quote.findUniqueOrThrow({ where: { id: opts.quoteId }, select: { status: true } });
    if (fresh.status !== QuoteStatus.sent) throw new ConflictError("Quote is no longer in 'sent' status");

    await tx.quoteToken.updateMany({
      where: { quoteId: opts.quoteId, tokenType: "proposal", usedAt: null },
      data: { usedAt: new Date() },
    });

    const tk = await tx.quoteToken.create({
      data: { token: uuidv4(), quoteId: opts.quoteId, tokenType: "proposal", expiresAt: addDays(new Date(), 30) },
    });

    await tx.quote.update({
      where: { id: opts.quoteId },
      data: {
        paymentRequired: detection.paymentRequired,
        paymentRequiredReason: detection.reason,
        paymentTerms: (detection.paymentTerms as PaymentTerms) ?? PaymentTerms.post_closing,
        updatedBy: opts.userId,
      },
    });

    return tk;
  }, "Serializable");

  const tokenUrl = `${envStore.FRONTEND_URL}/proposal/${token.token}`;
  fireQuoteSentCioEvent(quote, tokenUrl, detection);
  logger.info("Quote resent to client", { quoteId: opts.quoteId, tokenId: token.id });

  return {
    quote: { id: quote.id, status: quote.status, paymentRequired: detection.paymentRequired },
    quoteToken: token,
    paymentDetection: {
      autoDetected: opts.overrides?.paymentRequired === undefined,
      reason: detection.reason, paymentTerms: detection.paymentTerms, depositPercentage: detection.depositPercentage,
    },
  };
}
