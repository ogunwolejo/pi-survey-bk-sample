-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "pin_latitude" DECIMAL(10,7),
ADD COLUMN     "pin_longitude" DECIMAL(10,7);

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "pin_latitude" DECIMAL(10,7),
ADD COLUMN     "pin_longitude" DECIMAL(10,7);
