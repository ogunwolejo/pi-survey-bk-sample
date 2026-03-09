import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";
import { AuthenticationError } from "../lib/errors";
import { sendError } from "../lib/response";
import { redis, key } from "../lib/redis";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    sendError(res, new AuthenticationError("Missing or invalid authorization header"));
    return;
  }
  const token = authHeader.slice(7);
  try {
    req.user = verifyToken(token);
  } catch {
    sendError(res, new AuthenticationError("Invalid or expired token"));
    return;
  }

  redis
    .get(key("blacklist", token))
    .then((blacklisted) => {
      if (blacklisted) {
        sendError(res, new AuthenticationError("Token has been revoked"));
        return;
      }
      next();
    })
    .catch(() => {
      next();
    });
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      req.user = verifyToken(authHeader.slice(7));
    } catch {
      // ignore invalid token for optional auth
    }
  }
  next();
}
