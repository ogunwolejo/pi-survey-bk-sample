import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireRole, requireAdmin } from "../rbac.middleware";

function createMocks(user?: { role: string }) {
  const req = {
    user: user
      ? { userId: "u1", email: "x@x.com", team: "residential", platformAccess: "web", ...user }
      : undefined,
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next: NextFunction = vi.fn();
  return { req, res, next };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireRole", () => {
  it("returns 403 when req.user is not set", () => {
    const { req, res, next } = createMocks(undefined);
    requireRole("admin")(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when user has the exact required role", () => {
    const { req, res, next } = createMocks({ role: "office_manager" });
    requireRole("office_manager")(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("calls next() when user has a higher role (super_admin covers all)", () => {
    const { req, res, next } = createMocks({ role: "super_admin" });
    requireRole("field_crew")(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("calls next() when admin accesses office_manager-level endpoint", () => {
    const { req, res, next } = createMocks({ role: "admin" });
    requireRole("office_manager")(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("returns 403 when user role is too low", () => {
    const { req, res, next } = createMocks({ role: "field_crew" });
    requireRole("admin")(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for non-overlapping role hierarchies", () => {
    const { req, res, next } = createMocks({ role: "drafter" });
    requireRole("field_crew")(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows when any of multiple required roles match", () => {
    const { req, res, next } = createMocks({ role: "pls_reviewer" });
    requireRole("pls_reviewer", "admin")(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

describe("requireAdmin", () => {
  it("calls next() for admin role", () => {
    const { req, res, next } = createMocks({ role: "admin" });
    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("calls next() for super_admin role", () => {
    const { req, res, next } = createMocks({ role: "super_admin" });
    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("returns 403 for office_manager", () => {
    const { req, res, next } = createMocks({ role: "office_manager" });
    requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for field_crew", () => {
    const { req, res, next } = createMocks({ role: "field_crew" });
    requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when no user is set", () => {
    const { req, res, next } = createMocks(undefined);
    requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
