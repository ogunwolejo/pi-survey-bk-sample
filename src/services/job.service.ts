import type { Server as SocketServer } from "socket.io";
import { ChatEntityType, Prisma, JobStatus, DeliveryChecklistStatus, DeliveryTrackingStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { withTransaction } from "../lib/transaction";
import { canTransition } from "../lib/status-engine";
import { NotFoundError, ValidationError } from "../lib/errors";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { jobLogger as logger } from "../lib/logger";
import { createSystemEvent as createChatSystemEvent } from "./chat.service";

type DeliveryMethod = "pdf_only" | "pdf_usps" | "pdf_fedex";

function buildChecklistItems(method: DeliveryMethod): Array<{
  stepKey: string;
  label: string;
  sortOrder: number;
  isRequired: boolean;
}> {
  const base = [
    { stepKey: "generate_pdf", label: "Generate Survey PDF", sortOrder: 1, isRequired: true },
    { stepKey: "quality_check", label: "Quality Check", sortOrder: 2, isRequired: true },
  ];
  if (method === "pdf_usps") {
    return [
      ...base,
      { stepKey: "print_document", label: "Print Document", sortOrder: 3, isRequired: true },
      { stepKey: "prepare_envelope", label: "Prepare Envelope", sortOrder: 4, isRequired: true },
      { stepKey: "ship_usps", label: "Ship via USPS", sortOrder: 5, isRequired: true },
    ];
  }
  if (method === "pdf_fedex") {
    return [
      ...base,
      { stepKey: "print_document", label: "Print Document", sortOrder: 3, isRequired: true },
      { stepKey: "prepare_package", label: "Prepare Package", sortOrder: 4, isRequired: true },
      { stepKey: "ship_fedex", label: "Ship via FedEx", sortOrder: 5, isRequired: true },
    ];
  }
  return [
    ...base,
    { stepKey: "email_delivery", label: "Send Email to Client", sortOrder: 3, isRequired: true },
  ];
}

export interface JobFilters {
  status?: string;
  assignedCrewId?: string;
  dateFrom?: string;
  dateTo?: string;
  stakingRequired?: boolean;
  team?: string;
}

export async function list(
  filters: JobFilters,
  page: number,
  limit: number,
  isAdmin = false
): Promise<{ data: unknown[]; total: number; page: number; limit: number }> {
  logger.info("Listing jobs", { page, limit, filters, isAdmin });
  const where: Prisma.JobWhereInput = {
    deletedAt: null,
    ...(filters.team ? { team: filters.team as "residential" | "public" } : {}),
    ...(filters.status ? { status: filters.status as JobStatus } : {}),
    ...(filters.assignedCrewId ? { assignedCrewId: filters.assignedCrewId } : {}),
    ...(filters.dateFrom ?? filters.dateTo
      ? {
          fieldDate: {
            ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
            ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
          },
        }
      : {}),
    ...(filters.stakingRequired !== undefined
      ? { stakingRequired: filters.stakingRequired }
      : {}),
  };

  const [total, jobs] = await Promise.all([
    prisma.job.count({ where }),
    prisma.job.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        assignedCrew: { select: { id: true, name: true } },
        order: {
          select: {
            orderNumber: true,
            dropDeadDate: true,
            dueDate: true,
            propertyAddressLine1: true,
            propertyCity: true,
            propertyState: true,
            client: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    }),
  ]);

  const data = jobs.map((job) => ({
    ...job,
    order: job.order
      ? { ...job.order, dropDeadDate: isAdmin ? job.order.dropDeadDate : null }
      : null,
  }));

  return { data, total, page, limit };
}

export async function getById(id: string, isAdmin = false): Promise<unknown> {
  logger.info("Getting job by ID", { jobId: id, isAdmin });
  const job = await prisma.job.findFirst({
    where: { id, deletedAt: null },
    include: {
      order: {
        include: {
          client: { select: { id: true, firstName: true, lastName: true, email: true } },
          quote: { select: { id: true, quoteNumber: true, status: true } },
        },
      },
      assignedCrew: true,
      stakingRequests: {
        orderBy: { requestedAt: "desc" },
        include: {
          requestedByUser: { select: { id: true, name: true, email: true } },
          respondedByUser: { select: { id: true, name: true, email: true } },
        },
      },
    },
  });

  if (!job) {
    logger.warn("Job not found", { jobId: id });
    throw new NotFoundError("Job not found");
  }

  logger.info("Job retrieved", { jobId: id, jobNumber: job.jobNumber, status: job.status });
  return {
    ...job,
    order: job.order
      ? { ...job.order, dropDeadDate: isAdmin ? job.order.dropDeadDate : null }
      : null,
  };
}

export async function assignCrew(
  id: string,
  crewId: string,
  fieldDate: string,
  notes?: string,
  userId?: string,
  io?: SocketServer
): Promise<unknown> {
  logger.info("Assigning crew to job", { jobId: id, crewId, fieldDate, userId });
  const job = await prisma.job.findFirst({ where: { id, deletedAt: null } });
  if (!job) {
    logger.warn("Job assignment failed — job not found", { jobId: id });
    throw new NotFoundError("Job not found");
  }

  if (!canTransition("job", job.status, JobStatus.assigned)) {
    logger.warn("Job assignment failed — invalid transition", { jobId: id, fromStatus: job.status });
    throw new ValidationError(`Cannot transition job from '${job.status}' to '${JobStatus.assigned}'`);
  }

  const crew = await prisma.crew.findFirst({ where: { id: crewId, isActive: true } });
  if (!crew) {
    logger.warn("Job assignment failed — crew not found", { crewId });
    throw new NotFoundError("Crew not found");
  }

  const updated = await withTransaction(async (tx) => {
    const result = await tx.job.update({
      where: { id },
      data: {
        assignedCrewId: crewId,
        fieldDate: new Date(fieldDate),
        status: JobStatus.assigned,
        updatedBy: userId,
      },
      include: { assignedCrew: { select: { id: true, name: true } } },
    });

    await tx.entityAuditLog.create({
      data: {
        entityType: "job",
        entityId: job.id,
        entityNumber: job.jobNumber,
        action: "updated",
        userId: userId ?? null,
        userName: userId ?? "system",
        changedAt: new Date(),
        changes: { from: job.status, to: JobStatus.assigned, crewId, fieldDate, notes },
        changeSummary: `Job assigned to crew '${crew.name}' for ${fieldDate}`,
        source: "web_portal",
      },
    });

    return result;
  });

  io?.to(ROOM_PREFIXES.USER(crewId)).emit("job:assigned", {
    jobId: job.id,
    jobNumber: job.jobNumber,
    fieldDate,
  });

  io?.to(ROOM_PREFIXES.DASHBOARD_JOBS).emit("job:updated", { jobId: job.id });

  logger.info("Job assigned", { jobId: job.id, crewId });
  return updated;
}

export async function bulkAssign(
  jobIds: string[],
  crewId: string,
  fieldDate: string,
  userId?: string
): Promise<{ updated: number }> {
  logger.info("Bulk assigning jobs", { jobCount: jobIds.length, crewId, fieldDate, userId });
  const crew = await prisma.crew.findFirst({ where: { id: crewId, isActive: true } });
  if (!crew) {
    logger.warn("Bulk assignment failed — crew not found", { crewId });
    throw new NotFoundError("Crew not found");
  }

  const result = await prisma.job.updateMany({
    where: { id: { in: jobIds }, status: JobStatus.unassigned, deletedAt: null },
    data: {
      assignedCrewId: crewId,
      fieldDate: new Date(fieldDate),
      status: JobStatus.assigned,
      updatedBy: userId,
    },
  });

  logger.info("Bulk job assignment", { crewId, count: result.count });
  return { updated: result.count };
}

export async function transitionStatus(
  id: string,
  toStatus: JobStatus,
  notes?: string,
  userId?: string,
  userName?: string
): Promise<unknown> {
  logger.info("Transitioning job status", { jobId: id, toStatus, userId });
  const job = await prisma.job.findFirst({
    where: { id, deletedAt: null },
    include: { order: { select: { deliveryPreference: true } } },
  });
  if (!job) {
    logger.warn("Job transition failed — not found", { jobId: id });
    throw new NotFoundError("Job not found");
  }

  if (!canTransition("job", job.status, toStatus)) {
    logger.warn("Job transition failed — invalid transition", { jobId: id, fromStatus: job.status, toStatus });
    throw new ValidationError(`Cannot transition from '${job.status}' to '${toStatus}'`);
  }

  logger.info("Job status transition validated", { jobId: id, fromStatus: job.status, toStatus });

  const updated = await withTransaction(async (tx) => {
    const result = await tx.job.update({
      where: { id },
      data: { status: toStatus, updatedBy: userId },
    });

    await tx.entityAuditLog.create({
      data: {
        entityType: "job",
        entityId: job.id,
        entityNumber: job.jobNumber,
        action: "updated",
        userId: userId ?? null,
        userName: userName ?? userId ?? "system",
        changedAt: new Date(),
        changes: { from: job.status, to: toStatus, notes },
        changeSummary: `Status changed from '${job.status}' to '${toStatus}'${notes ? `: ${notes}` : ""}`,
        source: "web_portal",
      },
    });

    if (toStatus === JobStatus.complete) {
      logger.info("Job completed — creating delivery checklist and tracking", { jobId: id, orderId: job.orderId });
      const deliveryMethod: DeliveryMethod =
        (job.order?.deliveryPreference as DeliveryMethod | null | undefined) ?? "pdf_only";

      await tx.deliveryChecklist.create({
        data: {
          orderId: job.orderId,
          jobId: job.id,
          deliveryMethod,
          status: DeliveryChecklistStatus.not_started,
          items: { create: buildChecklistItems(deliveryMethod) },
        },
      });

      await tx.deliveryTracking.create({
        data: {
          orderId: job.orderId,
          jobId: job.id,
          deliveryMethod,
          status: DeliveryTrackingStatus.preparing,
        },
      });
    }

    logger.info("Job status transitioned", { jobId: id, fromStatus: job.status, toStatus });
    return result;
  });

  await createChatSystemEvent({
    entityType: ChatEntityType.job,
    entityId: job.id,
    eventType: "status_change",
    content: `Status changed to ${toStatus.replace(/_/g, " ")}${notes ? ` — ${notes}` : ""}`,
    metadata: { from: job.status, to: toStatus },
    userId,
  });

  return updated;
}

export async function getByCrewAndDate(crewId: string, date: Date): Promise<unknown[]> {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  return prisma.job.findMany({
    where: {
      assignedCrewId: crewId,
      fieldDate: { gte: startOfDay, lte: endOfDay },
      deletedAt: null,
    },
    include: {
      order: {
        select: {
          orderNumber: true,
          propertyAddressLine1: true,
          propertyAddressLine2: true,
          propertyCity: true,
          propertyState: true,
          propertyZip: true,
          propertyCounty: true,
          client: {
            select: { id: true, firstName: true, lastName: true, phone: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}
