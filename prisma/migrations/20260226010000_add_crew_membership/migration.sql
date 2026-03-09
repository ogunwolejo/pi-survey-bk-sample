-- AlterTable: add crew_number as nullable first for backfill
ALTER TABLE "crews" ADD COLUMN "crew_number" INTEGER;

-- Backfill existing crews: extract numeric suffix from name (e.g., "Crew 1" -> 1)
UPDATE "crews"
SET "crew_number" = CAST(REGEXP_REPLACE("name", '^.*?(\d+)$', '\1') AS INTEGER)
WHERE "name" ~ '\d+$';

-- For any crews without a numeric suffix, assign sequential numbers starting after max
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "created_at") + COALESCE((SELECT MAX("crew_number") FROM "crews" WHERE "crew_number" IS NOT NULL), 0) AS rn
  FROM "crews"
  WHERE "crew_number" IS NULL
)
UPDATE "crews" SET "crew_number" = numbered.rn FROM numbered WHERE "crews".id = numbered.id;

-- Now make crew_number NOT NULL
ALTER TABLE "crews" ALTER COLUMN "crew_number" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "crews_crew_number_key" ON "crews"("crew_number");

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN "crew_id" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN "crew_id" TEXT;

-- CreateIndex
CREATE INDEX "users_crew_id_idx" ON "users"("crew_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_crew_id_fkey" FOREIGN KEY ("crew_id") REFERENCES "crews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_crew_id_fkey" FOREIGN KEY ("crew_id") REFERENCES "crews"("id") ON DELETE SET NULL ON UPDATE CASCADE;
