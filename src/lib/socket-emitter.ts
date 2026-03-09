import type { Server as SocketServer } from "socket.io";
import { socketLogger as logger } from "./logger";

// ─── Dashboard Room Names ──────────────────────────────────────────────────────

export type DashboardRoom = "dashboard:quotes" | "dashboard:orders" | "dashboard:payments";

// ─── Quote Event Payloads ──────────────────────────────────────────────────────

export interface QuoteCreatedPayload {
  quoteId: string;
  quoteNumber: string;
  status: string;
}

export interface QuoteUpdatedPayload {
  quoteId: string;
  status: string;
}

export interface QuoteDeletedPayload {
  quoteId: string;
}

// ─── Order Event Payloads ──────────────────────────────────────────────────────

export interface OrderCreatedPayload {
  orderId: string;
  orderNumber: string;
  status: string;
}

export interface OrderUpdatedPayload {
  orderId: string;
  status: string;
}

export interface OrderDeletedPayload {
  orderId: string;
}

// ─── Payment Event Payloads ──────────────────────────────────────────────────

export interface PaymentCreatedPayload {
  paymentId: string;
  paymentNumber: string;
  amount: number;
  paymentMethod: string;
  status: string;
  orderId: string;
  jobId?: string;
  balanceRemaining: number;
  fullyPaid: boolean;
  orderNumber?: string;
  jobNumber?: string;
}

export interface PaymentStatusChangedPayload {
  paymentId: string;
  oldStatus: string;
  newStatus: string;
  balanceRemaining: number;
  fullyPaid: boolean;
}

export interface PaymentBalanceUpdatedPayload {
  orderId: string;
  amountPaid: number;
  balanceRemaining: number;
  fullyPaid: boolean;
}

// ─── Event Map ────────────────────────────────────────────────────────────────

type DashboardEventMap = {
  "quote:created": QuoteCreatedPayload;
  "quote:updated": QuoteUpdatedPayload;
  "quote:deleted": QuoteDeletedPayload;
  "order:created": OrderCreatedPayload;
  "order:updated": OrderUpdatedPayload;
  "order:deleted": OrderDeletedPayload;
  "payment:created": PaymentCreatedPayload;
};

export type DashboardEventName = keyof DashboardEventMap;

// ─── Scoped Payment Event Emitter ─────────────────────────────────────────────

let _io: SocketServer | null = null;

export function setSocketServer(io: SocketServer): void {
  _io = io;
}

export function emitPaymentEvent(
  event: string,
  rooms: string[],
  payload: Record<string, unknown>,
): void {
  if (!_io) return;
  for (const room of rooms) {
    _io.to(room).emit(event, payload);
  }
}

// ─── Lazy import to avoid circular dependency at module load ────────────────

let _enqueue: ((room: DashboardRoom, event: DashboardEventName, payload: Record<string, unknown>) => Promise<void>) | null = null;

async function getEnqueue() {
  if (!_enqueue) {
    const mod = await import("./dashboard-event-queue");
    _enqueue = mod.enqueueDashboardEvent;
  }
  return _enqueue;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Enqueues a typed dashboard event for reliable delivery via BullMQ.
 * The BullMQ worker will emit via Socket.io and store in the event log.
 *
 * The `io` parameter is kept for backward compatibility but is no longer used
 * directly — the worker holds the io reference from server bootstrap.
 */
export function emitDashboardEvent<E extends DashboardEventName>(
  io: SocketServer | undefined,
  room: DashboardRoom,
  event: E,
  payload: DashboardEventMap[E]
): void {
  getEnqueue()
    .then((enqueue) => enqueue(room, event, payload as unknown as Record<string, unknown>))
    .catch((err) => {
      logger.error("Failed to enqueue dashboard event", {
        room,
        event,
        error: String(err),
      });
    });
}
