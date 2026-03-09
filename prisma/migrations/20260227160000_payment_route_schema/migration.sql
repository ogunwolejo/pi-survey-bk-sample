-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'completed', 'failed', 'refunded', 'voided');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentType" ADD VALUE 'final';
ALTER TYPE "PaymentType" ADD VALUE 'refund';

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_invoice_id_fkey";

-- DropIndex
DROP INDEX "payments_quote_id_key";

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "amount_paid" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "balance_remaining" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "bank_name" TEXT,
ADD COLUMN     "check_number" TEXT,
ADD COLUMN     "convenience_fee" DECIMAL(65,30),
ADD COLUMN     "job_id" TEXT,
ADD COLUMN     "payment_number" TEXT NOT NULL,
ADD COLUMN     "quickbooks_payment_id" TEXT,
ADD COLUMN     "status" "PaymentStatus" NOT NULL DEFAULT 'completed',
ALTER COLUMN "invoice_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "payment_audit_log" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "user_name" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "entity_number" TEXT,
    "metadata" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_audit_log_entity_type_entity_id_idx" ON "payment_audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "payment_audit_log_user_id_idx" ON "payment_audit_log"("user_id");

-- CreateIndex
CREATE INDEX "payment_audit_log_action_type_idx" ON "payment_audit_log"("action_type");

-- CreateIndex
CREATE INDEX "payment_audit_log_created_at_idx" ON "payment_audit_log"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payments_payment_number_key" ON "payments"("payment_number");

-- CreateIndex
CREATE UNIQUE INDEX "payments_quickbooks_payment_id_key" ON "payments"("quickbooks_payment_id");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "payments_job_id_idx" ON "payments"("job_id");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_payment_date_idx" ON "payments"("payment_date" DESC);

-- CreateIndex
CREATE INDEX "payments_payment_number_idx" ON "payments"("payment_number");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_audit_log" ADD CONSTRAINT "payment_audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

