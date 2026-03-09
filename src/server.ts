import "dotenv/config";
import { configureEnv, envStore } from "./env-store";

import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import { createApp } from "./app";
import { prisma } from "./lib/prisma";
import { redis } from "./lib/redis";
import { generalLogger as logger, socketLogger } from "./lib/logger";
import { verifyToken } from "./lib/jwt";
import { ROOM_PREFIXES } from "./lib/socket-rooms";
import { startDashboardEventWorker, getEventsSince } from "./lib/dashboard-event-queue";
import { startCustomerIoWorker } from "./lib/customerio-worker";
import { startEscalationWorker } from "./workers/escalation.worker";
import { startSiteAccessWorker } from "./workers/site-access.worker";
import { setSocketServer } from "./lib/socket-emitter";
import { startPaymentAuditWorker } from "./services/payment-audit.service";
import { runSeed } from "./seed";

async function bootstrap() {
  await configureEnv();

  // Run database seed on startup
  try {
    await runSeed();
    logger.info("Database seed completed");
  } catch (err) {
    logger.error("Database seed failed", { error: String(err) });
  }

  const PORT = parseInt(envStore.PORT, 10);

  const io = new SocketServer({
    path: "/socket.io",
    cors: {
      origin: [envStore.FRONTEND_URL],
      methods: ["GET", "POST"],
      credentials: true,
    },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: false,
    },
  });

  const app = createApp(io);
  const httpServer = createServer(app);

  io.attach(httpServer);

  setSocketServer(io);

  // Start BullMQ workers
  startDashboardEventWorker(io);
  startCustomerIoWorker();
  startEscalationWorker();
  startSiteAccessWorker();
  startPaymentAuditWorker();

  // Socket.io auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token as string | undefined;
    if (!token) {
      // Public connections (e.g. client portal tracking) — allow but no user
      return next();
    }
    try {
      const user = verifyToken(token);
      socket.data.user = user;
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as { userId: string } | undefined;
    socketLogger.info("Socket connected", { socketId: socket.id, userId: user?.userId });

    if (user) {
      void socket.join(ROOM_PREFIXES.USER(user.userId));
    }

    socket.on("join:dashboard", (dashboard: string) => {
      if (!user) return;
      const validRooms = ["quotes", "orders", "jobs", "payments", "shipping", "contacts"];
      if (validRooms.includes(dashboard)) {
        void socket.join(`dashboard:${dashboard}`);
      }
    });

    socket.on("join:job", (jobId: string) => {
      if (!user) return;
      void socket.join(ROOM_PREFIXES.JOB(jobId));
    });

    socket.on("join:quote", (quoteId: string) => {
      if (!user) return;
      void socket.join(ROOM_PREFIXES.QUOTE(quoteId));
    });

    socket.on("join:order", (orderId: string) => {
      if (!user) return;
      void socket.join(ROOM_PREFIXES.ORDER(orderId));
    });

    socket.on("join:payment", (paymentId: string) => {
      if (!user) return;
      void socket.join(ROOM_PREFIXES.PAYMENT(paymentId));
    });

    socket.on("join:tracking", (token: string) => {
      void socket.join(ROOM_PREFIXES.TRACKING(token));
    });

    socket.on("join:chat", (payload: { entityType: string; entityId: string }) => {
      if (!user) return;
      const validTypes = ["quote", "order", "job"];
      if (validTypes.includes(payload.entityType) && payload.entityId) {
        void socket.join(ROOM_PREFIXES.ENTITY_CHAT(payload.entityType, payload.entityId));
      }
    });

    socket.on("leave:chat", (payload: { entityType: string; entityId: string }) => {
      if (!user) return;
      if (payload.entityType && payload.entityId) {
        void socket.leave(ROOM_PREFIXES.ENTITY_CHAT(payload.entityType, payload.entityId));
      }
    });

    socket.on("join:room", (room: string) => {
      if (!user) return;
      const allowedRooms = [
        ROOM_PREFIXES.PIPELINE_BOARD,
        ROOM_PREFIXES.DASHBOARD_ACTIVE_JOBS,
        ROOM_PREFIXES.DASHBOARD_FIELD_TRACKING,
        ROOM_PREFIXES.DASHBOARD_CAPACITY,
      ];
      const isDynamic =
        room.startsWith("job:chat:") ||
        room.startsWith("job:") ||
        room.startsWith("staking:");
      if (allowedRooms.includes(room as (typeof allowedRooms)[number]) || isDynamic) {
        void socket.join(room);
      }
    });

    socket.on("dashboard:catchup", async (sinceTimestamp: number) => {
      if (!user) return;
      try {
        const events = await getEventsSince(sinceTimestamp);
        for (const evt of events) {
          socket.emit(evt.event, evt.payload);
        }
      } catch (err) {
        logger.warn("Dashboard catchup failed", { error: String(err) });
      }
    });

    socket.on("disconnect", () => {
      logger.debug("Socket disconnected", { socketId: socket.id });
    });
  });

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`${signal} received — shutting down`);
    io.close();
    httpServer.close(async () => {
      try {
        await prisma.$disconnect();
        logger.info("Prisma disconnected");
        await redis.quit();
        logger.info("Redis disconnected");
        process.exit(0);
      } catch (err) {
        logger.error("Shutdown cleanup error", { error: String(err) });
        process.exit(1);
      }
    });
    setTimeout(() => {
      logger.warn("Forced shutdown — timeout exceeded");
      process.exit(1);
    }, 10_000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(PORT, () => {
      logger.info(
        `Backend running on http://localhost:${PORT} [${envStore.NODE_ENV}]`,
      );
      resolve();
    });
    httpServer.on("error", reject);
  });
}

bootstrap().catch((err) => {
  logger.error("Failed to start server", { error: String(err) });
  process.exit(1);
});
