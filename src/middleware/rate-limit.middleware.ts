import rateLimit from "express-rate-limit";

export const publicRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests. Please try again later." } },
});

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const body = req.body as Record<string, unknown>;
    return typeof body.email === "string" ? body.email : req.ip ?? "unknown";
  },
  message: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many login attempts. Please try again in 15 minutes." } },
});

export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests." } },
});

export const proposalGetRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests. Please try again in a moment." } },
});

export const proposalPostRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests. Please wait before trying again." } },
});
