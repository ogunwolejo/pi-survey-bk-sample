-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "access_issues" TEXT,
ADD COLUMN     "base_price_at_creation" DECIMAL(65,30),
ADD COLUMN     "driveway_type" "DrivewayType",
ADD COLUMN     "lot_shape" "LotShape",
ADD COLUMN     "lot_size_acres" DECIMAL(10,4),
ADD COLUMN     "price_breakdown" JSONB,
ADD COLUMN     "price_override_reason" TEXT,
ADD COLUMN     "rush_fee_amount" DECIMAL(10,2),
ADD COLUMN     "structures_on_property" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "structures_other" TEXT,
ADD COLUMN     "subdivision_status" "SubdivisionStatus",
ADD COLUMN     "vegetation_density" "VegetationDensity",
ADD COLUMN     "water_features" "WaterFeatures";
