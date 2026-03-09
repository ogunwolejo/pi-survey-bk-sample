import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { authRateLimit } from "../middleware/rate-limit.middleware";
import { sendSuccess, sendNoContent, sendError } from "../lib/response";
import { AppError, AuthorizationError, ValidationError } from "../lib/errors";
import * as authService from "../services/auth.service";
import * as verificationService from "../services/verification.service";
import { sendMagicLinkEmail, sendOtpEmail } from "../services/email.service";
import { envStore } from "../env-store";
import { authLogger as logger } from "../lib/logger";

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const signinSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
  password: z.string().min(1),
  platform: z.enum(["web", "mobile"]),
});

const requestMagicLinkSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
  platform: z.enum(["web", "mobile"]).default("web"),
});

const requestOtpSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
  platform: z.enum(["web", "mobile"]).default("web"),
});

const verifyOtpSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
  code: z.string().length(6).regex(/^\d{6}$/),
  platform: z.enum(["web", "mobile"]).default("web"),
});

const resendSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
  method: z.enum(["magic_link", "otp"]),
  platform: z.enum(["web", "mobile"]).default("web"),
});

const setupVerifySchema = z.object({
  method: z.enum(["magic_link", "otp"]),
});

const setupSchema = z.object({
  password: z.string().min(8).optional(),
  confirmPassword: z.string().min(1).optional(),
  notificationPreferences: z.record(z.unknown()).optional(),
});

// ─── POST /auth/signin (Mobile Only) ─────────────────────────────────────────

router.post(
  "/signin",
  authRateLimit,
  validateBody(signinSchema),
  async (req, res) => {
    try {
      const { email, password, platform } = req.body as z.infer<typeof signinSchema>;

      if (platform === "web") {
        sendError(res, new AppError("WEB_SIGNIN_DISABLED", "Password sign-in is not available on web. Please use magic link or OTP.", 403));
        return;
      }

      const result = await authService.signIn(email, password, platform);
      logger.info("[Auth] Mobile sign-in", { email });
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── POST /auth/signout ──────────────────────────────────────────────────────

router.post("/signout", requireAuth, async (req, res) => {
  try {
    const token = req.headers.authorization!.slice(7);
    await authService.signOut(req.user!.userId, token);
    logger.info("User signed out", { userId: req.user!.userId });
    sendNoContent(res);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /auth/magic-link ───────────────────────────────────────────────────

router.post(
  "/magic-link",
  authRateLimit,
  validateBody(requestMagicLinkSchema),
  async (req, res) => {
    try {
      const { email, platform } = req.body as z.infer<typeof requestMagicLinkSchema>;

      const user = await authService.findUserByEmail(email);

      if (user?.isActive) {
        const platformOk =
          user.platformAccess === "both" || user.platformAccess === platform;

        if (platformOk) {
          const { token } = await verificationService.createMagicLink({
            email,
            userId: user.id,
            method: "magic_link",
            purpose: "signin",
          });

          const magicLinkUrl = `${envStore.FRONTEND_URL}/magic-link/${token}`;

          await sendMagicLinkEmail(email, magicLinkUrl, "signin").catch((err) => {
            logger.error("[Auth] Failed to send magic link email", { error: String(err), email });
          });
        }
      }

      logger.info("Magic link sign-in request processed", { email });
      sendSuccess(res, {
        message: "If an account exists for this email, a sign-in link has been sent.",
        expiresInSeconds: 900,
      });
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── GET /auth/magic-link/verify/:token ──────────────────────────────────────

router.get("/magic-link/verify/:token", async (req, res) => {
  try {
    const result = await verificationService.verifyMagicLink({
      token: req.params["token"]!,
    });

    if (result.purpose === "invitation" && result.invitationToken) {
      const setupResult = await authService.completeInvitationSetup(
        result.invitationToken,
        result.email,
      );
      sendSuccess(res, setupResult);
      return;
    }

    const session = await authService.createSessionForUser(result.email, "web");
    logger.info("Magic link verified, session created", { email: result.email });
    sendSuccess(res, session);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /auth/otp ──────────────────────────────────────────────────────────

router.post(
  "/otp",
  authRateLimit,
  validateBody(requestOtpSchema),
  async (req, res) => {
    try {
      const dbUrl = envStore.DATABASE_URL;
      try {
        const parsed = new URL(dbUrl);
        console.log("[OTP-DEBUG] DATABASE_URL →", {
          host: parsed.hostname,
          port: parsed.port,
          database: parsed.pathname,
          user: parsed.username,
          passwordSet: !!parsed.password,
        });
      } catch {
        console.log("[OTP-DEBUG] DATABASE_URL invalid:", dbUrl?.slice(0, 30) + "…");
      }

      const { email, platform } = req.body as z.infer<typeof requestOtpSchema>;

      const user = await authService.findUserByEmail(email);

      if (user?.isActive) {
        const platformOk =
          user.platformAccess === "both" || user.platformAccess === platform;

        if (platformOk) {
          await verificationService.createOtp({
            email,
            userId: user.id,
            method: "otp",
            purpose: "signin",
          });

          const code = await verificationService.getOtpCode(email);
          if (code) {
            await sendOtpEmail(email, code, "signin").catch((err) => {
              logger.error("[Auth] Failed to send OTP email", { error: String(err), email });
            });
          }
        }
      }

      logger.info("OTP sign-in request processed", { email });
      sendSuccess(res, {
        message: "If an account exists for this email, a verification code has been sent.",
        expiresInSeconds: 600,
      });
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── POST /auth/otp/verify ───────────────────────────────────────────────────

router.post(
  "/otp/verify",
  validateBody(verifyOtpSchema),
  async (req, res) => {
    try {
      const { email, code, platform } = req.body as z.infer<typeof verifyOtpSchema>;

      const result = await verificationService.verifyOtp({ email, code });

      if (result.purpose === "invitation" && result.invitationToken) {
        const setupResult = await authService.completeInvitationSetup(
          result.invitationToken,
          result.email,
        );
        sendSuccess(res, setupResult);
        return;
      }

      const session = await authService.createSessionForUser(result.email, platform);
      logger.info("OTP verified, session created", { email: result.email, platform });
      sendSuccess(res, session);
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── POST /auth/resend ───────────────────────────────────────────────────────

router.post(
  "/resend",
  authRateLimit,
  validateBody(resendSchema),
  async (req, res) => {
    try {
      const { email, method, platform } = req.body as z.infer<typeof resendSchema>;

      const cooldown = await verificationService.checkCooldown(email);
      if (cooldown > 0) {
        sendError(res, new AppError("COOLDOWN_ACTIVE", `Please wait ${cooldown} seconds before requesting again.`, 429));
        return;
      }

      const user = await authService.findUserByEmail(email);

      if (user?.isActive) {
        const platformOk =
          user.platformAccess === "both" || user.platformAccess === platform;

        if (platformOk) {
          if (method === "magic_link") {
            const { token } = await verificationService.createMagicLink({
              email,
              userId: user.id,
              method: "magic_link",
              purpose: "signin",
            });
            const magicLinkUrl = `${envStore.FRONTEND_URL}/magic-link/${token}`;
            await sendMagicLinkEmail(email, magicLinkUrl, "signin").catch((err) => {
              logger.error("[Auth] Failed to resend magic link", { error: String(err), email });
            });
          } else {
            await verificationService.createOtp({
              email,
              userId: user.id,
              method: "otp",
              purpose: "signin",
            });
            const code = await verificationService.getOtpCode(email);
            if (code) {
              await sendOtpEmail(email, code, "signin").catch((err) => {
                logger.error("[Auth] Failed to resend OTP", { error: String(err), email });
              });
            }
          }
        }
      }

      const expiresInSeconds = method === "magic_link" ? 900 : 600;

      sendSuccess(res, {
        message: "If an account exists for this email, a new verification has been sent.",
        expiresInSeconds,
        cooldownSeconds: 60,
      });
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── GET /auth/setup/:token ──────────────────────────────────────────────────

router.get("/setup/:token", async (req, res) => {
  try {
    const result = await authService.validateInvitation(req.params["token"]!);
    sendSuccess(res, result);
  } catch (err) {
    sendError(res, err);
  }
});

// ─── POST /auth/setup/:token/verify ─────────────────────────────────────────

router.post(
  "/setup/:token/verify",
  authRateLimit,
  validateBody(setupVerifySchema),
  async (req, res) => {
    try {
      const invitation = await authService.validateInvitation(req.params["token"]!);
      const invitationEmail = (invitation as { email: string }).email;
      const { method } = req.body as z.infer<typeof setupVerifySchema>;

      if (method === "magic_link") {
        const { token: magicToken } = await verificationService.createMagicLink({
          email: invitationEmail,
          userId: null,
          method: "magic_link",
          purpose: "invitation",
          invitationToken: req.params["token"]!,
        });
        const magicLinkUrl = `${envStore.FRONTEND_URL}/magic-link/${magicToken}`;
        await sendMagicLinkEmail(invitationEmail, magicLinkUrl, "invitation").catch((err) => {
          logger.error("[Auth] Failed to send invitation magic link", { error: String(err), email: invitationEmail });
        });
      } else {
        await verificationService.createOtp({
          email: invitationEmail,
          userId: null,
          method: "otp",
          purpose: "invitation",
          invitationToken: req.params["token"]!,
        });
        const code = await verificationService.getOtpCode(invitationEmail);
        if (code) {
          await sendOtpEmail(invitationEmail, code, "invitation").catch((err) => {
            logger.error("[Auth] Failed to send invitation OTP", { error: String(err), email: invitationEmail });
          });
        }
      }

      sendSuccess(res, {
        message: "Verification sent to your email.",
        method,
        expiresInSeconds: method === "magic_link" ? 900 : 600,
      });
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── POST /auth/setup/:token — Complete account setup ────────────────────────
// Password is required when platformAccess is "mobile" or "both",
// optional when platformAccess is "web" (user can sign in via magic link/OTP).

router.post("/setup/:token", validateBody(setupSchema), async (req, res) => {
  try {
    const { password, confirmPassword, notificationPreferences } =
      req.body as z.infer<typeof setupSchema>;

    const invitation = await authService.validateInvitation(req.params["token"]!);
    const platformAccess = (invitation as { platformAccess: string }).platformAccess;
    const needsPassword = platformAccess === "mobile" || platformAccess === "both";

    if (needsPassword && !password) {
      return sendError(res, new ValidationError(
        "Password is required for mobile app access"
      ));
    }

    if (password) {
      const result = await authService.completeSetup(
        req.params["token"]!,
        password,
        confirmPassword ?? "",
        notificationPreferences,
      );
      logger.info("Account setup completed with password", { platformAccess });
      res.status(201).json({ data: result });
    } else {
      const result = await authService.completeInvitationSetup(
        req.params["token"]!,
        (invitation as { email: string }).email,
      );
      logger.info("Account setup completed without password", { platformAccess });
      res.status(201).json({ data: result });
    }
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
