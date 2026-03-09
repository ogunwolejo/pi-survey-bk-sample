-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "closing_date" DATE,
ADD COLUMN     "delivery_preference" "DeliveryPreference",
ADD COLUMN     "legal_description" TEXT,
ADD COLUMN     "locked_gates" "LockedGates",
ADD COLUMN     "onsite_contact_first_name" TEXT,
ADD COLUMN     "onsite_contact_last_name" TEXT,
ADD COLUMN     "onsite_contact_phone" TEXT,
ADD COLUMN     "property_type" "PropertyType";
