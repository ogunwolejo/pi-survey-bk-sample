import type { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generalLogger as logger } from "../lib/logger";
import { humanizeChangeSummary } from "../lib/field-labels";

interface AuditOptions {
  entityType: string;
  getEntityId: (req: Request) => string;
  getEntityNumber?: (req: Request, res: Response) => string | null;
}

function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, { old: unknown; new: unknown }> {
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    if (key === "updatedAt" || key === "updatedBy") continue;
    const oldVal = before[key];
    const newVal = after[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes[key] = { old: oldVal, new: newVal };
    }
  }
  return changes;
}

function summarize(changes: Record<string, { old: unknown; new: unknown }>): string {
  return humanizeChangeSummary(changes, "Changed");
}

/**
 * Express middleware factory that captures before/after state of an entity
 * and writes an audit log entry after the response completes.
 *
 * Usage: router.put("/:id", requireAuth, auditMiddleware({ entityType: "orders", getEntityId: (req) => req.params.id }), handler)
 */
export function auditMiddleware(options: AuditOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const entityId = options.getEntityId(req);
    if (!entityId) {
      next();
      return;
    }

    let beforeSnapshot: Record<string, unknown> | null = null;

    try {
      const model = (prisma as unknown as Record<string, unknown>)[toPrismaModel(options.entityType)];
      if (model && typeof model === "object" && "findUnique" in model) {
        const found = await (model as { findUnique: (args: unknown) => Promise<unknown> }).findUnique({
          where: { id: entityId },
        });
        beforeSnapshot = found ? (JSON.parse(JSON.stringify(found)) as Record<string, unknown>) : null;
      }
    } catch {
      // If we can't snapshot, proceed without audit
    }

    res.locals.auditBefore = beforeSnapshot;

    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      // Fire-and-forget audit log after response
      void writeAuditLog(req, res, options, beforeSnapshot, body);
      return originalJson(body);
    };

    next();
  };
}

async function writeAuditLog(
  req: Request,
  res: Response,
  options: AuditOptions,
  before: Record<string, unknown> | null,
  responseBody: unknown
): Promise<void> {
  try {
    if (res.statusCode >= 400) return; // Don't audit failed requests

    const entityId = options.getEntityId(req);
    const userId = req.user?.userId ?? null;
    const userName = req.user?.email ?? "system";
    const isCreate = req.method === "POST";
    const isDelete = req.method === "DELETE";

    let action: "created" | "updated" | "deleted" = "updated";
    if (isCreate) action = "created";
    if (isDelete) action = "deleted";

    let after: Record<string, unknown> | null = null;
    if (responseBody && typeof responseBody === "object" && "data" in (responseBody as Record<string, unknown>)) {
      after = (responseBody as { data: Record<string, unknown> }).data;
    }

    const changes = before && after ? diffObjects(before, after) : {};
    const changeSummary = isCreate
      ? `Created ${options.entityType} record`
      : isDelete
        ? `Deleted ${options.entityType} record`
        : summarize(changes);

    const entityNumber = options.getEntityNumber?.(req, res) ?? null;

    await prisma.entityAuditLog.create({
      data: {
        entityType: options.entityType,
        entityId,
        entityNumber,
        action,
        userId,
        userName,
        changedAt: new Date(),
        changes: JSON.parse(JSON.stringify(changes)) as Prisma.InputJsonValue,
        changeSummary,
        ipAddress: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        source: "web_portal",
      },
    });
  } catch (err) {
    logger.error("Failed to write audit log", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function toPrismaModel(entityType: string): string {
  const map: Record<string, string> = {
    quotes: "quote",
    orders: "order",
    jobs: "job",
    invoices: "invoice",
    clients: "client",
    companies: "company",
    crews: "crew",
    users: "user",
  };
  return map[entityType] ?? entityType;
}
