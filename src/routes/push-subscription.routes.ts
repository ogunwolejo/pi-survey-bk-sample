import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { generalLogger as logger } from "../lib/logger";
import { requireAuth } from "../middleware/auth.middleware";
import { envStore } from "../env-store";

const router = Router();

const upsertSchema = z.object({
  endpoint: z.string().url(),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
  userAgent: z.string().optional(),
});

const deleteSchema = z.object({
  endpoint: z.string().url(),
});

// GET /vapid-key → return VAPID public key (public, no auth)
router.get("/vapid-key", async (_req: Request, res: Response) => {
  if (!envStore.VAPID_PUBLIC_KEY) {
    res.status(503).json({ error: "Push notifications not configured" });
    return;
  }
  res.json({ data: { vapidPublicKey: envStore.VAPID_PUBLIC_KEY } });
});

// POST / → upsert a push subscription for the authenticated user
router.post("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const userId = req.user!.userId;
    const { endpoint, p256dh, auth, userAgent } = parsed.data;

    await prisma.pushSubscription.upsert({
      where: { userId_endpoint: { userId, endpoint } },
      update: { p256dh, auth, userAgent },
      create: { userId, endpoint, p256dh, auth, userAgent },
    });

    res.status(201).json({ success: true });
  } catch (error) {
    logger.error("[PushSubscription] Upsert failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE / → remove a push subscription by endpoint for the authenticated user
router.delete("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const parsed = deleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const userId = req.user!.userId;
    const { endpoint } = parsed.data;

    await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });

    res.json({ success: true });
  } catch (error) {
    logger.error("[PushSubscription] Delete failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
