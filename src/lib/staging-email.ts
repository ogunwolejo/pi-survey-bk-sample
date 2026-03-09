import { envStore, DcsEnv } from "../env-store";
import { emailLogger as logger } from "./logger";

/**
 * In non-production environments, rewrites an email to a staging trap address
 * so outbound mail never reaches real users.
 *
 * Trap format: `trap+user=example.com@trap-domain.com`
 *
 * Excluded emails (comma-separated in STAGING_TRAP_EXCLUDED_EMAILS) pass through unchanged.
 * Production (DCS_ENV=production) always returns the original email.
 */
export function getStagingEmailOrOriginal(originalEmail: string): string {
  try {
    if (process.env.DCS_ENV === DcsEnv.PROD) return originalEmail;

    const trapEmail = envStore.STAGING_TRAP_EMAIL;
    if (!trapEmail) return originalEmail;

    const excludedRaw = envStore.STAGING_TRAP_EXCLUDED_EMAILS;
    if (excludedRaw) {
      const excluded = excludedRaw
        .split(",")
        .map((e) => e.trim().toLowerCase());
      if (excluded.includes(originalEmail.toLowerCase())) {
        return originalEmail;
      }
    }

    const encoded = originalEmail.replace("@", "=");
    return trapEmail.replace("@", `+${encoded}@`);
  } catch (error) {
    logger.error("Error in staging email trap", {
      error: String(error),
      originalEmail,
    });
    return originalEmail;
  }
}
