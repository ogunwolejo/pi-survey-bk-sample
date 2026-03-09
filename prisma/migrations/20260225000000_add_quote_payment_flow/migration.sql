-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('deposit', 'full');

-- CreateEnum
CREATE TYPE "QuoteTokenType" AS ENUM ('legacy', 'proposal');

-- AlterTable: QuoteToken - add tokenType
ALTER TABLE "quote_tokens" ADD COLUMN "token_type" "QuoteTokenType" NOT NULL DEFAULT 'legacy';

-- AlterTable: Payment - add new fields
ALTER TABLE "payments" ADD COLUMN "quote_id" TEXT;
ALTER TABLE "payments" ADD COLUMN "order_id" TEXT;
ALTER TABLE "payments" ADD COLUMN "base_amount" DECIMAL(65,30);
ALTER TABLE "payments" ADD COLUMN "tax_amount" DECIMAL(65,30);
ALTER TABLE "payments" ADD COLUMN "processing_fee" DECIMAL(65,30);
ALTER TABLE "payments" ADD COLUMN "payment_type" "PaymentType";

-- AlterTable: Quote - add payment fields
ALTER TABLE "quotes" ADD COLUMN "payment_required" BOOLEAN;
ALTER TABLE "quotes" ADD COLUMN "payment_required_reason" TEXT;

-- AlterTable: Client - add quickbooks customer id
ALTER TABLE "clients" ADD COLUMN "quickbooks_customer_id" TEXT;

-- CreateTable: QuickBooksToken
CREATE TABLE "quickbooks_tokens" (
    "id" TEXT NOT NULL,
    "realm_id" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "access_token_expires_at" TIMESTAMP(3) NOT NULL,
    "refresh_token_expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quickbooks_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quickbooks_tokens_realm_id_key" ON "quickbooks_tokens"("realm_id");

-- CreateIndex (unique constraint for one-to-one quote-payment)
CREATE UNIQUE INDEX "payments_quote_id_key" ON "payments"("quote_id");

-- AddForeignKey: Payment -> Quote
ALTER TABLE "payments" ADD CONSTRAINT "payments_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: Payment -> Order
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: Invoice - make order_id optional, add quote_id
ALTER TABLE "invoices" ALTER COLUMN "order_id" DROP NOT NULL;
ALTER TABLE "invoices" ADD COLUMN "quote_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "invoices_quote_id_key" ON "invoices"("quote_id");

-- AddForeignKey: Invoice -> Quote
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
