import type { Request, Response, NextFunction } from "express";
import { envStore, AppEnv } from "../env-store";
import { generalLogger as logger } from "../lib/logger";

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  logger.error("Unhandled error", { message: err.message, stack: err.stack, path: req.path });

  if (res.headersSent) return;

  if ("statusCode" in err && "code" in err) {
    const appErr = err as { statusCode: number; code: string; message: string; details?: unknown };
    res.status(appErr.statusCode).json({
      error: { code: appErr.code, message: appErr.message, details: appErr.details },
    });
    return;
  }

  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: envStore.NODE_ENV === AppEnv.PRODUCTION ? "Internal server error" : err.message,
    },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found` } });
}
