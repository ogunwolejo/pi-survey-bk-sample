import type { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";
import { sendError } from "../lib/response";
import { ValidationError } from "../lib/errors";

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      }));
      sendError(res, new ValidationError("Request body validation failed", details));
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const details = result.error.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      }));
      sendError(res, new ValidationError("Query parameter validation failed", details));
      return;
    }
    Object.assign(req.query, result.data);
    next();
  };
}
