import type { Server as SocketServer } from "socket.io";
import { StakingRequestStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { NotFoundError } from "../lib/errors";
import { ROOM_PREFIXES } from "../lib/socket-rooms";
import { jobLogger as logger } from "../lib/logger";

const STAKING_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

export async function createRequest(
  jobId: string,
  requestedBy: string,
  notes?: string,
  io?: SocketServer
): Promise<unknown> {
  logger.info("Creating staking request", { jobId, requestedBy });
  const job = await prisma.job.findFirst({ where: { id: jobId, deletedAt: null } });
  if (!job) {
    logger.warn("Staking request failed — job not found", { jobId });
    throw new NotFoundError("Job not found");
  }

  const timeoutAt = new Date(Date.now() + STAKING_TIMEOUT_MS);

  const request = await prisma.stakingRequest.create({
    data: {
      jobId,
      requestedBy,
      status: StakingRequestStatus.pending,
      requestedAt: new Date(),
      timeoutAt,
      notes,
    },
    include: {
      requestedByUser: { select: { id: true, name: true, email: true } },
    },
  });

  io?.to(ROOM_PREFIXES.DASHBOARD_JOBS).emit("staking:requested", {
    jobId,
    jobNumber: job.jobNumber,
    requestId: request.id,
  });

  io?.to(ROOM_PREFIXES.STAKING(jobId)).emit("staking:new", {
    jobId,
    requestId: request.id,
    requestedAt: request.requestedAt,
    timeoutAt: request.timeoutAt,
  });

  logger.info("Staking request created", { jobId, requestId: request.id });
  return request;
}

export async function respond(
  requestId: string,
  respondedBy: string,
  notes?: string,
  io?: SocketServer
): Promise<unknown> {
  logger.info("Responding to staking request", { requestId, respondedBy });
  const request = await prisma.stakingRequest.findUnique({ where: { id: requestId } });
  if (!request) {
    logger.warn("Staking response failed — request not found", { requestId });
    throw new NotFoundError("Staking request not found");
  }

  const updated = await prisma.stakingRequest.update({
    where: { id: requestId },
    data: {
      status: StakingRequestStatus.completed,
      respondedAt: new Date(),
      respondedBy,
      ...(notes !== undefined ? { notes } : {}),
    },
    include: {
      respondedByUser: { select: { id: true, name: true, email: true } },
    },
  });

  io?.to(ROOM_PREFIXES.STAKING(request.jobId)).emit("staking:responded", {
    requestId,
    jobId: request.jobId,
    status: StakingRequestStatus.completed,
    respondedAt: updated.respondedAt,
  });

  io?.to(ROOM_PREFIXES.DASHBOARD_JOBS).emit("staking:updated", {
    jobId: request.jobId,
    requestId,
    status: StakingRequestStatus.completed,
  });

  logger.info("Staking request responded", { requestId, jobId: request.jobId });
  return updated;
}

export async function checkTimeouts(): Promise<number> {
  const now = new Date();

  const result = await prisma.stakingRequest.updateMany({
    where: {
      status: StakingRequestStatus.pending,
      timeoutAt: { lt: now },
    },
    data: { status: StakingRequestStatus.timed_out },
  });

  if (result.count > 0) {
    logger.info("Staking requests timed out", { count: result.count });
  }

  return result.count;
}
