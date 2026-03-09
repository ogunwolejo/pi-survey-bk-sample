import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { validateBody, validateQuery } from "../validate.middleware";

function createMocks(body?: unknown, query?: unknown) {
  const req = {
    body: body ?? {},
    query: query ?? {},
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

const bodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});

const querySchema = z.object({
  page: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().positive().max(100),
});

describe("validateBody", () => {
  it("calls next() and sets parsed body when valid", () => {
    const { req, res, next } = createMocks({
      email: "test@example.com",
      name: "Alice",
    });

    validateBody(bodySchema)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ email: "test@example.com", name: "Alice" });
    expect(res.status).not.toHaveBeenCalled();
  });

  it("strips unknown fields from body", () => {
    const { req, res, next } = createMocks({
      email: "test@example.com",
      name: "Alice",
      extraField: "should be stripped",
    });

    validateBody(bodySchema)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body).not.toHaveProperty("extraField");
  });

  it("sends 400 with field-level errors for invalid body", () => {
    const { req, res, next } = createMocks({
      email: "not-an-email",
      name: "",
    });

    validateBody(bodySchema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();

    const jsonCall = vi.mocked(res.json).mock.calls[0]![0] as {
      error: { details: Array<{ field: string; message: string }> };
    };
    const fields = jsonCall.error.details.map((d) => d.field);
    expect(fields).toContain("email");
    expect(fields).toContain("name");
  });

  it("sends 400 for completely missing body fields", () => {
    const { req, res, next } = createMocks({});

    validateBody(bodySchema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("validateQuery", () => {
  it("calls next() when query is valid", () => {
    const { req, res, next } = createMocks(undefined, {
      page: "1",
      limit: "25",
    });

    validateQuery(querySchema)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("coerces string query params to numbers", () => {
    const { req, res, next } = createMocks(undefined, {
      page: "2",
      limit: "50",
    });

    validateQuery(querySchema)(req, res, next);

    expect(next).toHaveBeenCalled();
    // After validation, parsed values should be numbers on req.query
    expect(req.query).toEqual(expect.objectContaining({ page: 2, limit: 50 }));
  });

  it("sends 400 for invalid query params", () => {
    const { req, res, next } = createMocks(undefined, {
      page: "not-a-number",
      limit: "200",
    });

    validateQuery(querySchema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("sends 400 when required query params are missing", () => {
    const { req, res, next } = createMocks(undefined, {});

    validateQuery(querySchema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
