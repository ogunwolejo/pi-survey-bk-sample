-- AlterTable
ALTER TABLE "routes" ADD COLUMN     "notification_job_id" TEXT;

-- CreateIndex
CREATE INDEX "jobs_assigned_crew_id_field_date_idx" ON "jobs"("assigned_crew_id", "field_date");
