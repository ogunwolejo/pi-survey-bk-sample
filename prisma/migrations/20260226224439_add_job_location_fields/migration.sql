-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "additional_pins" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pin" TEXT,
ADD COLUMN     "property_address_line_1" TEXT,
ADD COLUMN     "property_address_line_2" TEXT,
ADD COLUMN     "property_city" TEXT,
ADD COLUMN     "property_county" "County",
ADD COLUMN     "property_state" TEXT,
ADD COLUMN     "property_zip" TEXT;
