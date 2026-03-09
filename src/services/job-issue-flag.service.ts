import { prisma } from "../lib/prisma";
import { ChatEntityType, IssueFlagCategory, IssueFlagSeverity, IssueFlagStatus } from "@prisma/client";
import { NotFoundError } from "../lib/errors";
import { jobLogger as logger } from "../lib/logger";
import { createSystemEvent as createChatSystemEvent } from "./chat.service";

export async function getFlags(jobId: string) {
  return prisma.jobIssueFlag.findMany({
    where: { jobId },
    include: {
      raisedBy: { select: { id: true, name: true } },
      resolvedBy: { select: { id: true, name: true } },
    },
    orderBy: [{ status: "asc" }, { raisedAt: "desc" }],
  });
}

export async function raiseFlag(
  jobId: string,
  userId: string,
  category: IssueFlagCategory,
  severity: IssueFlagSeverity,
  description: string
) {
  logger.info("Raising issue flag", { jobId, userId, category, severity });
  const flag = await prisma.jobIssueFlag.create({
    data: { jobId, category, severity, description, raisedById: userId },
    include: { raisedBy: { select: { id: true, name: true } } },
  });

  await createChatSystemEvent({
    entityType: ChatEntityType.job,
    entityId: jobId,
    eventType: "issue_flagged",
    content: `🚩 Issue flagged: **${category.replace(/_/g, " ")}** (${severity}) — ${description}`,
    metadata: { flagId: flag.id, category, severity },
    userId,
  });

  return flag;
}

export async function resolveFlag(flagId: string, userId: string, resolutionNote: string) {
  logger.info("Resolving issue flag", { flagId, userId });
  const flag = await prisma.jobIssueFlag.findUnique({ where: { id: flagId } });
  if (!flag) throw new NotFoundError("Issue flag");

  const resolved = await prisma.jobIssueFlag.update({
    where: { id: flagId },
    data: {
      status: IssueFlagStatus.resolved,
      resolvedById: userId,
      resolvedAt: new Date(),
      resolutionNote,
    },
    include: {
      raisedBy: { select: { id: true, name: true } },
      resolvedBy: { select: { id: true, name: true } },
    },
  });

  await createChatSystemEvent({
    entityType: ChatEntityType.job,
    entityId: flag.jobId,
    eventType: "issue_resolved",
    content: `✅ Issue resolved: ${resolutionNote}`,
    metadata: { flagId, resolutionNote },
    userId,
  });

  return resolved;
}

export async function hasOpenCriticalFlags(jobId: string): Promise<boolean> {
  const count = await prisma.jobIssueFlag.count({
    where: { jobId, status: IssueFlagStatus.open, severity: IssueFlagSeverity.critical },
  });
  return count > 0;
}
