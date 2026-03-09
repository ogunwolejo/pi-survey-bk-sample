/**
 * Backfill script for 049-payment-route schema migration.
 *
 * Populates:
 * 1. payment_number on existing Payment records (PAY-YYNNNN format)
 * 2. quickbooks_payment_id from transaction_id where applicable
 * 3. amount_paid and balance_remaining on all Orders
 *
 * Idempotent — safe to run multiple times.
 */

import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;

const pool = new Pool({ connectionString: databaseUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function backfillPaymentNumbers(): Promise<number> {
  const payments = await prisma.payment.findMany({
    where: { paymentNumber: "" },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true },
  });

  if (payments.length === 0) {
    console.log("[payment_number] No records to backfill.");
    return 0;
  }

  let updated = 0;
  for (let i = 0; i < payments.length; i++) {
    const payment = payments[i];
    if (!payment) continue;

    const year = payment.createdAt.getFullYear() % 100;
    const seq = (i + 1).toString().padStart(4, "0");
    const paymentNumber = `PAY-${year.toString().padStart(2, "0")}${seq}`;

    await prisma.payment.update({
      where: { id: payment.id },
      data: { paymentNumber },
    });
    updated++;
  }

  console.log(`[payment_number] Backfilled ${updated} records.`);
  return updated;
}

async function backfillQuickbooksPaymentId(): Promise<number> {
  const result = await prisma.$executeRaw`
    UPDATE payments
    SET quickbooks_payment_id = transaction_id
    WHERE payment_source = 'quickbooks_payments'
      AND transaction_id IS NOT NULL
      AND quickbooks_payment_id IS NULL
  `;

  console.log(`[quickbooks_payment_id] Backfilled ${result} records.`);
  return result;
}

async function backfillOrderBalances(): Promise<number> {
  const orders = await prisma.order.findMany({
    select: {
      id: true,
      price: true,
      payments: {
        where: { status: "completed" },
        select: { amount: true },
      },
    },
  });

  let updated = 0;
  for (const order of orders) {
    const totalPaid = order.payments.reduce(
      (sum, p) => sum.add(p.amount),
      new Prisma.Decimal(0),
    );
    const price = order.price ?? new Prisma.Decimal(0);
    const balance = Prisma.Decimal.max(
      new Prisma.Decimal(0),
      price.sub(totalPaid),
    );

    await prisma.order.update({
      where: { id: order.id },
      data: {
        amountPaid: totalPaid,
        balanceRemaining: balance,
      },
    });
    updated++;
  }

  console.log(`[order_balances] Updated ${updated} orders.`);
  return updated;
}

async function main(): Promise<void> {
  console.log("=== Payment Route Backfill ===\n");

  await backfillPaymentNumbers();
  await backfillQuickbooksPaymentId();
  await backfillOrderBalances();

  console.log("\n=== Backfill complete ===");
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
