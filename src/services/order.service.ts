import {
  Prisma,
  OrderStatus,
  JobStatus,
  QuoteStatus,
  SurveyType,
  PaymentTerms,
  Priority,
  Team,
  OrderType,
  OrderSource,
  PropertyType,
  LockedGates,
  DeliveryPreference,
  InvoiceStatus,
  County,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import { withTransaction } from "../lib/transaction";
import { getNextSequence } from "../lib/sequential-number";
import { canTransition } from "../lib/status-engine";
import { NotFoundError, ValidationError } from "../lib/errors";
import { subDays } from "date-fns";
import { orderLogger as logger } from "../lib/logger";
import { findOrCreateFromSubmission } from "./contact.service";
import { calculateDates } from "./date-calculation.service";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrderFilters {
  status?: string;
  dateFrom?: Date;
  dateTo?: Date;
  dueDateFrom?: Date;
  dueDateTo?: Date;
  county?: string;
  surveyType?: string;
  paymentStatus?: string;
}

export interface CreateOrderData {
  // Provide clientId OR contact info
  clientId?: string;
  clientFirstName?: string;
  clientLastName?: string;
  clientEmail?: string;
  clientPhone?: string;
  billingClientId?: string;

  orderType?: "standard" | "public_municipal";
  propertyAddressLine1: string;
  propertyAddressLine2?: string;
  propertyCity: string;
  propertyState: string;
  propertyZip: string;
  propertyCounty: string;
  pin: string;
  additionalPins?: string[];
  propertyType?: "sfr" | "sfr_townhome" | "apartment" | "commercial" | "vacant_land" | "farm" | "other";
  surveyType: "boundary" | "alta" | "condominium" | "topography" | "other";
  price?: number;
  paymentTerms?: "pre_pay" | "fifty_fifty" | "full_with_discount" | "post_closing";
  closingDate?: string;
  requestedDate?: string;
  onsiteContactFirstName?: string;
  onsiteContactLastName?: string;
  onsiteContactPhone?: string;
  lockedGates?: "yes" | "no" | "na";
  deliveryPreference?: "pdf_only" | "pdf_usps" | "pdf_fedex";
  legalDescription?: string;
  source: "website" | "internal" | "quote_acceptance";
  priority?: "low" | "normal" | "high" | "urgent";
  team: "residential" | "public";
  suppressClientEmails?: boolean;
  internalNotes?: string;
  referralSource?: string;
}

export interface SupplementalOrderData {
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

// ─── create ───────────────────────────────────────────────────────────────────

export async function create(data: CreateOrderData, userId?: string): Promise<object> {
  logger.info("Creating order", { source: data.source, team: data.team, surveyType: data.surveyType, userId });

  let clientId = data.clientId;
  if (!clientId) {
    if (!data.clientEmail || !data.clientFirstName || !data.clientLastName || !data.clientPhone) {
      logger.warn("Order creation failed — missing contact info");
      throw new ValidationError(
        "clientId or contact info (firstName, lastName, email, phone) required"
      );
    }
    logger.info("Finding or creating contact for order", { email: data.clientEmail });
    const contact = await findOrCreateFromSubmission({
      firstName: data.clientFirstName,
      lastName: data.clientLastName,
      email: data.clientEmail,
      phone: data.clientPhone,
      customerType: "homeowner",
      source: data.source === "website" ? "order_form" : "internal",
    });
    clientId = (contact as { id: string }).id;
    logger.info("Contact resolved for order", { clientId });
  }

  const closingDate = data.closingDate ? new Date(data.closingDate) : null;
  const requestedDate = data.requestedDate ? new Date(data.requestedDate) : null;
  logger.info("Calculating order dates", { closingDate, requestedDate, clientId });
  const dates = await calculateDates(closingDate, requestedDate, clientId);
  const orderNumber = await getNextSequence("ORDER");
  logger.info("Order sequence generated", { orderNumber, isRush: dates.isRush });

  return withTransaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        orderNumber,
        clientId: clientId!,
        billingClientId: data.billingClientId,
        status: OrderStatus.new,
        orderType: (data.orderType ?? "standard") as OrderType,
        propertyAddressLine1: data.propertyAddressLine1,
        propertyAddressLine2: data.propertyAddressLine2,
        propertyCity: data.propertyCity,
        propertyState: data.propertyState,
        propertyZip: data.propertyZip,
        propertyCounty: data.propertyCounty as County | undefined,
        pin: data.pin,
        additionalPins: data.additionalPins ?? [],
        propertyType: data.propertyType as PropertyType | undefined,
        surveyType: data.surveyType as SurveyType,
        price: data.price ?? 0,
        paymentTerms: (data.paymentTerms ?? "pre_pay") as PaymentTerms,
        closingDate,
        onsiteContactFirstName: data.onsiteContactFirstName,
        onsiteContactLastName: data.onsiteContactLastName,
        onsiteContactPhone: data.onsiteContactPhone,
        lockedGates: data.lockedGates as LockedGates | undefined,
        deliveryPreference: data.deliveryPreference as DeliveryPreference | undefined,
        legalDescription: data.legalDescription,
        source: data.source as OrderSource,
        priority: (data.priority ?? "normal") as Priority,
        team: data.team as Team,
        suppressClientEmails: data.suppressClientEmails ?? false,
        internalNotes: data.internalNotes,
        referralSource: data.referralSource,
        dropDeadDate: dates.dropDeadDate,
        internalClosingDate: dates.internalClosingDate,
        dueDate: dates.dueDate,
        isRush: dates.isRush,
        createdBy: userId,
      },
      include: { client: true },
    });

    logger.info("Order created", { orderId: order.id, orderNumber, clientId });
    return order;
  });
}

// ─── createFromQuote ──────────────────────────────────────────────────────────
// Atomic: create order linked to quote → mark quote accepted. SERIALIZABLE
// isolation prevents concurrent double-acceptance.

export async function createFromQuote(
  quoteId: string,
  supplementalData: SupplementalOrderData,
  userId?: string
): Promise<object> {
  logger.info("Creating order from quote", { quoteId, userId });

  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      client: true,
      order: { select: { id: true } },
    },
  });

  if (!quote || quote.deletedAt) {
    logger.warn("Order from quote failed — quote not found", { quoteId });
    throw new NotFoundError(`Quote ${quoteId} not found`);
  }
  if (quote.status === QuoteStatus.accepted) {
    logger.warn("Order from quote failed — quote already accepted", { quoteId, status: quote.status });
    throw new ValidationError("Quote has already been accepted");
  }
  if (quote.order) {
    logger.warn("Order from quote failed — order already exists", { quoteId, existingOrderId: quote.order.id });
    throw new ValidationError("An order already exists for this quote");
  }

  logger.info("Quote validated for order creation", { quoteId, quoteNumber: quote.quoteNumber, clientId: quote.clientId });

  const closingDate = supplementalData.closingDate
    ? new Date(supplementalData.closingDate)
    : null;
  const requestedDate = supplementalData.requestedDate
    ? new Date(supplementalData.requestedDate)
    : null;
  const dates = await calculateDates(closingDate, requestedDate, quote.clientId);

  return withTransaction(
    async (tx) => {
      const orderNumber = await getNextSequence("ORDER");

      const order = await tx.order.create({
        data: {
          orderNumber,
          quoteId: quote.id,
          clientId: quote.clientId,
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
          surveyType: quote.surveyType!,
          price: quote.price,
          paymentTerms:
            (supplementalData.paymentTerms as PaymentTerms | undefined) ??
            quote.paymentTerms ??
            "pre_pay",
          closingDate,
          onsiteContactFirstName: supplementalData.onsiteContactFirstName,
          onsiteContactLastName: supplementalData.onsiteContactLastName,
          onsiteContactPhone: supplementalData.onsiteContactPhone,
          lockedGates: supplementalData.lockedGates as LockedGates | undefined,
          deliveryPreference: supplementalData.deliveryPreference as DeliveryPreference | undefined,
          legalDescription: supplementalData.legalDescription,
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
        where: { id: quoteId },
        data: { status: QuoteStatus.accepted, updatedBy: userId },
      });

      logger.info("Order created from quote", {
        quoteId,
        orderId: order.id,
        orderNumber,
      });

      return { order, client: quote.client };
    },
    "Serializable"
  );
}

// ─── list ─────────────────────────────────────────────────────────────────────
// drop_dead_date and internal_closing_date are intentionally omitted from the
// list response — they are admin-only fields handled by route serialization.

export async function list(
  filters: OrderFilters,
  page: number,
  limit: number,
  teamFilter?: { team?: string }
): Promise<{ data: object[]; total: number }> {
  logger.info("Listing orders", { page, limit, filters, teamFilter });
  const where: Prisma.OrderWhereInput = {
    deletedAt: null,
    ...(teamFilter?.team ? { team: teamFilter.team as Team } : {}),
    ...(filters.status ? { status: filters.status as OrderStatus } : {}),
    ...(filters.county
      ? { propertyCounty: filters.county as County }
      : {}),
    ...(filters.surveyType ? { surveyType: filters.surveyType as SurveyType } : {}),
    ...(filters.dateFrom || filters.dateTo
      ? {
          createdAt: {
            ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
            ...(filters.dateTo ? { lte: filters.dateTo } : {}),
          },
        }
      : {}),
    ...(filters.dueDateFrom || filters.dueDateTo
      ? {
          dueDate: {
            ...(filters.dueDateFrom ? { gte: filters.dueDateFrom } : {}),
            ...(filters.dueDateTo ? { lte: filters.dueDateTo } : {}),
          },
        }
      : {}),
    ...(filters.paymentStatus
      ? { invoices: { some: { status: filters.paymentStatus as InvoiceStatus } } }
      : {}),
  };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, email: true } },
        jobs: { select: { id: true, jobNumber: true, status: true } },
      },
    }),
    prisma.order.count({ where }),
  ]);

  // Strip admin-only sensitive date fields from list payload
  const data = orders.map((o) => {
    const { dropDeadDate: _ddd, internalClosingDate: _icd, ...rest } =
      o as unknown as Record<string, unknown>;
    return rest;
  });

  return { data, total };
}

// ─── getById ──────────────────────────────────────────────────────────────────

export async function getById(id: string): Promise<object> {
  logger.info("Getting order by ID", { orderId: id });
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      client: true,
      billingClient: true,
      quote: { select: { id: true, quoteNumber: true, status: true } },
      jobs: true,
      invoices: {
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          totalAmount: true,
          balanceDue: true,
          dueDate: true,
        },
      },
    },
  });

  if (!order || order.deletedAt) {
    logger.warn("Order not found", { orderId: id });
    throw new NotFoundError(`Order ${id} not found`);
  }

  logger.info("Order retrieved", { orderId: id, orderNumber: order.orderNumber, status: order.status });
  return order;
}

// ─── update ───────────────────────────────────────────────────────────────────

export async function update(
  id: string,
  data: Partial<CreateOrderData>,
  userId: string
): Promise<object> {
  logger.info("Updating order", { orderId: id, userId, fields: Object.keys(data) });
  const existing = await prisma.order.findUnique({
    where: { id },
    select: { id: true, deletedAt: true, clientId: true, closingDate: true, internalNotes: true },
  });

  if (!existing || existing.deletedAt) {
    logger.warn("Order update failed — not found", { orderId: id });
    throw new NotFoundError(`Order ${id} not found`);
  }

  let dateFields: Record<string, unknown> = {};
  if (data.closingDate !== undefined || data.requestedDate !== undefined) {
    const closingDate = data.closingDate
      ? new Date(data.closingDate)
      : existing.closingDate ?? null;
    const requestedDate = data.requestedDate ? new Date(data.requestedDate) : null;
    const dates = await calculateDates(closingDate, requestedDate, existing.clientId);
    dateFields = {
      dropDeadDate: dates.dropDeadDate,
      internalClosingDate: dates.internalClosingDate,
      dueDate: dates.dueDate,
      isRush: dates.isRush,
    };
  }

  return prisma.order.update({
    where: { id },
    data: {
      ...(data.billingClientId !== undefined ? { billingClientId: data.billingClientId } : {}),
      ...(data.orderType ? { orderType: data.orderType as OrderType } : {}),
      ...(data.propertyAddressLine1
        ? { propertyAddressLine1: data.propertyAddressLine1 }
        : {}),
      ...(data.propertyAddressLine2 !== undefined
        ? { propertyAddressLine2: data.propertyAddressLine2 }
        : {}),
      ...(data.propertyCity ? { propertyCity: data.propertyCity } : {}),
      ...(data.propertyState ? { propertyState: data.propertyState } : {}),
      ...(data.propertyZip ? { propertyZip: data.propertyZip } : {}),
      ...(data.propertyCounty ? { propertyCounty: data.propertyCounty as County } : {}),
      ...(data.pin ? { pin: data.pin } : {}),
      ...(data.additionalPins !== undefined ? { additionalPins: data.additionalPins } : {}),
      ...(data.propertyType ? { propertyType: data.propertyType as PropertyType } : {}),
      ...(data.surveyType ? { surveyType: data.surveyType as SurveyType } : {}),
      ...(data.price !== undefined ? { price: data.price } : {}),
      ...(data.paymentTerms ? { paymentTerms: data.paymentTerms as PaymentTerms } : {}),
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
      ...(data.priority ? { priority: data.priority as Priority } : {}),
      ...(data.team ? { team: data.team as Team } : {}),
      ...(data.suppressClientEmails !== undefined
        ? { suppressClientEmails: data.suppressClientEmails }
        : {}),
      ...(data.internalNotes !== undefined ? { internalNotes: data.internalNotes } : {}),
      ...(data.referralSource !== undefined ? { referralSource: data.referralSource } : {}),
      ...dateFields,
      updatedBy: userId,
    },
  });
}

// ─── transitionStatus ─────────────────────────────────────────────────────────

export async function transitionStatus(
  id: string,
  toStatus: OrderStatus,
  notes?: string,
  userId?: string,
  io?: { emit?: (event: string, data: unknown) => void }
): Promise<object> {
  logger.info("Transitioning order status", { orderId: id, toStatus, userId });
  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true,
      deletedAt: true,
      status: true,
      team: true,
      internalNotes: true,
    },
  });

  if (!order || order.deletedAt) {
    logger.warn("Order transition failed — not found", { orderId: id });
    throw new NotFoundError(`Order ${id} not found`);
  }

  if (!canTransition("order", order.status, toStatus)) {
    logger.warn("Order transition failed — invalid transition", { orderId: id, fromStatus: order.status, toStatus });
    throw new ValidationError(
      `Cannot transition order from '${order.status}' to '${toStatus}'`
    );
  }

  logger.info("Order status transition validated", { orderId: id, fromStatus: order.status, toStatus });

  // Side-effect: create a field job when order reaches ready_for_field
  if (toStatus === OrderStatus.ready_for_field) {
    return withTransaction(async (tx) => {
      const fullOrder = await tx.order.findUnique({
        where: { id },
        select: {
          team: true,
          internalNotes: true,
          propertyAddressLine1: true,
          propertyAddressLine2: true,
          propertyCity: true,
          propertyState: true,
          propertyZip: true,
          propertyCounty: true,
          pin: true,
          additionalPins: true,
          pinLatitude: true,
          pinLongitude: true,
          dropDeadDate: true,
        },
      });

      const jobNumber = await getNextSequence("JOB");

      const job = await tx.job.create({
        data: {
          jobNumber,
          orderId: id,
          status: JobStatus.unassigned,
          team: fullOrder!.team ?? "residential",
          createdBy: userId,
          propertyAddressLine1: fullOrder!.propertyAddressLine1,
          propertyAddressLine2: fullOrder!.propertyAddressLine2,
          propertyCity: fullOrder!.propertyCity,
          propertyState: fullOrder!.propertyState,
          propertyZip: fullOrder!.propertyZip,
          propertyCounty: fullOrder!.propertyCounty,
          pin: fullOrder!.pin,
          additionalPins: fullOrder!.additionalPins ?? [],
          propertyLat: fullOrder!.pinLatitude,
          propertyLng: fullOrder!.pinLongitude,
          internalDueDate: fullOrder!.dropDeadDate
            ? subDays(fullOrder!.dropDeadDate, 3)
            : null,
        },
      });

      const appendedNotes =
        notes && fullOrder!.internalNotes
          ? `${fullOrder!.internalNotes}\n${notes}`
          : notes ?? fullOrder!.internalNotes ?? null;

      const updatedOrder = await tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.ready_for_field,
          updatedBy: userId,
          ...(appendedNotes !== null ? { internalNotes: appendedNotes } : {}),
        },
      });

      logger.info("Order transitioned to ready_for_field, job created", {
        orderId: id,
        jobId: job.id,
        jobNumber,
      });

      io?.emit?.("dashboard:jobs", {
        event: "job:created",
        job: { id: job.id, jobNumber, orderId: id, team: fullOrder!.team },
      });

      return { ...updatedOrder, job };
    });
  }

  const appendedNotes =
    notes && order.internalNotes
      ? `${order.internalNotes}\n${notes}`
      : notes ?? order.internalNotes ?? undefined;

  return prisma.order.update({
    where: { id },
    data: {
      status: toStatus as Exclude<OrderStatus, "draft" | "ready_for_field">,
      updatedBy: userId,
      ...(appendedNotes !== undefined ? { internalNotes: appendedNotes } : {}),
    },
  });
}
