import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { Express } from "express";

vi.mock("../../services/auth.service", () => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  findUserByEmail: vi.fn(),
  createSessionForUser: vi.fn(),
  completeInvitationSetup: vi.fn(),
  validateInvitation: vi.fn(),
  completeSetup: vi.fn(),
}));

vi.mock("../../services/verification.service", () => ({
  createMagicLink: vi.fn(),
  verifyMagicLink: vi.fn(),
  createOtp: vi.fn(),
  verifyOtp: vi.fn(),
  checkCooldown: vi.fn(),
  getOtpCode: vi.fn(),
}));

vi.mock("../../services/email.service", () => ({
  sendMagicLinkEmail: vi.fn().mockResolvedValue("msg-id"),
  sendOtpEmail: vi.fn().mockResolvedValue("msg-id"),
}));

vi.mock("../../middleware/rate-limit.middleware", () => ({
  authRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  apiRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/jwt", () => ({
  verifyToken: vi.fn(),
}));

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: { get: vi.fn().mockResolvedValue(null) },
}));

vi.mock("../../lib/redis", () => ({
  redis: mockRedis,
  key: (...parts: string[]) => `pi:${parts.join(":")}`,
}));

vi.mock("../../env-store", () => ({
  envStore: { FRONTEND_URL: "http://localhost:3000" },
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import * as authService from "../../services/auth.service";
import * as verificationService from "../../services/verification.service";
import { verifyToken } from "../../lib/jwt";
import authRoutes from "../auth.routes";

const mockAuthService = vi.mocked(authService);
const mockVerification = vi.mocked(verificationService);
const mockVerifyToken = vi.mocked(verifyToken);

let app: Express;

function makeRequest(
  method: "get" | "post",
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = {
      method: method.toUpperCase(),
      url: path,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: body ?? {},
    };

    let statusCode = 200;
    const resHeaders: Record<string, string> = {};

    const res = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      setHeader(key: string, val: string) {
        resHeaders[key] = val;
        return this;
      },
      getHeader(key: string) {
        return resHeaders[key];
      },
      json(data: unknown) {
        resolve({ status: statusCode, body: data });
      },
      send(data?: unknown) {
        resolve({ status: statusCode, body: data ?? null });
      },
      end() {
        resolve({ status: statusCode, body: null });
      },
    };

    try {
      app(req as never, res as never);
    } catch (err) {
      reject(err);
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  app = express();
  app.use(express.json());
  app.use("/auth", authRoutes);
});

// ─── POST /auth/signin ──────────────────────────────────────────────────────

describe("POST /auth/signin", () => {
  it("returns 403 WEB_SIGNIN_DISABLED when platform is web", async () => {
    const res = await makeRequest("post", "/auth/signin", {
      email: "admin@test.com",
      password: "password123",
      platform: "web",
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "WEB_SIGNIN_DISABLED" }),
      }),
    );
    expect(mockAuthService.signIn).not.toHaveBeenCalled();
  });

  it("returns 200 with token for mobile platform", async () => {
    const mockResult = {
      user: { id: "u-1", email: "crew@test.com", role: "field_crew" },
      session: { token: "jwt-token", expiresAt: new Date("2026-03-01") },
    };
    mockAuthService.signIn.mockResolvedValue(mockResult);

    const res = await makeRequest("post", "/auth/signin", {
      email: "crew@test.com",
      password: "password123",
      platform: "mobile",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: mockResult });
    expect(mockAuthService.signIn).toHaveBeenCalledWith(
      "crew@test.com",
      "password123",
      "mobile",
    );
  });
});

// ─── POST /auth/signout ──────────────────────────────────────────────────────

describe("POST /auth/signout", () => {
  it("returns 204 on successful signout", async () => {
    mockVerifyToken.mockReturnValue({
      userId: "u-1",
      email: "admin@test.com",
      role: "admin",
      team: "residential",
      platformAccess: "web",
    });
    mockAuthService.signOut.mockResolvedValue(undefined);

    const res = await makeRequest(
      "post",
      "/auth/signout",
      {},
      { authorization: "Bearer valid-jwt" },
    );

    expect(res.status).toBe(204);
    expect(mockAuthService.signOut).toHaveBeenCalledWith("u-1", "valid-jwt");
  });
});

// ─── POST /auth/magic-link ──────────────────────────────────────────────────

describe("POST /auth/magic-link", () => {
  it("returns success message regardless of email existence (enumeration prevention)", async () => {
    mockAuthService.findUserByEmail.mockResolvedValue(null);

    const res = await makeRequest("post", "/auth/magic-link", {
      email: "unknown@test.com",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: expect.objectContaining({
        message: expect.stringContaining("If an account exists"),
      }),
    });
    expect(mockVerification.createMagicLink).not.toHaveBeenCalled();
  });

  it("creates magic link and sends email when user exists and is active", async () => {
    mockAuthService.findUserByEmail.mockResolvedValue({
      id: "u-1",
      email: "admin@test.com",
      isActive: true,
      platformAccess: "both",
    } as never);
    mockVerification.createMagicLink.mockResolvedValue({
      token: "ml-token",
      expiresInSeconds: 900,
    });

    const res = await makeRequest("post", "/auth/magic-link", {
      email: "admin@test.com",
    });

    expect(res.status).toBe(200);
    expect(mockVerification.createMagicLink).toHaveBeenCalled();
  });

  it("does not send email when user is inactive", async () => {
    mockAuthService.findUserByEmail.mockResolvedValue({
      id: "u-1",
      email: "inactive@test.com",
      isActive: false,
      platformAccess: "web",
    } as never);

    const res = await makeRequest("post", "/auth/magic-link", {
      email: "inactive@test.com",
    });

    expect(res.status).toBe(200);
    expect(mockVerification.createMagicLink).not.toHaveBeenCalled();
  });
});

// ─── GET /auth/magic-link/verify/:token ──────────────────────────────────────

describe("GET /auth/magic-link/verify/:token", () => {
  it("returns session on valid magic link", async () => {
    mockVerification.verifyMagicLink.mockResolvedValue({
      userId: "u-1",
      email: "admin@test.com",
      purpose: "signin",
    });
    mockAuthService.createSessionForUser.mockResolvedValue({
      user: { id: "u-1" } as never,
      session: { token: "jwt-1", expiresAt: new Date("2026-03-01") },
    });

    const res = await makeRequest("get", "/auth/magic-link/verify/valid-token");

    expect(res.status).toBe(200);
    expect(mockAuthService.createSessionForUser).toHaveBeenCalledWith("admin@test.com");
  });

  it("calls completeInvitationSetup for invitation purpose", async () => {
    mockVerification.verifyMagicLink.mockResolvedValue({
      userId: null,
      email: "new@test.com",
      purpose: "invitation",
      invitationToken: "inv-abc",
    });
    mockAuthService.completeInvitationSetup.mockResolvedValue({
      user: { id: "u-2" } as never,
      session: { token: "jwt-2", expiresAt: new Date("2026-03-01") },
    });

    const res = await makeRequest("get", "/auth/magic-link/verify/inv-token");

    expect(res.status).toBe(200);
    expect(mockAuthService.completeInvitationSetup).toHaveBeenCalledWith(
      "inv-abc",
      "new@test.com",
    );
  });
});

// ─── POST /auth/otp ─────────────────────────────────────────────────────────

describe("POST /auth/otp", () => {
  it("returns success message regardless of email existence", async () => {
    mockAuthService.findUserByEmail.mockResolvedValue(null);

    const res = await makeRequest("post", "/auth/otp", {
      email: "unknown@test.com",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: expect.objectContaining({
        message: expect.stringContaining("If an account exists"),
      }),
    });
  });

  it("creates OTP and sends email when user exists", async () => {
    mockAuthService.findUserByEmail.mockResolvedValue({
      id: "u-1",
      email: "admin@test.com",
      isActive: true,
      platformAccess: "web",
    } as never);
    mockVerification.createOtp.mockResolvedValue({ expiresInSeconds: 600 });
    mockVerification.getOtpCode.mockResolvedValue("482913");

    const res = await makeRequest("post", "/auth/otp", {
      email: "admin@test.com",
    });

    expect(res.status).toBe(200);
    expect(mockVerification.createOtp).toHaveBeenCalled();
    expect(mockVerification.getOtpCode).toHaveBeenCalledWith("admin@test.com");
  });
});

// ─── POST /auth/otp/verify ──────────────────────────────────────────────────

describe("POST /auth/otp/verify", () => {
  it("returns session on valid OTP", async () => {
    mockVerification.verifyOtp.mockResolvedValue({
      userId: "u-1",
      email: "admin@test.com",
      purpose: "signin",
    });
    mockAuthService.createSessionForUser.mockResolvedValue({
      user: { id: "u-1" } as never,
      session: { token: "jwt-1", expiresAt: new Date("2026-03-01") },
    });

    const res = await makeRequest("post", "/auth/otp/verify", {
      email: "admin@test.com",
      code: "482913",
    });

    expect(res.status).toBe(200);
    expect(mockAuthService.createSessionForUser).toHaveBeenCalledWith("admin@test.com");
  });

  it("calls completeInvitationSetup for invitation purpose", async () => {
    mockVerification.verifyOtp.mockResolvedValue({
      userId: null,
      email: "new@test.com",
      purpose: "invitation",
      invitationToken: "inv-xyz",
    });
    mockAuthService.completeInvitationSetup.mockResolvedValue({
      user: { id: "u-2" } as never,
      session: { token: "jwt-2", expiresAt: new Date("2026-03-01") },
    });

    const res = await makeRequest("post", "/auth/otp/verify", {
      email: "new@test.com",
      code: "123456",
    });

    expect(res.status).toBe(200);
    expect(mockAuthService.completeInvitationSetup).toHaveBeenCalledWith(
      "inv-xyz",
      "new@test.com",
    );
  });
});

// ─── POST /auth/resend ──────────────────────────────────────────────────────

describe("POST /auth/resend", () => {
  it("returns 429 when cooldown is active", async () => {
    mockVerification.checkCooldown.mockResolvedValue(45);

    const res = await makeRequest("post", "/auth/resend", {
      email: "admin@test.com",
      method: "magic_link",
    });

    expect(res.status).toBe(429);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "COOLDOWN_ACTIVE" }),
      }),
    );
  });

  it("resends magic link when cooldown expired", async () => {
    mockVerification.checkCooldown.mockResolvedValue(0);
    mockAuthService.findUserByEmail.mockResolvedValue({
      id: "u-1",
      email: "admin@test.com",
      isActive: true,
      platformAccess: "both",
    } as never);
    mockVerification.createMagicLink.mockResolvedValue({
      token: "new-ml-token",
      expiresInSeconds: 900,
    });

    const res = await makeRequest("post", "/auth/resend", {
      email: "admin@test.com",
      method: "magic_link",
    });

    expect(res.status).toBe(200);
    expect(mockVerification.createMagicLink).toHaveBeenCalled();
  });

  it("resends OTP when cooldown expired", async () => {
    mockVerification.checkCooldown.mockResolvedValue(0);
    mockAuthService.findUserByEmail.mockResolvedValue({
      id: "u-1",
      email: "admin@test.com",
      isActive: true,
      platformAccess: "both",
    } as never);
    mockVerification.createOtp.mockResolvedValue({ expiresInSeconds: 600 });
    mockVerification.getOtpCode.mockResolvedValue("111222");

    const res = await makeRequest("post", "/auth/resend", {
      email: "admin@test.com",
      method: "otp",
    });

    expect(res.status).toBe(200);
    expect(mockVerification.createOtp).toHaveBeenCalled();
  });
});
