import type { Request, Response, NextFunction } from "express";
import { AuthorizationError } from "../lib/errors";
import { sendError } from "../lib/response";
import { requireAuth } from "./auth.middleware";

const ROLE_HIERARCHY: Record<string, Set<string>> = {
  super_admin: new Set(["super_admin", "admin", "office_manager", "crew_manager", "pls_reviewer", "pls_assistant", "field_crew", "drafter", "shipping_admin"]),
  admin: new Set(["admin", "office_manager", "crew_manager", "pls_reviewer", "pls_assistant", "field_crew", "drafter", "shipping_admin"]),
  office_manager: new Set(["office_manager", "crew_manager", "pls_reviewer", "pls_assistant", "field_crew", "drafter", "shipping_admin"]),
  crew_manager: new Set(["crew_manager", "field_crew"]),
  pls_reviewer: new Set(["pls_reviewer"]),
  pls_assistant: new Set(["pls_assistant"]),
  field_crew: new Set(["field_crew"]),
  drafter: new Set(["drafter"]),
  shipping_admin: new Set(["shipping_admin"]),
};

export function canEditUser(editorRole: string, targetRole: string): boolean {
  return ROLE_HIERARCHY[editorRole]?.has(targetRole) ?? false;
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendError(res, new AuthorizationError("Authentication required"));
      return;
    }
    const userRole = req.user.role;
    const allowed = roles.some((r) => userRole === r || ROLE_HIERARCHY[userRole]?.has(r));
    if (!allowed) {
      sendError(res, new AuthorizationError(`Role '${userRole}' is not permitted for this action`));
      return;
    }
    next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    requireRole("office_manager")(req, res, next);
  });
}
