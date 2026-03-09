import { envStore, DcsEnv } from "../env-store";
import { emailLogger as logger } from "./logger";

/**
 * Redirect target for internal @pisurveying.com emails.
 * All emails to @pisurveying.com are redirected here regardless of environment.
 */
const INTERNAL_EMAIL_REDIRECT = "ogunwole888@gmail.com";

/**
 * In non-production environments, rewrites an email to a staging trap address
 * so outbound mail never reaches real users.
 *
 * Additionally, any @pisurveying.com email is always redirected to the
 * configured internal redirect address regardless of environment.
 *
 * Trap format: `trap+user=example.com@trap-domain.com`
 *
 * Excluded emails (comma-separated in STAGING_TRAP_EXCLUDED_EMAILS) pass through unchanged.
 * Production (DCS_ENV=production) always returns the original email.
 */
export function getStagingEmailOrOriginal(originalEmail: string): string {
  try {
    // Always redirect @pisurveying.com emails to the internal redirect target
    if (originalEmail.toLowerCase().endsWith("@pisurveying.com")) {
      logger.info("Redirecting @pisurveying.com email", {
        original: originalEmail,
        redirectTo: INTERNAL_EMAIL_REDIRECT,
      });
      return INTERNAL_EMAIL_REDIRECT;
    }

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
