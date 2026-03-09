import type { Response } from "express";
import type { AppError } from "./errors";

export function sendSuccess<T>(res: Response, data: T, statusCode = 200): void {
  res.status(statusCode).json({ data });
}

export function sendPaginated<T>(
  res: Response,
  data: T[],
  page: number,
  limit: number,
  total: number
): void {
  res.status(200).json({
    data,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
}

export function sendError(res: Response, error: unknown): void {
  if (error instanceof Error && "code" in error && "statusCode" in error) {
    const appErr = error as AppError;
    res.status(appErr.statusCode).json({
      error: { code: appErr.code, message: appErr.message, details: appErr.details },
    });
  } else {
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message } });
  }
}

export function sendNoContent(res: Response): void {
  res.status(204).send();
}
