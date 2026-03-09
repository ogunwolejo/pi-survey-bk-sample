import { ChatEntityType, Prisma, CustomerType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { withTransaction } from "../lib/transaction";
import { contactLogger as logger } from "../lib/logger";
import { NotFoundError, ConflictError, ValidationError } from "../lib/errors";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ContactFilters {
  search?: string;
  customerType?: string;
  team?: string;
  source?: string;
}

export interface CreateContactData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  customerType: "homeowner" | "attorney" | "title_company" | "other";
  paymentTerms?: string;
  preferredPaymentMethod?: string;
  vip?: boolean;
  creditLimit?: number;
  communicationPreferences?: Record<string, unknown>;
  operationalNotes?: string;
  source: "order_form" | "quote_form" | "internal" | "imported";
  createdBy?: string;
}

export interface UpdateContactData {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  customerType?: string;
  paymentTerms?: string;
  preferredPaymentMethod?: string;
  vip?: boolean;
  creditLimit?: number;
  communicationPreferences?: Record<string, unknown>;
  operationalNotes?: string;
  updatedBy?: string;
}

// ─── findOrCreateFromSubmission ───────────────────────────────────────────────

export async function findOrCreateFromSubmission(
  data: CreateContactData
): Promise<object> {
  logger.info("Finding or creating contact from submission", { email: data.email, source: data.source });

  return withTransaction(async (tx) => {
    const existing = await tx.client.findUnique({
      where: { email: data.email },
    });

    if (existing) {
      logger.info("Existing contact found", { contactId: existing.id, email: data.email });
      const patch: Record<string, unknown> = {};
      if (!existing.phone && data.phone) patch["phone"] = data.phone;
      if (!existing.addressLine1 && data.addressLine1) patch["addressLine1"] = data.addressLine1;
      if (!existing.city && data.city) patch["city"] = data.city;
      if (!existing.state && data.state) patch["state"] = data.state;
      if (!existing.zipCode && data.zipCode) patch["zipCode"] = data.zipCode;

      if (Object.keys(patch).length > 0) {
        logger.info("Backfilling contact fields", { contactId: existing.id, fields: Object.keys(patch) });
        return tx.client.update({ where: { id: existing.id }, data: patch });
      }
      return existing;
    }

    const created = await tx.client.create({ data: data as Prisma.ClientUncheckedCreateInput });
    logger.info("New contact created", { contactId: (created as { id: string }).id, email: data.email });
    return created;
  });
}

// ─── list ─────────────────────────────────────────────────────────────────────

export async function list(
  filters: ContactFilters,
  page: number,
  limit: number,
  teamFilter?: { team?: string }
): Promise<{ data: object[]; total: number }> {
  logger.info("Listing contacts", { page, limit, filters });
  const where: Prisma.ClientWhereInput = {
    deletedAt: null,
    ...(teamFilter?.team
      ? {
          ordersAsClient: {
            some: { team: teamFilter.team as "residential" | "public" },
          },
        }
      : {}),
    ...(filters.customerType
      ? { customerType: filters.customerType as CustomerType }
      : {}),
    ...(filters.search
      ? {
          OR: [
            { firstName: { contains: filters.search, mode: "insensitive" as const } },
            { lastName: { contains: filters.search, mode: "insensitive" as const } },
            { email: { contains: filters.search, mode: "insensitive" as const } },
            { phone: { contains: filters.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [data, total] = await Promise.all([
    prisma.client.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { clientDeliveryPreferences: true },
    }),
    prisma.client.count({ where }),
  ]);

  return { data, total };
}

// ─── getById ─────────────────────────────────────────────────────────────────

export async function getById(id: string): Promise<object> {
  logger.info("Getting contact by ID", { contactId: id });
  const contact = await prisma.client.findUnique({
    where: { id },
    include: {
      clientDeliveryPreferences: true,
      companyContacts: {
        include: { company: true },
      },
    },
  });

  if (!contact || contact.deletedAt) {
    logger.warn("Contact not found", { contactId: id });
    throw new NotFoundError(`Contact ${id} not found`);
  }

  logger.info("Contact retrieved", { contactId: id, email: contact.email });
  return contact;
}

// ─── create ───────────────────────────────────────────────────────────────────

export async function create(data: CreateContactData): Promise<object> {
  logger.info("Creating contact", { email: data.email, customerType: data.customerType, source: data.source });
  try {
    const contact = await prisma.client.create({ data: data as Prisma.ClientUncheckedCreateInput });
    logger.info("Contact created", { contactId: (contact as { id: string }).id, email: data.email });
    return contact;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      logger.warn("Contact creation failed — duplicate email", { email: data.email });
      throw new ConflictError("A contact with this email already exists");
    }
    logger.error("Contact creation failed", { email: data.email, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// ─── update ───────────────────────────────────────────────────────────────────

export async function update(id: string, data: UpdateContactData): Promise<object> {
  logger.info("Updating contact", { contactId: id, fields: Object.keys(data) });
  await assertExists(id);

  const updated = await prisma.client.update({ where: { id }, data: data as Prisma.ClientUncheckedUpdateInput });
  logger.info("Contact updated", { contactId: id });
  return updated;
}

// ─── softDelete ───────────────────────────────────────────────────────────────

export async function softDelete(id: string): Promise<void> {
  logger.info("Soft-deleting contact", { contactId: id });
  await assertExists(id);

  const activeOrders = await prisma.order.count({
    where: {
      clientId: id,
      deletedAt: null,
      status: {
        notIn: ["ready_for_field"],
      },
    },
  });

  if (activeOrders > 0) {
    logger.warn("Contact delete blocked — has active orders", { contactId: id, activeOrders });
    throw new ValidationError("Cannot delete contact with active orders");
  }

  await prisma.client.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  logger.info("Contact soft-deleted", { contactId: id });
}

// ─── getOrderHistory ─────────────────────────────────────────────────────────

export async function getOrderHistory(
  contactId: string,
  page: number,
  limit: number
): Promise<{ data: object[]; total: number }> {
  const where: Prisma.OrderWhereInput = {
    clientId: contactId,
    deletedAt: null,
  };

  const [data, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { jobs: { select: { id: true, jobNumber: true, status: true } } },
    }),
    prisma.order.count({ where }),
  ]);

  return { data, total };
}

// ─── getActivityFeed ─────────────────────────────────────────────────────────

export async function getActivityFeed(
  contactId: string,
  page: number,
  limit: number
): Promise<{ data: object[]; total: number }> {
  const jobIds = await prisma.job.findMany({
    where: { order: { clientId: contactId, deletedAt: null }, deletedAt: null },
    select: { id: true },
  });
  const ids = jobIds.map((j) => j.id);
  if (ids.length === 0) return { data: [], total: 0 };

  const where: Prisma.ChatMessageWhereInput = {
    entityType: ChatEntityType.job,
    entityId: { in: ids },
    deletedAt: null,
  };

  const [data, total] = await Promise.all([
    prisma.chatMessage.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        author: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.chatMessage.count({ where }),
  ]);

  return { data, total };
}

// ─── addCompanyAssociation ───────────────────────────────────────────────────

export async function addCompanyAssociation(
  contactId: string,
  companyId: string,
  role: string,
  isPrimary: boolean
): Promise<object> {
  await assertExists(contactId);

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new NotFoundError(`Company ${companyId} not found`);

  try {
    if (isPrimary) {
      // Clear existing primary for this contact in this company
      await prisma.companyContact.updateMany({
        where: { clientId: contactId, companyId },
        data: { isPrimary: false },
      });
    }

    return await prisma.companyContact.upsert({
      where: { companyId_clientId: { companyId, clientId: contactId } },
      update: { role, isPrimary },
      create: { companyId, clientId: contactId, role, isPrimary },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ConflictError("Association already exists");
    }
    throw err;
  }
}

// ─── removeCompanyAssociation ─────────────────────────────────────────────────

export async function removeCompanyAssociation(
  contactId: string,
  companyId: string
): Promise<void> {
  const record = await prisma.companyContact.findUnique({
    where: { companyId_clientId: { companyId, clientId: contactId } },
  });

  if (!record) {
    throw new NotFoundError("Company association not found");
  }

  await prisma.companyContact.delete({
    where: { companyId_clientId: { companyId, clientId: contactId } },
  });
}

// ─── exportToCsv ─────────────────────────────────────────────────────────────

export async function exportToCsv(filters: ContactFilters): Promise<object[]> {
  const where: Prisma.ClientWhereInput = {
    deletedAt: null,
    ...(filters.customerType
      ? { customerType: filters.customerType as CustomerType }
      : {}),
    ...(filters.search
      ? {
          OR: [
            { firstName: { contains: filters.search, mode: "insensitive" as const } },
            { lastName: { contains: filters.search, mode: "insensitive" as const } },
            { email: { contains: filters.search, mode: "insensitive" as const } },
            { phone: { contains: filters.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  return prisma.client.findMany({
    where,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      customerType: true,
      addressLine1: true,
      city: true,
      state: true,
      zipCode: true,
      totalOrders: true,
      createdAt: true,
    },
  });
}

// ─── findDuplicates ───────────────────────────────────────────────────────────

export async function findDuplicates(): Promise<object[]> {
  // Since email is unique, look for same (lastName + phone) combos
  const contacts = await prisma.client.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      createdAt: true,
    },
    orderBy: [{ lastName: "asc" }, { phone: "asc" }],
  });

  const groups: Record<string, typeof contacts> = {};
  for (const c of contacts) {
    const groupKey = `${c.lastName.toLowerCase()}::${c.phone.replace(/\D/g, "")}`;
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey]!.push(c);
  }

  return Object.values(groups)
    .filter((g) => g.length > 1)
    .map((g) => ({ group: g }));
}

// ─── merge ────────────────────────────────────────────────────────────────────

export async function merge(
  primaryId: string,
  secondaryId: string,
  userId: string
): Promise<object> {
  logger.info("Merging contacts", { primaryId, secondaryId, userId });
  if (primaryId === secondaryId) {
    logger.warn("Contact merge failed — same contact", { primaryId });
    throw new ValidationError("Primary and secondary contacts must be different");
  }

  const [primary, secondary] = await Promise.all([
    prisma.client.findUnique({ where: { id: primaryId } }),
    prisma.client.findUnique({ where: { id: secondaryId } }),
  ]);

  if (!primary || primary.deletedAt) throw new NotFoundError(`Primary contact ${primaryId} not found`);
  if (!secondary || secondary.deletedAt) throw new NotFoundError(`Secondary contact ${secondaryId} not found`);

  return withTransaction(async (tx) => {
    await Promise.all([
      tx.order.updateMany({
        where: { clientId: secondaryId },
        data: { clientId: primaryId },
      }),
      tx.order.updateMany({
        where: { billingClientId: secondaryId },
        data: { billingClientId: primaryId },
      }),
      tx.quote.updateMany({
        where: { clientId: secondaryId },
        data: { clientId: primaryId },
      }),
      tx.quote.updateMany({
        where: { billingClientId: secondaryId },
        data: { billingClientId: primaryId },
      }),
      tx.invoice.updateMany({
        where: { clientId: secondaryId },
        data: { clientId: primaryId },
      }),
    ]);

    const merged = await tx.client.update({
      where: { id: secondaryId },
      data: { deletedAt: new Date(), deletedBy: userId },
    });

    logger.info("Contacts merged", { primaryId, secondaryId, userId });
    return merged;
  });
}

// ─── internal helper ─────────────────────────────────────────────────────────

async function assertExists(id: string): Promise<void> {
  const contact = await prisma.client.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  if (!contact || contact.deletedAt) {
    throw new NotFoundError(`Contact ${id} not found`);
  }
}
