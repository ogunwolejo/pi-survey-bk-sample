import { describe, it, expect } from "vitest";
import {
  AppError,
  NotFoundError,
  ValidationError,
  AuthorizationError,
  AuthenticationError,
  ConflictError,
  RateLimitError,
} from "../errors";

describe("AppError", () => {
  it("sets code, message, and statusCode", () => {
    const err = new AppError("CUSTOM", "Something broke", 503);
    expect(err.code).toBe("CUSTOM");
    expect(err.message).toBe("Something broke");
    expect(err.statusCode).toBe(503);
    expect(err.name).toBe("AppError");
  });

  it("defaults statusCode to 500", () => {
    const err = new AppError("CUSTOM", "fail");
    expect(err.statusCode).toBe(500);
  });

  it("preserves details", () => {
    const details = { field: "email", reason: "taken" };
    const err = new AppError("CUSTOM", "fail", 400, details);
    expect(err.details).toEqual(details);
  });

  it("is instanceof Error", () => {
    const err = new AppError("CUSTOM", "fail");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });
});

describe("NotFoundError", () => {
  it("has statusCode 404 and code NOT_FOUND", () => {
    const err = new NotFoundError();
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Resource not found");
    expect(err.name).toBe("NotFoundError");
  });

  it("accepts custom message and details", () => {
    const err = new NotFoundError("User not found", { userId: "123" });
    expect(err.message).toBe("User not found");
    expect(err.details).toEqual({ userId: "123" });
  });

  it("is instanceof AppError and Error", () => {
    const err = new NotFoundError();
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("ValidationError", () => {
  it("has statusCode 400 and code VALIDATION_ERROR", () => {
    const err = new ValidationError();
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("Validation failed");
  });

  it("preserves field-level details", () => {
    const details = [{ field: "email", message: "Required" }];
    const err = new ValidationError("Bad input", details);
    expect(err.details).toEqual(details);
  });
});

describe("AuthorizationError", () => {
  it("has statusCode 403 and code FORBIDDEN", () => {
    const err = new AuthorizationError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toBe("Forbidden");
  });
});

describe("AuthenticationError", () => {
  it("has statusCode 401 and code UNAUTHORIZED", () => {
    const err = new AuthenticationError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toBe("Unauthorized");
  });
});

describe("ConflictError", () => {
  it("has statusCode 409 and code CONFLICT", () => {
    const err = new ConflictError();
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("Conflict");
  });

  it("preserves details", () => {
    const err = new ConflictError("Duplicate entry", { field: "email" });
    expect(err.details).toEqual({ field: "email" });
  });
});

describe("RateLimitError", () => {
  it("has statusCode 429 and code RATE_LIMIT_EXCEEDED", () => {
    const err = new RateLimitError();
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(err.message).toBe("Too many requests");
  });
});
