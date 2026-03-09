import { randomUUID, randomInt } from "node:crypto";
import { redis, key } from "../lib/redis";
import { authLogger as logger } from "../lib/logger";
import { AppError } from "../lib/errors";

// ─── Types ──────────────────────────────────────────────────────────────────

export type VerificationMethod = "magic_link" | "otp";
export type VerificationPurpose = "signin" | "invitation";

export interface MagicLinkData {
  userId: string | null;
  email: string;
  purpose: VerificationPurpose;
  invitationToken?: string;
  createdAt: string;
}

export interface OtpData {
  code: string;
  userId: string | null;
  email: string;
  purpose: VerificationPurpose;
  invitationToken?: string;
  attempts: number;
  createdAt: string;
}

export interface RequestVerificationInput {
  email: string;
  userId: string | null;
  method: VerificationMethod;
  purpose: VerificationPurpose;
  invitationToken?: string;
}

export interface VerifyMagicLinkInput {
  token: string;
}

export interface VerifyOtpInput {
  email: string;
  code: string;
}

export interface VerificationResult {
  userId: string | null;
  email: string;
  purpose: VerificationPurpose;
  invitationToken?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAGIC_LINK_TTL = 900; // 15 minutes
const OTP_TTL = 600; // 10 minutes
const COOLDOWN_TTL = 60; // 60 seconds
const MAX_OTP_ATTEMPTS = 5;

// ─── Key Helpers ────────────────────────────────────────────────────────────

function magicKey(token: string): string {
  return key("magic", token);
}

function otpKey(email: string): string {
  return key("otp", email.toLowerCase());
}

function cooldownKey(email: string): string {
  return key("auth-cooldown", email.toLowerCase());
}

// ─── Cooldown ───────────────────────────────────────────────────────────────

export async function checkCooldown(email: string): Promise<number> {
  const ttl = await redis.ttl(cooldownKey(email));
  return ttl > 0 ? ttl : 0;
}

async function setCooldown(email: string): Promise<void> {
  await redis.set(cooldownKey(email), "1", "EX", COOLDOWN_TTL);
}

// ─── Token Invalidation ────────────────────────────────────────────────────

export async function invalidateExistingTokens(email: string): Promise<void> {
  const otpRaw = await redis.get(otpKey(email));
  if (otpRaw) {
    await redis.del(otpKey(email));
  }

  // Magic links are keyed by token, not email, so we store a reverse
  // lookup `pi:magic-email:<email>` → token to enable invalidation.
  const existingMagicToken = await redis.get(key("magic-email", email.toLowerCase()));
  if (existingMagicToken) {
    await redis.del(magicKey(existingMagicToken));
    await redis.del(key("magic-email", email.toLowerCase()));
  }
}

// ─── Create Magic Link ─────────────────────────────────────────────────────

export async function createMagicLink(
  input: RequestVerificationInput,
): Promise<{ token: string; expiresInSeconds: number }> {
  const { email, userId, purpose, invitationToken } = input;

  await invalidateExistingTokens(email);

  const token = randomUUID();
  const data: MagicLinkData = {
    userId,
    email: email.toLowerCase(),
    purpose,
    ...(invitationToken ? { invitationToken } : {}),
    createdAt: new Date().toISOString(),
  };

  await redis.set(magicKey(token), JSON.stringify(data), "EX", MAGIC_LINK_TTL);
  // Reverse lookup for invalidation
  await redis.set(key("magic-email", email.toLowerCase()), token, "EX", MAGIC_LINK_TTL);
  await setCooldown(email);

  logger.info("[Verification] Magic link created", { email, purpose });

  return { token, expiresInSeconds: MAGIC_LINK_TTL };
}

// ─── Verify Magic Link ─────────────────────────────────────────────────────

export async function verifyMagicLink(
  input: VerifyMagicLinkInput,
): Promise<VerificationResult> {
  const raw = await redis.get(magicKey(input.token));
  if (!raw) {
    throw new AppError("INVALID_TOKEN", "Magic link is invalid or has expired", 401);
  }

  const data = JSON.parse(raw) as MagicLinkData;

  // Single-use: delete immediately
  await redis.del(magicKey(input.token));
  await redis.del(key("magic-email", data.email));

  logger.info("[Verification] Magic link verified", { email: data.email, purpose: data.purpose });

  return {
    userId: data.userId,
    email: data.email,
    purpose: data.purpose,
    ...(data.invitationToken ? { invitationToken: data.invitationToken } : {}),
  };
}

// ─── Create OTP ─────────────────────────────────────────────────────────────

export async function createOtp(
  input: RequestVerificationInput,
): Promise<{ expiresInSeconds: number }> {
  const { email, userId, purpose, invitationToken } = input;

  await invalidateExistingTokens(email);

  const code = String(randomInt(100_000, 1_000_000));
  const data: OtpData = {
    code,
    userId,
    email: email.toLowerCase(),
    purpose,
    ...(invitationToken ? { invitationToken } : {}),
    attempts: 0,
    createdAt: new Date().toISOString(),
  };

  await redis.set(otpKey(email), JSON.stringify(data), "EX", OTP_TTL);
  await setCooldown(email);

  logger.info("[Verification] OTP created", { email, purpose });

  return { expiresInSeconds: OTP_TTL };
}

// ─── Verify OTP ─────────────────────────────────────────────────────────────

export async function verifyOtp(
  input: VerifyOtpInput,
): Promise<VerificationResult> {
  const raw = await redis.get(otpKey(input.email));
  if (!raw) {
    throw new AppError("INVALID_CODE", "Code is invalid or has expired", 401);
  }

  const data = JSON.parse(raw) as OtpData;

  if (data.attempts >= MAX_OTP_ATTEMPTS) {
    await redis.del(otpKey(input.email));
    throw new AppError("MAX_ATTEMPTS", "Too many incorrect attempts. Please request a new code.", 429);
  }

  if (data.code !== input.code) {
    data.attempts += 1;
    if (data.attempts >= MAX_OTP_ATTEMPTS) {
      await redis.del(otpKey(input.email));
      throw new AppError("MAX_ATTEMPTS", "Too many incorrect attempts. Please request a new code.", 429);
    }

    const remainingTtl = await redis.ttl(otpKey(input.email));
    await redis.set(otpKey(input.email), JSON.stringify(data), "EX", remainingTtl > 0 ? remainingTtl : OTP_TTL);

    throw new AppError("INVALID_CODE", "Incorrect code", 401);
  }

  // Single-use: delete on success
  await redis.del(otpKey(input.email));

  logger.info("[Verification] OTP verified", { email: data.email, purpose: data.purpose });

  return {
    userId: data.userId,
    email: data.email,
    purpose: data.purpose,
    ...(data.invitationToken ? { invitationToken: data.invitationToken } : {}),
  };
}

// ─── Get OTP code (for email sending) ──────────────────────────────────────

export async function getOtpCode(email: string): Promise<string | null> {
  const raw = await redis.get(otpKey(email));
  if (!raw) return null;
  const data = JSON.parse(raw) as OtpData;
  return data.code;
}
