import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    ttl: vi.fn(),
  },
}));

vi.mock("../../lib/redis", () => ({
  redis: mockRedis,
  key: (...parts: string[]) => `pi:${parts.join(":")}`,
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-1234"),
  randomInt: vi.fn(() => 482_913),
}));

import {
  checkCooldown,
  invalidateExistingTokens,
  createMagicLink,
  verifyMagicLink,
  createOtp,
  verifyOtp,
  getOtpCode,
} from "../verification.service";

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.set.mockResolvedValue("OK");
  mockRedis.del.mockResolvedValue(1);
});

// ─── checkCooldown ──────────────────────────────────────────────────────────

describe("checkCooldown", () => {
  it("returns remaining TTL when cooldown is active", async () => {
    mockRedis.ttl.mockResolvedValue(42);
    const result = await checkCooldown("user@test.com");
    expect(result).toBe(42);
    expect(mockRedis.ttl).toHaveBeenCalledWith("pi:auth-cooldown:user@test.com");
  });

  it("returns 0 when cooldown has expired", async () => {
    mockRedis.ttl.mockResolvedValue(-2);
    const result = await checkCooldown("user@test.com");
    expect(result).toBe(0);
  });

  it("returns 0 when TTL is 0", async () => {
    mockRedis.ttl.mockResolvedValue(0);
    const result = await checkCooldown("user@test.com");
    expect(result).toBe(0);
  });
});

// ─── invalidateExistingTokens ──────────────────────────────────────────────

describe("invalidateExistingTokens", () => {
  it("deletes existing OTP for the email", async () => {
    mockRedis.get.mockResolvedValueOnce('{"code":"123456"}'); // OTP exists
    mockRedis.get.mockResolvedValueOnce(null); // no magic link

    await invalidateExistingTokens("user@test.com");

    expect(mockRedis.del).toHaveBeenCalledWith("pi:otp:user@test.com");
  });

  it("deletes existing magic link via reverse lookup", async () => {
    mockRedis.get.mockResolvedValueOnce(null); // no OTP
    mockRedis.get.mockResolvedValueOnce("old-magic-token"); // magic link reverse lookup

    await invalidateExistingTokens("user@test.com");

    expect(mockRedis.del).toHaveBeenCalledWith("pi:magic:old-magic-token");
    expect(mockRedis.del).toHaveBeenCalledWith("pi:magic-email:user@test.com");
  });

  it("does nothing if no existing tokens", async () => {
    mockRedis.get.mockResolvedValue(null);

    await invalidateExistingTokens("user@test.com");

    expect(mockRedis.del).not.toHaveBeenCalled();
  });
});

// ─── createMagicLink ────────────────────────────────────────────────────────

describe("createMagicLink", () => {
  it("generates a UUID token and stores in Redis with 900s TTL", async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await createMagicLink({
      email: "User@Test.com",
      userId: "u-1",
      method: "magic_link",
      purpose: "signin",
    });

    expect(result.token).toBe("test-uuid-1234");
    expect(result.expiresInSeconds).toBe(900);

    expect(mockRedis.set).toHaveBeenCalledWith(
      "pi:magic:test-uuid-1234",
      expect.stringContaining('"email":"user@test.com"'),
      "EX",
      900,
    );
  });

  it("stores reverse lookup key for invalidation", async () => {
    mockRedis.get.mockResolvedValue(null);

    await createMagicLink({
      email: "user@test.com",
      userId: "u-1",
      method: "magic_link",
      purpose: "signin",
    });

    expect(mockRedis.set).toHaveBeenCalledWith(
      "pi:magic-email:user@test.com",
      "test-uuid-1234",
      "EX",
      900,
    );
  });

  it("sets cooldown after creation", async () => {
    mockRedis.get.mockResolvedValue(null);

    await createMagicLink({
      email: "user@test.com",
      userId: "u-1",
      method: "magic_link",
      purpose: "signin",
    });

    expect(mockRedis.set).toHaveBeenCalledWith(
      "pi:auth-cooldown:user@test.com",
      "1",
      "EX",
      60,
    );
  });

  it("includes invitationToken when provided", async () => {
    mockRedis.get.mockResolvedValue(null);

    await createMagicLink({
      email: "user@test.com",
      userId: null,
      method: "magic_link",
      purpose: "invitation",
      invitationToken: "inv-token-abc",
    });

    expect(mockRedis.set).toHaveBeenCalledWith(
      "pi:magic:test-uuid-1234",
      expect.stringContaining('"invitationToken":"inv-token-abc"'),
      "EX",
      900,
    );
  });

  it("invalidates existing tokens before creating new one", async () => {
    mockRedis.get.mockResolvedValueOnce('{"code":"old"}'); // existing OTP
    mockRedis.get.mockResolvedValueOnce(null); // no magic link

    await createMagicLink({
      email: "user@test.com",
      userId: "u-1",
      method: "magic_link",
      purpose: "signin",
    });

    expect(mockRedis.del).toHaveBeenCalledWith("pi:otp:user@test.com");
  });
});

// ─── verifyMagicLink ────────────────────────────────────────────────────────

describe("verifyMagicLink", () => {
  it("returns verification result and deletes token (single-use)", async () => {
    const data = {
      userId: "u-1",
      email: "user@test.com",
      purpose: "signin",
      createdAt: "2026-02-24T00:00:00.000Z",
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(data));

    const result = await verifyMagicLink({ token: "valid-token" });

    expect(result).toEqual({
      userId: "u-1",
      email: "user@test.com",
      purpose: "signin",
    });
    expect(mockRedis.del).toHaveBeenCalledWith("pi:magic:valid-token");
    expect(mockRedis.del).toHaveBeenCalledWith("pi:magic-email:user@test.com");
  });

  it("returns invitationToken when present in data", async () => {
    const data = {
      userId: null,
      email: "new@test.com",
      purpose: "invitation",
      invitationToken: "inv-abc",
      createdAt: "2026-02-24T00:00:00.000Z",
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(data));

    const result = await verifyMagicLink({ token: "inv-link" });

    expect(result.invitationToken).toBe("inv-abc");
    expect(result.purpose).toBe("invitation");
  });

  it("throws INVALID_TOKEN when token not found in Redis", async () => {
    mockRedis.get.mockResolvedValue(null);

    await expect(verifyMagicLink({ token: "expired-token" })).rejects.toThrow(
      "Magic link is invalid or has expired",
    );
  });
});

// ─── createOtp ──────────────────────────────────────────────────────────────

describe("createOtp", () => {
  it("generates a 6-digit code and stores in Redis with 600s TTL", async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await createOtp({
      email: "user@test.com",
      userId: "u-1",
      method: "otp",
      purpose: "signin",
    });

    expect(result.expiresInSeconds).toBe(600);

    expect(mockRedis.set).toHaveBeenCalledWith(
      "pi:otp:user@test.com",
      expect.stringContaining('"code":"482913"'),
      "EX",
      600,
    );
  });

  it("initializes attempts to 0", async () => {
    mockRedis.get.mockResolvedValue(null);

    await createOtp({
      email: "user@test.com",
      userId: "u-1",
      method: "otp",
      purpose: "signin",
    });

    expect(mockRedis.set).toHaveBeenCalledWith(
      "pi:otp:user@test.com",
      expect.stringContaining('"attempts":0'),
      "EX",
      600,
    );
  });
});

// ─── verifyOtp ──────────────────────────────────────────────────────────────

describe("verifyOtp", () => {
  const validOtp = {
    code: "482913",
    userId: "u-1",
    email: "user@test.com",
    purpose: "signin" as const,
    attempts: 0,
    createdAt: "2026-02-24T00:00:00.000Z",
  };

  it("returns verification result on correct code", async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify(validOtp));

    const result = await verifyOtp({ email: "user@test.com", code: "482913" });

    expect(result).toEqual({
      userId: "u-1",
      email: "user@test.com",
      purpose: "signin",
    });
  });

  it("deletes OTP after successful verification (single-use)", async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify(validOtp));

    await verifyOtp({ email: "user@test.com", code: "482913" });

    expect(mockRedis.del).toHaveBeenCalledWith("pi:otp:user@test.com");
  });

  it("throws INVALID_CODE when OTP not found", async () => {
    mockRedis.get.mockResolvedValue(null);

    await expect(verifyOtp({ email: "user@test.com", code: "000000" })).rejects.toThrow(
      "Code is invalid or has expired",
    );
  });

  it("throws INVALID_CODE on wrong code and increments attempts", async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify(validOtp));
    mockRedis.ttl.mockResolvedValue(500);

    await expect(verifyOtp({ email: "user@test.com", code: "000000" })).rejects.toThrow(
      "Incorrect code",
    );

    expect(mockRedis.set).toHaveBeenCalledWith(
      "pi:otp:user@test.com",
      expect.stringContaining('"attempts":1'),
      "EX",
      500,
    );
  });

  it("throws MAX_ATTEMPTS and deletes OTP after 5th wrong attempt", async () => {
    const almostLocked = { ...validOtp, attempts: 4 };
    mockRedis.get.mockResolvedValue(JSON.stringify(almostLocked));

    await expect(verifyOtp({ email: "user@test.com", code: "000000" })).rejects.toThrow(
      "Too many incorrect attempts",
    );
    expect(mockRedis.del).toHaveBeenCalledWith("pi:otp:user@test.com");
  });

  it("throws MAX_ATTEMPTS immediately if already at limit", async () => {
    const locked = { ...validOtp, attempts: 5 };
    mockRedis.get.mockResolvedValue(JSON.stringify(locked));

    await expect(verifyOtp({ email: "user@test.com", code: "482913" })).rejects.toThrow(
      "Too many incorrect attempts",
    );
  });

  it("returns invitationToken when present", async () => {
    const invOtp = { ...validOtp, purpose: "invitation" as const, invitationToken: "inv-abc" };
    mockRedis.get.mockResolvedValue(JSON.stringify(invOtp));

    const result = await verifyOtp({ email: "user@test.com", code: "482913" });
    expect(result.invitationToken).toBe("inv-abc");
    expect(result.purpose).toBe("invitation");
  });
});

// ─── getOtpCode ─────────────────────────────────────────────────────────────

describe("getOtpCode", () => {
  it("returns the code from stored OTP data", async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ code: "482913" }));

    const code = await getOtpCode("user@test.com");
    expect(code).toBe("482913");
  });

  it("returns null when no OTP exists", async () => {
    mockRedis.get.mockResolvedValue(null);

    const code = await getOtpCode("user@test.com");
    expect(code).toBeNull();
  });
});
