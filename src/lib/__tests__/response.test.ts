import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import { sendSuccess, sendPaginated, sendError, sendNoContent } from "../response";
import { AppError, NotFoundError, ValidationError } from "../errors";

function createMockResponse(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

describe("sendSuccess", () => {
  it("sends 200 with { data } by default", () => {
    const res = createMockResponse();
    sendSuccess(res, { id: "1", name: "Test" });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: { id: "1", name: "Test" } });
  });

  it("uses custom statusCode when provided", () => {
    const res = createMockResponse();
    sendSuccess(res, { created: true }, 201);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ data: { created: true } });
  });
});

describe("sendPaginated", () => {
  it("sends data with pagination meta", () => {
    const res = createMockResponse();
    const items = [{ id: "1" }, { id: "2" }];
    sendPaginated(res, items, 1, 10, 25);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      data: items,
      meta: { page: 1, limit: 10, total: 25, totalPages: 3 },
    });
  });

  it("calculates totalPages correctly with exact division", () => {
    const res = createMockResponse();
    sendPaginated(res, [], 1, 10, 20);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ totalPages: 2 }),
      })
    );
  });

  it("returns totalPages 1 when total is 0", () => {
    const res = createMockResponse();
    sendPaginated(res, [], 1, 10, 0);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ totalPages: 1 }),
      })
    );
  });
});

describe("sendError", () => {
  it("maps AppError to correct status code and envelope", () => {
    const res = createMockResponse();
    const err = new NotFoundError("Quote not found", { id: "abc" });
    sendError(res, err);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: "NOT_FOUND",
        message: "Quote not found",
        details: { id: "abc" },
      },
    });
  });

  it("maps ValidationError to 400", () => {
    const res = createMockResponse();
    const details = [{ field: "email", message: "Required" }];
    const err = new ValidationError("Validation failed", details);
    sendError(res, err);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        details,
      },
    });
  });

  it("maps generic AppError to its statusCode", () => {
    const res = createMockResponse();
    const err = new AppError("CUSTOM_CODE", "Custom message", 503, null);
    sendError(res, err);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: "CUSTOM_CODE", message: "Custom message", details: null },
    });
  });

  it("maps unknown Error to 500 with INTERNAL_ERROR code", () => {
    const res = createMockResponse();
    sendError(res, new Error("Something went wrong"));

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
    });
  });

  it("maps non-Error values to 500 with generic message", () => {
    const res = createMockResponse();
    sendError(res, "just a string");

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  });
});

describe("sendNoContent", () => {
  it("sends 204 with no body", () => {
    const res = createMockResponse();
    sendNoContent(res);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalledWith();
  });
});
