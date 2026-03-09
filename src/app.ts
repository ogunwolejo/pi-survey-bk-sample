import express from "express";
import cors from "cors";
import helmet from "helmet";
import { json, urlencoded } from "express";
import { envStore, AppEnv } from "./env-store";
import { apiRateLimit } from "./middleware/rate-limit.middleware";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware";
import { correlationMiddleware } from "./middleware/correlation.middleware";
import { generalLogger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { redis } from "./lib/redis";
import authRoutes from "./routes/auth.routes";
import quoteRoutes, {
  publicQuoteRequestRouter,
  quoteTokenRouter,
} from "./routes/quote.routes";
import orderRoutes from "./routes/order.routes";
import orderRequestRoutes from "./routes/order-request.routes";
import jobRoutes from "./routes/job.routes";
import contactRoutes from "./routes/contact.routes";
import invoiceRoutes from "./routes/invoice.routes";
import paymentRoutes from "./routes/payment.routes";
import shippingRoutes from "./routes/shipping.routes";
import deliveryRoutes from "./routes/delivery.routes";
import documentRoutes from "./routes/document.routes";
import settingsRoutes from "./routes/settings.routes";
import auditRoutes from "./routes/audit.routes";
import notificationRoutes from "./routes/notification.routes";
import pushSubscriptionRoutes from "./routes/push-subscription.routes";
import pushTokenRoutes from "./routes/push-token.routes";
import userRoutes from "./routes/user.routes";
import trackingRoutes from "./routes/tracking.routes";
import abandonmentRoutes from "./routes/abandonment.routes";
import clientPortalRoutes from "./routes/client-portal.routes";
import { createCrewRouter } from "./routes/crew.routes";
import { createWebhookRouter } from "./routes/webhook.routes";
import { createQuoteActivityRouter } from "./routes/quote-activity.routes";
import { createOrderActivityRouter } from "./routes/order-activity.routes";
import quickbooksRoutes from "./routes/quickbooks.routes";
import proposalRoutes from "./routes/proposal.routes";
import { createOrderProposalRouter } from "./routes/order-proposal.routes";
import { createRouteRouter } from "./routes/route.routes";
import { createJobChatRouter } from "./routes/job-chat.routes";
import { createJobActivityRouter } from "./routes/job-activity.routes";
import { createJobIssueFlagRouter } from "./routes/job-issue-flag.routes";
import { createPLSReviewRouter } from "./routes/pls-review.routes";
import { createDraftingQueueRouter } from "./routes/drafting-queue.routes";
import { createPipelineRouter } from "./routes/pipeline.routes";
import { createDashboardRouter } from "./routes/dashboard.routes";
import holidayRouter from "./routes/holiday.routes";
import { createStakingRouter } from "./routes/staking.routes";
import { createOrderDocumentRouter } from "./routes/order-document.routes";
import { createOrderResearchFieldRouter } from "./routes/order-research-field.routes";
import { createChatRouter } from "./routes/chat.routes";
import type { Server as SocketServer } from "socket.io";

export function createApp(io: SocketServer) {
  const app = express();

  // Correlation ID (first middleware — before logging)
  app.use(correlationMiddleware);

  // Security & parsing — CORS before helmet so preflight isn't blocked
  app.use(cors({
    origin: "*",
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }));
  app.use(helmet({
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
  app.use("/api/webhooks", json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  app.use(json({ limit: "10mb" }));
  app.use(urlencoded({ extended: true }));

  if (envStore.NODE_ENV !== AppEnv.TEST) {
    app.use((req, res, next) => {
      const start = Date.now();

      generalLogger.info("Endpoint triggered", {
        method: req.method,
        url: req.originalUrl,
        ...(Object.keys(req.params).length > 0 ? { params: req.params } : {}),
        ...(Object.keys(req.query).length > 0 ? { query: req.query } : {}),
        ip: req.ip,
      });

      res.on("finish", () => {
        const duration = Date.now() - start;
        const meta = {
          method: req.method,
          url: req.originalUrl,
          statusCode: res.statusCode,
          duration: `${duration}ms`,
          userId: (req as unknown as { user?: { userId?: string } }).user?.userId,
        };
        if (res.statusCode >= 500) {
          generalLogger.error("Endpoint completed", meta);
        } else if (res.statusCode >= 400) {
          generalLogger.warn("Endpoint completed", meta);
        } else {
          generalLogger.info("Endpoint completed", meta);
        }
      });
      next();
    });
  }

  // Make io available to route handlers
  app.set("io", io);

  // General rate limiting
  app.use("/api", apiRateLimit);

  // Lightweight health check for ALB/ECS (no dependency checks)
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Deep health check
  app.get("/health", async (_req, res) => {
    const timeout = (ms: number) =>
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));

    const checks: Record<string, "ok" | "error"> = { database: "error", redis: "error" };

    try {
      await Promise.race([prisma.$queryRawUnsafe("SELECT 1"), timeout(2000)]);
      checks.database = "ok";
    } catch { /* leave as error */ }

    try {
      await Promise.race([redis.ping(), timeout(2000)]);
      checks.redis = "ok";
    } catch { /* leave as error */ }

    const healthy = checks.database === "ok" && checks.redis === "ok";

    res.status(healthy ? 200 : 503).json({
      data: {
        status: healthy ? "healthy" : "degraded",
        version: process.env.npm_package_version ?? "1.0.0",
        uptime: Math.floor(process.uptime()),
        checks,
      },
    });
  });

  // API routes
  app.use("/api/auth", authRoutes);
  app.use("/api/quotes", quoteRoutes);
  app.use("/api/quotes/:id/activity", createQuoteActivityRouter(io));
  app.use("/api/quote-requests", publicQuoteRequestRouter);
  app.use("/api/quote", quoteTokenRouter);
  app.use("/api/orders", orderRoutes);
  app.use("/api/orders/:id/activity", createOrderActivityRouter(io));
  app.use("/api/order-requests", orderRequestRoutes);
  app.use("/api/jobs", jobRoutes);
  app.use("/api/contacts", contactRoutes);
  app.use("/api/invoices", invoiceRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/shipping", shippingRoutes);
  app.use("/api/delivery", deliveryRoutes);
  app.use("/api/files", documentRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/audit", auditRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/push-subscriptions", pushSubscriptionRoutes);
  app.use("/api/push-tokens", pushTokenRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/portal/tracking", trackingRoutes);
  app.use("/api/abandonment", abandonmentRoutes);
  app.use("/api/client-portal", clientPortalRoutes);
  app.use("/api/crews", createCrewRouter(io));
  app.use("/api/webhooks", createWebhookRouter(io));
  app.use("/api/quickbooks", quickbooksRoutes);
  app.use("/api/proposal", proposalRoutes);
  app.use("/api/order-proposals", createOrderProposalRouter(io));

  // Field Ops Pipeline routes
  app.use("/api/routes", createRouteRouter(io));
  app.use("/api/jobs/:jobId/chat", createJobChatRouter(io));
  app.use("/api/jobs/:jobId/activity", createJobActivityRouter(io));
  app.use("/api/jobs/:jobId/flags", createJobIssueFlagRouter(io));
  const plsReviewRouter = createPLSReviewRouter(io);
  app.use("/api/jobs", plsReviewRouter);
  const draftingQueueRouter = createDraftingQueueRouter();
  app.use("/api/jobs", draftingQueueRouter);
  app.use("/api/pipeline", createPipelineRouter(io));
  app.use("/api/dashboard", createDashboardRouter());
  app.use("/api/holidays", holidayRouter);
  app.use("/api/staking", createStakingRouter(io));
  app.use("/api/orders", createOrderDocumentRouter(io));
  app.use("/api/orders", createOrderResearchFieldRouter(io));

  // Unified Entity Chat
  app.use("/api/chat/:entityType/:entityId", createChatRouter(io));

  // 404 and error handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
