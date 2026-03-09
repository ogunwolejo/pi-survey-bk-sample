import QuickBooks from "quickbooks-node-promise";
import { prisma } from "./prisma";
import { paymentLogger as logger } from "./logger";
import { envStore } from "../env-store";
import type { QBTokenData } from "../types/quickbooks";

interface TokenResult {
  accessToken: string;
  refreshToken: string;
  realmId: string;
}

export function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = 5 * 60 * 1000;
  return new Date(expiresAt).getTime() - bufferMs < Date.now();
}

export async function storeToken(tokenData: QBTokenData, realmId: string): Promise<void> {
  const accessTokenExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
  const refreshTokenExpiresAt = new Date(
    Date.now() + tokenData.x_refresh_token_expires_in * 1000,
  );

  await prisma.quickBooksToken.upsert({
    where: { realmId },
    create: {
      realmId,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    },
    update: {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    },
  });

  logger.info("QuickBooks token stored", { realmId });
}

function buildRefreshClient(currentRefreshToken: string): QuickBooks {
  return new QuickBooks(
    {
      appKey: envStore.QUICKBOOKS_CLIENT_ID,
      appSecret: envStore.QUICKBOOKS_CLIENT_SECRET,
      redirectUrl: envStore.QUICKBOOKS_REDIRECT_URL,
      accessToken: "",
      refreshToken: currentRefreshToken,
      useProduction: envStore.QUICKBOOKS_ENVIRONMENT === "production",
    },
    envStore.QUICKBOOKS_REALM_ID,
  );
}

async function refreshAndStore(opts: {
  refreshToken: string;
  realmId: string;
}): Promise<TokenResult> {
  const qb = buildRefreshClient(opts.refreshToken);
  const fresh = await qb.refreshAcessTokenWithToken(opts.refreshToken);
  const newRefresh = fresh.refresh_token ?? opts.refreshToken;

  await storeToken(
    {
      access_token: fresh.access_token,
      refresh_token: newRefresh,
      expires_in: fresh.expires_in ?? 3600,
      x_refresh_token_expires_in: fresh.x_refresh_token_expires_in ?? 8_726_400,
      token_type: fresh.token_type ?? "bearer",
    },
    opts.realmId,
  );

  logger.info("QuickBooks token refreshed", { realmId: opts.realmId });

  return {
    accessToken: fresh.access_token,
    refreshToken: newRefresh,
    realmId: opts.realmId,
  };
}

export async function getOrRefreshToken(): Promise<TokenResult> {
  const realmId = envStore.QUICKBOOKS_REALM_ID;
  const token = await prisma.quickBooksToken.findUnique({ where: { realmId } });

  if (!token) {
    throw new Error(
      "QuickBooks not authorized. Complete the OAuth flow to connect your account.",
    );
  }

  if (!isTokenExpired(token.accessTokenExpiresAt)) {
    logger.debug("QuickBooks token valid", { realmId });
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      realmId,
    };
  }

  logger.info("QuickBooks access token expired, refreshing", { realmId });
  return refreshAndStore({ refreshToken: token.refreshToken, realmId });
}
