-- CreateEnum
CREATE TYPE "County" AS ENUM ('cook', 'dupage', 'will', 'kane', 'lake', 'mchenry', 'kendall', 'dekalb', 'kankakee', 'iroquois', 'lasalle', 'grundy');

-- CreateEnum
CREATE TYPE "QuoteCustomerType" AS ENUM ('attorney_law_office', 'individual_homeowner', 'realtor', 'title_company', 'engineering_construction', 'architecture_firm', 'government_municipality', 'other');

-- AlterTable: Add new columns to quotes
ALTER TABLE "quotes" ADD COLUMN "customer_type" "QuoteCustomerType";
ALTER TABLE "quotes" ADD COLUMN "billing_address_same_as_service" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "quotes" ADD COLUMN "billing_address_line_1" TEXT;
ALTER TABLE "quotes" ADD COLUMN "billing_address_line_2" TEXT;
ALTER TABLE "quotes" ADD COLUMN "billing_city" TEXT;
ALTER TABLE "quotes" ADD COLUMN "billing_state" TEXT;
ALTER TABLE "quotes" ADD COLUMN "billing_zip" TEXT;

-- Drop NOT NULL before updating to allow nullification of non-matching values
ALTER TABLE "quotes" ALTER COLUMN "property_county" DROP NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "property_county" DROP NOT NULL;

-- Migrate propertyCounty on quotes: nullify non-matching values
UPDATE "quotes" SET "property_county" = NULL
WHERE LOWER(TRIM("property_county")) NOT IN (
  'cook', 'dupage', 'will', 'kane', 'lake', 'mchenry',
  'kendall', 'dekalb', 'kankakee', 'iroquois', 'lasalle', 'grundy'
);

-- Normalize matching county values to lowercase
UPDATE "quotes" SET "property_county" = LOWER(TRIM("property_county"))
WHERE "property_county" IS NOT NULL;

-- Convert quotes.property_county from TEXT to County enum
ALTER TABLE "quotes" ALTER COLUMN "property_county" TYPE "County" USING "property_county"::"County";

-- Migrate propertyCounty on orders: nullify non-matching values
UPDATE "orders" SET "property_county" = NULL
WHERE LOWER(TRIM("property_county")) NOT IN (
  'cook', 'dupage', 'will', 'kane', 'lake', 'mchenry',
  'kendall', 'dekalb', 'kankakee', 'iroquois', 'lasalle', 'grundy'
);

-- Normalize matching county values to lowercase
UPDATE "orders" SET "property_county" = LOWER(TRIM("property_county"))
WHERE "property_county" IS NOT NULL;

-- Convert orders.property_county from TEXT to County enum
ALTER TABLE "orders" ALTER COLUMN "property_county" TYPE "County" USING "property_county"::"County";

-- CreateIndex
CREATE INDEX "quotes_property_county_idx" ON "quotes"("property_county");
CREATE INDEX "quotes_customer_type_idx" ON "quotes"("customer_type");
