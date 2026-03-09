import { Router } from "express";
import crypto from "crypto";
import QuickBooks from "quickbooks-node-promise";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import { paymentLogger as logger } from "../lib/logger";
import { envStore } from "../env-store";
import { sendSuccess, sendError } from "../lib/response";
import { storeToken } from "../lib/quickbooks-auth";

const router = Router();

// ─── GET /authorize ──────────────────────────────────────────────────────────

router.get("/authorize", requireAuth, requireRole("admin"), (_req, res) => {
  try {
    const state = crypto.randomBytes(16).toString("hex");
    const params = new URLSearchParams({
      client_id: envStore.QUICKBOOKS_CLIENT_ID,
      redirect_uri: envStore.QUICKBOOKS_REDIRECT_URL,
      response_type: "code",
      scope: "com.intuit.quickbooks.accounting",
      state,
    });

    res.redirect(
      `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`,
    );
  } catch (err) {
    logger.error("QuickBooks authorize failed", { error: String(err) });
    sendError(res, err);
  }
});

// ─── GET /callback ───────────────────────────────────────────────────────────

router.get("/callback", async (req, res) => {
  try {
    const { code, realmId } = req.query;

    if (typeof code !== "string" || typeof realmId !== "string") {
      res.status(400).json({
        error: { code: "INVALID_PARAMS", message: "Missing code or realmId" },
      });
      return;
    }

    const tokenData = await QuickBooks.createToken(
      {
        appKey: envStore.QUICKBOOKS_CLIENT_ID,
        appSecret: envStore.QUICKBOOKS_CLIENT_SECRET,
        redirectUrl: envStore.QUICKBOOKS_REDIRECT_URL,
      },
      code,
      realmId,
    );

    await storeToken(
      {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token ?? "",
        expires_in: tokenData.expires_in ?? 3600,
        x_refresh_token_expires_in: tokenData.x_refresh_token_expires_in ?? 8_726_400,
        token_type: tokenData.token_type ?? "bearer",
      },
      realmId,
    );
    logger.info("QuickBooks OAuth2 completed", { realmId });

    res.redirect(`${envStore.FRONTEND_URL}/settings?qb=connected`);
  } catch (err) {
    logger.error("QuickBooks callback failed", { error: String(err) });
    res.redirect(`${envStore.FRONTEND_URL}/settings?qb=error`);
  }
});

// ─── GET /status ─────────────────────────────────────────────────────────────

router.get("/status", requireAuth, async (_req, res) => {
  try {
    const token = await prisma.quickBooksToken.findFirst({
      select: {
        realmId: true,
        accessTokenExpiresAt: true,
        updatedAt: true,
      },
    });

    sendSuccess(res, {
      connected: !!token,
      realmId: token?.realmId ?? null,
      tokenExpiry: token?.accessTokenExpiresAt ?? null,
      lastUpdated: token?.updatedAt ?? null,
    });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
