import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export const correlationStorage = new AsyncLocalStorage<string>();

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers["x-correlation-id"] as string | undefined) ?? randomUUID();
  res.setHeader("X-Correlation-Id", id);
  correlationStorage.run(id, () => next());
}
