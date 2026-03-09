-- Make quote price nullable so it is only set when staff explicitly prices the quote.
-- The base_price_at_creation field continues to hold the county-based reference price.

ALTER TABLE "quotes" ALTER COLUMN "price" DROP NOT NULL;

-- Clear the price on existing quotes that were auto-set to 0 (not manually priced).
UPDATE "quotes" SET "price" = NULL WHERE "price" = 0;
