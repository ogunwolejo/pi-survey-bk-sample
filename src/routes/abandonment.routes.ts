import { Router, Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { validateBody } from "../middleware/validate.middleware";
import { sendSuccess, sendError } from "../lib/response";
import { generalLogger as logger } from "../lib/logger";

const router = Router();

const abandonmentSchema = z.object({
  form_type: z.enum(["quote_request", "direct_order", "quote_acceptance"]),
  email: z.string().email(),
  partial_data: z.record(z.unknown()),
  quote_id: z.string().uuid().optional(),
});

// POST / → public, save or update abandoned form data (upsert by email + form_type)
router.post("/", validateBody(abandonmentSchema), async (req: Request, res: Response) => {
  try {
    const { form_type, email, partial_data, quote_id } =
      req.body as z.infer<typeof abandonmentSchema>;

    const now = new Date();

    const existing = await prisma.abandonedForm.findFirst({
      where: { email, formType: form_type },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      await prisma.abandonedForm.update({
        where: { id: existing.id },
        data: {
          partialData: partial_data as Prisma.InputJsonValue,
          abandonedAt: now,
          ...(quote_id !== undefined && { quoteId: quote_id }),
        },
      });
    } else {
      await prisma.abandonedForm.create({
        data: {
          formType: form_type,
          email,
          partialData: partial_data as Prisma.InputJsonValue,
          abandonedAt: now,
          quoteId: quote_id ?? null,
        },
      });
    }

    logger.info("Abandoned form data saved", { formType: form_type, email });
    sendSuccess(res, { message: "Form data saved" });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
