import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockEnvStore = vi.hoisted(() => ({
  NODE_ENV: "development",
  SENDGRID_API_KEY: "test-key",
  SENDGRID_FROM_EMAIL: "test@test.com",
  SENDGRID_FROM_NAME: "Test",
  STAGING_TRAP_EMAIL: "",
  STAGING_TRAP_EXCLUDED_EMAILS: "",
  FRONTEND_URL: "http://localhost:3000",
}));

vi.mock("../../env-store", () => ({
  envStore: mockEnvStore,
  AppEnv: {
    LOCAL: "local",
    DEVELOPMENT: "development",
    STAGING: "staging",
    PRODUCTION: "production",
    TEST: "test",
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/staging-email", () => ({
  getStagingEmailOrOriginal: vi.fn((email: string) => {
    if (mockEnvStore.STAGING_TRAP_EMAIL) {
      return `trap+${email.replace("@", "=")}@${mockEnvStore.STAGING_TRAP_EMAIL.split("@")[1]}`;
    }
    return email;
  }),
}));

vi.mock("@sendgrid/mail", () => ({
  default: {
    setApiKey: vi.fn(),
    send: vi.fn().mockResolvedValue([{ statusCode: 202 }]),
  },
}));

vi.mock("../email-templates", () => ({
  magicLinkEmailHtml: vi.fn(() => "<html>magic</html>"),
  otpEmailHtml: vi.fn(() => "<html>otp</html>"),
}));

import { logDevBanner, sendMagicLinkEmail, sendOtpEmail } from "../email.service";

let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  mockEnvStore.NODE_ENV = "development";
  mockEnvStore.STAGING_TRAP_EMAIL = "";
});

afterEach(() => {
  consoleSpy.mockRestore();
});

// ─── logDevBanner: environment guard ─────────────────────────────────────────

describe("logDevBanner environment guard", () => {
  it("prints banner when NODE_ENV is local", () => {
    mockEnvStore.NODE_ENV = "local";
    logDevBanner("TEST", { Key: "value" });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("prints banner when NODE_ENV is development", () => {
    mockEnvStore.NODE_ENV = "development";
    logDevBanner("TEST", { Key: "value" });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("prints banner when NODE_ENV is staging", () => {
    mockEnvStore.NODE_ENV = "staging";
    logDevBanner("TEST", { Key: "value" });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("prints banner when NODE_ENV is test", () => {
    mockEnvStore.NODE_ENV = "test";
    logDevBanner("TEST", { Key: "value" });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("does NOT print banner when NODE_ENV is production", () => {
    mockEnvStore.NODE_ENV = "production";
    logDevBanner("TEST", { Key: "value" });
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});

// ─── logDevBanner: ANSI color output ─────────────────────────────────────────

describe("logDevBanner ANSI formatting", () => {
  it("includes ANSI color codes in separator bars and label", () => {
    logDevBanner("MAGIC LINK", { Email: "test@test.com" });

    const allOutput = consoleSpy.mock.calls.map(([arg]) => String(arg)).join("\n");
    expect(allOutput).toContain("\x1b[33m");
    expect(allOutput).toContain("\x1b[1m");
    expect(allOutput).toContain("\x1b[0m");
  });
});

// ─── sendMagicLinkEmail: banner fields ───────────────────────────────────────

describe("sendMagicLinkEmail banner output", () => {
  it("logs banner with Email, Purpose, and URL fields", async () => {
    await sendMagicLinkEmail("user@example.com", "http://localhost:3000/magic-link/abc-123", "signin");

    const allOutput = consoleSpy.mock.calls.map(([arg]) => String(arg)).join("\n");
    expect(allOutput).toContain("MAGIC LINK");
    expect(allOutput).toContain("user@example.com");
    expect(allOutput).toContain("signin");
    expect(allOutput).toContain("http://localhost:3000/magic-link/abc-123");
  });
});

// ─── sendOtpEmail: banner fields ─────────────────────────────────────────────

describe("sendOtpEmail banner output", () => {
  it("logs banner with Email, Purpose, and Code fields", async () => {
    await sendOtpEmail("user@example.com", "482913", "signin");

    const allOutput = consoleSpy.mock.calls.map(([arg]) => String(arg)).join("\n");
    expect(allOutput).toContain("OTP CODE");
    expect(allOutput).toContain("user@example.com");
    expect(allOutput).toContain("signin");
    expect(allOutput).toContain("482913");
  });
});

// ─── Staging email trap: "Delivers to" field ─────────────────────────────────

describe("staging email trap banner", () => {
  it("shows 'Delivers to' field when staging trap is active", async () => {
    mockEnvStore.STAGING_TRAP_EMAIL = "staging-trap@elitesoftwareautomation.com";

    await sendMagicLinkEmail("holly@pisurveying.com", "http://localhost:3000/magic-link/abc", "signin");

    const allOutput = consoleSpy.mock.calls.map(([arg]) => String(arg)).join("\n");
    expect(allOutput).toContain("holly@pisurveying.com");
    expect(allOutput).toContain("Delivers to");
  });
});
