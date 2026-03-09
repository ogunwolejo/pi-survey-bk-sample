-- Migrate existing orders with status 'paid' to 'research_queued'
UPDATE "orders" SET "status" = 'research_queued' WHERE "status" = 'paid';

-- Remove 'paid' from OrderStatus enum
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
CREATE TYPE "OrderStatus" AS ENUM ('draft', 'new', 'pending_review', 'pending_contract', 'pending_payment', 'research_queued', 'research_in_progress', 'research_complete', 'ready_for_field');
ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "status" TYPE "OrderStatus" USING ("status"::text::"OrderStatus");
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'draft';
DROP TYPE "OrderStatus_old";

-- Add ResearchDocumentType enum
CREATE TYPE "ResearchDocumentType" AS ENUM ('plat_of_subdivision', 'sidwell_map', 'title_commitment', 'recorded_deed', 'legal_description', 'certificate_of_correction', 'order_form', 'other');

-- Add research_doc_type column to document_metadata
ALTER TABLE "document_metadata" ADD COLUMN "research_doc_type" "ResearchDocumentType";

-- Create order_research_fields table
CREATE TABLE "order_research_fields" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "field_name" TEXT NOT NULL,
    "field_value" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_research_fields_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_research_fields_order_id_idx" ON "order_research_fields"("order_id");
CREATE UNIQUE INDEX "order_research_fields_order_id_field_name_key" ON "order_research_fields"("order_id", "field_name");

ALTER TABLE "order_research_fields" ADD CONSTRAINT "order_research_fields_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_research_fields" ADD CONSTRAINT "order_research_fields_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
