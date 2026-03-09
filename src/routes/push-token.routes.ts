import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { generalLogger as logger } from "../lib/logger";

const router = Router();

const registerTokenSchema = z.object({
  token: z.string().min(1).startsWith("ExponentPushToken["),
  deviceId: z.string().optional(),
  platform: z.enum(["ios", "android"]).optional(),
});

const deleteTokenSchema = z.object({
  token: z.string().min(1).startsWith("ExponentPushToken["),
});

router.post("/", requireAuth, validateBody(registerTokenSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof registerTokenSchema>;
    const userId = req.user!.userId;

    const existing = await prisma.expoPushToken.findUnique({
      where: { userId_token: { userId, token: body.token } },
    });

    if (existing) {
      const updated = await prisma.expoPushToken.update({
        where: { id: existing.id },
        data: {
          deviceId: body.deviceId,
          platform: body.platform,
        },
      });
      logger.info("[PushToken] Token updated", { userId, tokenId: updated.id });
      sendSuccess(res, updated);
      return;
    }

    const created = await prisma.expoPushToken.create({
      data: {
        userId,
        token: body.token,
        deviceId: body.deviceId,
        platform: body.platform,
      },
    });

    logger.info("[PushToken] Token registered", { userId, tokenId: created.id });
    sendSuccess(res, created, 201);
  } catch (err) {
    sendError(res, err);
  }
});

router.delete("/", requireAuth, validateBody(deleteTokenSchema), async (req, res) => {
  try {
    const body = req.body as z.infer<typeof deleteTokenSchema>;
    const userId = req.user!.userId;

    const deleted = await prisma.expoPushToken.deleteMany({
      where: { userId, token: body.token },
    });

    if (deleted.count === 0) {
      res.status(404).json({ error: "Token not found" });
      return;
    }

    logger.info("[PushToken] Token removed", { userId, token: body.token });
    res.status(204).send();
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
