import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn(),
  },
}));

vi.mock("../../lib/jwt", () => ({
  verifyToken: vi.fn(),
}));

vi.mock("../../lib/redis", () => ({
  redis: mockRedis,
  key: (...parts: string[]) => `pi:${parts.join(":")}`,
}));

import { requireAuth, optionalAuth } from "../auth.middleware";
import { verifyToken } from "../../lib/jwt";

const mockVerifyToken = vi.mocked(verifyToken);

const VALID_PAYLOAD = {
  userId: "user-1",
  email: "test@test.com",
  role: "admin",
  team: "residential",
  platformAccess: "web",
};

function createMocks(authHeader?: string) {
  const req = {
    headers: { authorization: authHeader },
    user: undefined,
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

describe("requireAuth", () => {
  it("returns 401 when Authorization header is missing", () => {
    const { req, res, next } = createMocks(undefined);
    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when header does not start with Bearer", () => {
    const { req, res, next } = createMocks("Basic abc123");
    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when token is invalid", () => {
    mockVerifyToken.mockImplementation(() => {
      throw new Error("jwt malformed");
    });

    const { req, res, next } = createMocks("Bearer bad-token");
    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("sets req.user and calls next() with valid non-blacklisted token", async () => {
    mockVerifyToken.mockReturnValue(VALID_PAYLOAD);
    mockRedis.get.mockResolvedValue(null);

    const { req, res, next } = createMocks("Bearer valid-token");
    requireAuth(req, res, next);

    await vi.waitFor(() => {
      expect(next).toHaveBeenCalled();
    });

    expect(req.user).toEqual(VALID_PAYLOAD);
    expect(mockRedis.get).toHaveBeenCalledWith("pi:blacklist:valid-token");
  });

  it("returns 401 when token is blacklisted", async () => {
    mockVerifyToken.mockReturnValue(VALID_PAYLOAD);
    mockRedis.get.mockResolvedValue("1");

    const { req, res, next } = createMocks("Bearer blacklisted-token");
    requireAuth(req, res, next);

    await vi.waitFor(() => {
      expect(res.status).toHaveBeenCalledWith(401);
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: "Token has been revoked" }),
      }),
    );
  });

  it("calls next() gracefully when Redis check fails", async () => {
    mockVerifyToken.mockReturnValue(VALID_PAYLOAD);
    mockRedis.get.mockRejectedValue(new Error("Redis connection lost"));

    const { req, res, next } = createMocks("Bearer valid-token");
    requireAuth(req, res, next);

    await vi.waitFor(() => {
      expect(next).toHaveBeenCalled();
    });

    expect(req.user).toEqual(VALID_PAYLOAD);
  });
});

describe("optionalAuth", () => {
  it("calls next() with no req.user when header is missing", () => {
    const { req, res, next } = createMocks(undefined);
    optionalAuth(req, res, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it("calls next() with no req.user when header is non-Bearer", () => {
    const { req, res, next } = createMocks("Basic abc");
    optionalAuth(req, res, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it("sets req.user and calls next() with valid token", () => {
    mockVerifyToken.mockReturnValue(VALID_PAYLOAD);

    const { req, res, next } = createMocks("Bearer valid-token");
    optionalAuth(req, res, next);

    expect(req.user).toEqual(VALID_PAYLOAD);
    expect(next).toHaveBeenCalled();
  });

  it("calls next() without req.user when token is invalid", () => {
    mockVerifyToken.mockImplementation(() => {
      throw new Error("expired");
    });

    const { req, res, next } = createMocks("Bearer expired-token");
    optionalAuth(req, res, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});
