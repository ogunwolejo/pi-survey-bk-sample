-- CreateEnum
CREATE TYPE "OrderTokenType" AS ENUM ('legacy', 'proposal');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "payment_required" BOOLEAN,
ADD COLUMN     "payment_required_reason" TEXT;

-- CreateTable
CREATE TABLE "order_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "token_type" "OrderTokenType" NOT NULL DEFAULT 'proposal',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_contract_signatures" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "signer_name" TEXT NOT NULL,
    "signer_email" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "signature_data" JSONB,
    "signed_at" TIMESTAMP(3) NOT NULL,
    "ip_address" INET,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_contract_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_tokens_token_key" ON "order_tokens"("token");

-- CreateIndex
CREATE INDEX "order_tokens_order_id_idx" ON "order_tokens"("order_id");

-- CreateIndex
CREATE INDEX "order_contract_signatures_order_id_idx" ON "order_contract_signatures"("order_id");

-- AddForeignKey
ALTER TABLE "order_tokens" ADD CONSTRAINT "order_tokens_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_contract_signatures" ADD CONSTRAINT "order_contract_signatures_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
