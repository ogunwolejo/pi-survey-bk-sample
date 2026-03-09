-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderStatus" ADD VALUE 'new';
ALTER TYPE "OrderStatus" ADD VALUE 'pending_review';

-- DropForeignKey
ALTER TABLE "orders" DROP CONSTRAINT "orders_client_id_fkey";

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "billing_address_line_1" TEXT,
ADD COLUMN     "billing_address_line_2" TEXT,
ADD COLUMN     "billing_address_same_as_service" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "billing_city" TEXT,
ADD COLUMN     "billing_state" TEXT,
ADD COLUMN     "billing_zip" TEXT,
ADD COLUMN     "company" TEXT,
ADD COLUMN     "customer_type" "QuoteCustomerType",
ADD COLUMN     "email" TEXT,
ADD COLUMN     "first_name" TEXT,
ADD COLUMN     "last_completed_step" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_name" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "requested_date" DATE,
ALTER COLUMN "client_id" DROP NOT NULL,
ALTER COLUMN "property_address_line_1" DROP NOT NULL,
ALTER COLUMN "property_city" DROP NOT NULL,
ALTER COLUMN "property_state" DROP NOT NULL,
ALTER COLUMN "property_zip" DROP NOT NULL,
ALTER COLUMN "pin" DROP NOT NULL,
ALTER COLUMN "survey_type" DROP NOT NULL,
ALTER COLUMN "price" DROP NOT NULL,
ALTER COLUMN "payment_terms" DROP NOT NULL,
ALTER COLUMN "drop_dead_date" DROP NOT NULL,
ALTER COLUMN "internal_closing_date" DROP NOT NULL,
ALTER COLUMN "due_date" DROP NOT NULL,
ALTER COLUMN "source" DROP NOT NULL,
ALTER COLUMN "team" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
