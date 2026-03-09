-- CreateEnum
CREATE TYPE "LotShape" AS ENUM ('regular_rectangular', 'irregular', 'many_sided', 'curved_boundary');

-- CreateEnum
CREATE TYPE "DrivewayType" AS ENUM ('standard_straight', 'u_shaped_horseshoe', 'long_curved', 'none');

-- CreateEnum
CREATE TYPE "WaterFeatures" AS ENUM ('none', 'pond_within_lot', 'boundary_water');

-- CreateEnum
CREATE TYPE "VegetationDensity" AS ENUM ('minimal', 'moderate', 'dense_obstructive');

-- CreateEnum
CREATE TYPE "SubdivisionStatus" AS ENUM ('recorded_plat', 'metes_and_bounds');

-- AlterEnum
ALTER TYPE "QuoteStatus" ADD VALUE 'quoted';

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "access_issues" TEXT,
ADD COLUMN     "alta_table_a_selections" JSONB,
ADD COLUMN     "driveway_type" "DrivewayType",
ADD COLUMN     "last_completed_step" INTEGER,
ADD COLUMN     "lot_shape" "LotShape",
ADD COLUMN     "lot_size_acres" DECIMAL(10,4),
ADD COLUMN     "preference_form_received_at" TIMESTAMP(3),
ADD COLUMN     "preference_form_sent_at" TIMESTAMP(3),
ADD COLUMN     "rush_fee_amount" DECIMAL(10,2),
ADD COLUMN     "rush_fee_applied" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rush_fee_waived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rush_fee_waived_reason" TEXT,
ADD COLUMN     "structures_on_property" TEXT[],
ADD COLUMN     "structures_other" TEXT,
ADD COLUMN     "subdivision_status" "SubdivisionStatus",
ADD COLUMN     "vegetation_density" "VegetationDensity",
ADD COLUMN     "water_features" "WaterFeatures";

-- CreateTable
CREATE TABLE "quote_activity_entries" (
    "id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "user_id" TEXT,
    "event_type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_activity_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_activity_entries_quote_id_created_at_idx" ON "quote_activity_entries"("quote_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "quote_activity_entries" ADD CONSTRAINT "quote_activity_entries_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_activity_entries" ADD CONSTRAINT "quote_activity_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
