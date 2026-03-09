import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret-key-for-unit-tests";
process.env.JWT_EXPIRY = "1h";

import { signToken, verifyToken, type TokenPayload } from "../jwt";

const SAMPLE_PAYLOAD: TokenPayload = {
  userId: "user-123",
  name: "Test User",
  email: "admin@pisurvey.com",
  role: "admin",
  team: "residential",
  platformAccess: "both",
};

describe("signToken", () => {
  it("returns a non-empty string", () => {
    const token = signToken(SAMPLE_PAYLOAD);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("returns a JWT with three dot-separated parts", () => {
    const token = signToken(SAMPLE_PAYLOAD);
    expect(token.split(".")).toHaveLength(3);
  });
});

describe("verifyToken", () => {
  it("decodes payload correctly", () => {
    const token = signToken(SAMPLE_PAYLOAD);
    const decoded = verifyToken(token);

    expect(decoded.userId).toBe("user-123");
    expect(decoded.email).toBe("admin@pisurvey.com");
    expect(decoded.role).toBe("admin");
    expect(decoded.team).toBe("residential");
    expect(decoded.platformAccess).toBe("both");
  });

  it("throws on invalid token", () => {
    expect(() => verifyToken("invalid.token.string")).toThrow();
  });

  it("throws on tampered token", () => {
    const token = signToken(SAMPLE_PAYLOAD);
    const tampered = token.slice(0, -5) + "XXXXX";
    expect(() => verifyToken(tampered)).toThrow();
  });

  it("throws on expired token", () => {
    const expiredToken = jwt.sign(
      { ...SAMPLE_PAYLOAD, iat: Math.floor(Date.now() / 1000) - 7200 },
      "test-secret-key-for-unit-tests",
      { expiresIn: "1s" }
    );

    expect(() => verifyToken(expiredToken)).toThrow();
  });
});
