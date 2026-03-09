import { Prisma, UserRole, PlatformAccess, UserTeam } from "@prisma/client";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { envStore } from "../env-store";
import { prisma } from "../lib/prisma";
import { redis, key } from "../lib/redis";
import { signToken } from "../lib/jwt";
import { authLogger as logger } from "../lib/logger";
import { sendEmail } from "./email.service";
import {
  AuthenticationError,
  AuthorizationError,
  ValidationError,
  NotFoundError,
} from "../lib/errors";

const BCRYPT_ROUNDS = 12;
const RESET_TOKEN_TTL = 60 * 60; // 1 hour in seconds
const JWT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function resetKey(token: string): string {
  return key("reset", token);
}

// ─── findUserByEmail ─────────────────────────────────────────────────────────

export async function findUserByEmail(email: string) {
  logger.info("Finding user by email", { email });
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  logger.info("Find user by email result", { email, found: !!user, isActive: user?.isActive });
  return user;
}

// ─── createSessionForUser ────────────────────────────────────────────────────

export async function createSessionForUser(
  email: string,
  platform?: "web" | "mobile",
): Promise<{ user: object; session: { token: string; expiresAt: Date } }> {
  logger.info("Creating session for user", { email, platform });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive) {
    logger.warn("Session creation failed — account inactive or not found", { email });
    throw new AuthenticationError("Account is inactive or not found");
  }

  if (platform) {
    const platformOk =
      user.platformAccess === "both" || user.platformAccess === platform;
    if (!platformOk) {
      logger.warn("Session creation failed — platform access denied", {
        email, platform, userPlatformAccess: user.platformAccess,
      });
      throw new AuthorizationError(
        "Your account is configured for mobile access only. Please use the Pi Surveying mobile app.",
        undefined,
        "PLATFORM_ACCESS_DENIED",
      );
    }
  }

  const token = signToken({
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    team: user.team,
    platformAccess: user.platformAccess,
  });

  const expiresAt = new Date(Date.now() + JWT_EXPIRY_MS);
  logger.info("Session created successfully", { userId: user.id, email, platform });
  return { user, session: { token, expiresAt } };
}

// ─── findOrCreateAndLogin ────────────────────────────────────────────────────
// If user doesn't exist, auto-create with admin role (for OTP-based sign-in).

export async function findOrCreateAndLogin(
  email: string,
  platform?: "web" | "mobile",
): Promise<{ user: object; session: { token: string; expiresAt: Date } }> {
  let user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    logger.info("User not found — auto-creating with admin role", { email });
    user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email,
          name: email.split("@")[0] ?? email,
          role: UserRole.admin,
          platformAccess: PlatformAccess.both,
          team: UserTeam.both,
          isActive: true,
          emailVerified: true,
        },
      });

      await tx.account.create({
        data: {
          accountId: newUser.id,
          providerId: "credential",
          userId: newUser.id,
        },
      });

      return newUser;
    });
    logger.info("Auto-created admin user", { userId: user.id, email });
  }

  return createSessionForUser(email, platform);
}

// ─── completeInvitationSetup ─────────────────────────────────────────────────

export async function completeInvitationSetup(
  invitationToken: string,
  email: string,
): Promise<{ user: object; session: { token: string; expiresAt: Date } }> {
  logger.info("Completing invitation setup", { email });

  const invitation = await prisma.invitation.findUnique({
    where: { token: invitationToken },
  });

  if (!invitation) {
    logger.warn("Invitation not found", { email });
    throw new NotFoundError("Invitation not found");
  }
  if (invitation.usedAt) {
    logger.warn("Invitation already used", { email, usedAt: invitation.usedAt });
    throw new ValidationError("Invitation has already been used");
  }
  if (invitation.expiresAt < new Date()) {
    logger.warn("Invitation expired", { email, expiresAt: invitation.expiresAt });
    throw new ValidationError("Invitation has expired");
  }

  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        platformAccess: invitation.platformAccess,
        team: invitation.team,
        isActive: true,
        emailVerified: true,
        ...(invitation.crewId && { crewId: invitation.crewId }),
      },
    });

    await tx.account.create({
      data: {
        accountId: newUser.id,
        providerId: "credential",
        userId: newUser.id,
      },
    });

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { usedAt: new Date() },
    });

    return newUser;
  });

  const token = signToken({
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    team: user.team,
    platformAccess: user.platformAccess,
  });

  const expiresAt = new Date(Date.now() + JWT_EXPIRY_MS);
  logger.info("Invitation setup completed (passwordless)", { userId: user.id, email });

  return { user, session: { token, expiresAt } };
}

// ─── signIn ─────────────────────────────────────────────────────────────────

export async function signIn(
  email: string,
  password: string,
  platform: "web" | "mobile"
): Promise<{ user: object; session: { token: string; expiresAt: Date } }> {
  logger.info("Sign-in attempt", { email, platform });

  const user = await prisma.user.findUnique({
    where: { email },
    include: { accounts: { where: { providerId: "credential" } } },
  });

  if (!user || !user.isActive) {
    logger.warn("Sign-in failed — invalid credentials or inactive account", { email });
    throw new AuthenticationError("Invalid credentials");
  }

  const platformOk =
    user.platformAccess === "both" || user.platformAccess === platform;
  if (!platformOk) {
    logger.warn("Sign-in failed — platform access denied", { email, platform, userPlatformAccess: user.platformAccess });
    throw new AuthenticationError("Platform access denied");
  }

  const account = user.accounts[0];
  if (!account?.password) {
    logger.warn("Sign-in failed — no credential account found", { email });
    throw new AuthenticationError("Invalid credentials");
  }

  const valid = await bcrypt.compare(password, account.password);
  if (!valid) {
    logger.warn("Sign-in failed — password mismatch", { email });
    throw new AuthenticationError("Invalid credentials");
  }

  const token = signToken({
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    team: user.team,
    platformAccess: user.platformAccess,
  });

  const expiresAt = new Date(Date.now() + JWT_EXPIRY_MS);

  const { accounts: _accounts, ...safeUser } = user;

  logger.info("Sign-in successful", { userId: user.id, email, platform });
  return { user: safeUser, session: { token, expiresAt } };
}

// ─── signOut ────────────────────────────────────────────────────────────────

export async function signOut(userId: string, token: string): Promise<void> {
  logger.info("Processing sign-out", { userId });
  await redis.set(key("blacklist", token), userId, "EX", 7 * 24 * 3600);
  logger.info("Sign-out completed — token blacklisted", { userId });
}

// ─── forgotPassword ─────────────────────────────────────────────────────────

export async function forgotPassword(email: string): Promise<{ message: string }> {
  logger.info("Forgot password request", { email });
  const user = await prisma.user.findUnique({ where: { email } });

  if (user?.isActive) {
    logger.info("User found — generating reset token", { userId: user.id, email });
    const resetToken = uuidv4();
    await redis.set(resetKey(resetToken), user.id, "EX", RESET_TOKEN_TTL);

    const resetUrl = `${envStore.FRONTEND_URL}/reset-password/${resetToken}`;

    await sendEmail({
      to: email,
      subject: "Reset your Pi Surveying password",
      html: [
        `<p>Hi ${user.name ?? ""},</p>`,
        `<p>We received a request to reset your password. Click the link below to set a new one:</p>`,
        `<p><a href="${resetUrl}">${resetUrl}</a></p>`,
        `<p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>`,
        `<p>— Pi Surveying</p>`,
      ].join("\n"),
    }).catch((err) => {
      logger.error("Failed to send password reset email", {
        error: String(err),
        userId: user.id,
      });
    });
  }

  return { message: "If that email is registered, a reset link has been sent." };
}

// ─── resetPassword ───────────────────────────────────────────────────────────

export async function resetPassword(
  token: string,
  password: string,
  confirmPassword: string
): Promise<{ message: string }> {
  logger.info("Password reset attempt");

  if (password !== confirmPassword) {
    logger.warn("Password reset failed — passwords do not match");
    throw new ValidationError("Passwords do not match");
  }

  const userId = await redis.get(resetKey(token));
  if (!userId) {
    logger.warn("Password reset failed — invalid or expired token");
    throw new ValidationError("Reset token is invalid or has expired");
  }

  logger.info("Reset token validated — hashing new password", { userId });
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  await prisma.account.updateMany({
    where: { userId, providerId: "credential" },
    data: { password: hash },
  });

  await redis.del(resetKey(token));

  logger.info("Password reset completed successfully", { userId });
  return { message: "Password has been reset successfully." };
}

// ─── changePassword ──────────────────────────────────────────────────────────

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  confirmPassword: string
): Promise<{ message: string }> {
  logger.info("Change password attempt", { userId });

  if (newPassword !== confirmPassword) {
    logger.warn("Change password failed — new passwords do not match", { userId });
    throw new ValidationError("New passwords do not match");
  }

  const account = await prisma.account.findFirst({
    where: { userId, providerId: "credential" },
  });

  if (!account?.password) {
    logger.warn("Change password failed — no credential account found", { userId });
    throw new AuthenticationError("No credential account found");
  }

  const valid = await bcrypt.compare(currentPassword, account.password);
  if (!valid) {
    logger.warn("Change password failed — current password incorrect", { userId });
    throw new AuthenticationError("Current password is incorrect");
  }

  logger.info("Current password verified — hashing new password", { userId });
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await prisma.account.update({
    where: { id: account.id },
    data: { password: hash },
  });

  logger.info("Password changed successfully", { userId });
  return { message: "Password updated successfully." };
}

// ─── validateInvitation ──────────────────────────────────────────────────────

export async function validateInvitation(token: string): Promise<object> {
  logger.info("Validating invitation token");

  const invitation = await prisma.invitation.findUnique({ where: { token } });

  if (!invitation) {
    logger.warn("Invitation not found for token");
    throw new NotFoundError("Invitation not found");
  }
  if (invitation.usedAt) {
    logger.warn("Invitation already used", { email: invitation.email, usedAt: invitation.usedAt });
    throw new ValidationError("Invitation has already been used");
  }
  if (invitation.expiresAt < new Date()) {
    logger.warn("Invitation expired", { email: invitation.email, expiresAt: invitation.expiresAt });
    throw new ValidationError("Invitation has expired");
  }

  logger.info("Invitation validated successfully", { email: invitation.email, role: invitation.role });
  return {
    email: invitation.email,
    name: invitation.name,
    role: invitation.role,
    platformAccess: invitation.platformAccess,
    team: invitation.team,
  };
}

// ─── completeSetup ───────────────────────────────────────────────────────────

export async function completeSetup(
  token: string,
  password: string,
  confirmPassword: string,
  notificationPreferences?: Record<string, unknown>
): Promise<{ user: object; session: { token: string; expiresAt: Date } }> {
  logger.info("Account setup attempt (with password)");

  if (password !== confirmPassword) {
    logger.warn("Account setup failed — passwords do not match");
    throw new ValidationError("Passwords do not match");
  }

  const invitation = await prisma.invitation.findUnique({ where: { token } });

  if (!invitation) {
    logger.warn("Account setup failed — invitation not found");
    throw new NotFoundError("Invitation not found");
  }
  if (invitation.usedAt) {
    logger.warn("Account setup failed — invitation already used", { email: invitation.email });
    throw new ValidationError("Invitation has already been used");
  }
  if (invitation.expiresAt < new Date()) {
    logger.warn("Account setup failed — invitation expired", { email: invitation.email });
    throw new ValidationError("Invitation has expired");
  }

  logger.info("Invitation validated — creating user account", { email: invitation.email, role: invitation.role });

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        platformAccess: invitation.platformAccess,
        team: invitation.team,
        isActive: true,
        emailVerified: true,
        notificationPreferences: (notificationPreferences ?? undefined) as Prisma.InputJsonValue | undefined,
        ...(invitation.crewId && { crewId: invitation.crewId }),
      },
    });

    await tx.account.create({
      data: {
        accountId: newUser.id,
        providerId: "credential",
        userId: newUser.id,
        password: hash,
      },
    });

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { usedAt: new Date() },
    });

    return newUser;
  });

  const jwtToken = signToken({
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    team: user.team,
    platformAccess: user.platformAccess,
  });

  const expiresAt = new Date(Date.now() + JWT_EXPIRY_MS);

  logger.info("User setup completed", { userId: user.id, email: user.email });

  return { user, session: { token: jwtToken, expiresAt } };
}
