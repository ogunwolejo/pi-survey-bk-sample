-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('draft', 'published', 'cancelled', 'completed');

-- CreateEnum
CREATE TYPE "IssueFlagCategory" AS ENUM ('data_issue', 'document_missing', 'boundary_discrepancy', 'other');

-- CreateEnum
CREATE TYPE "IssueFlagSeverity" AS ENUM ('critical', 'informational');

-- CreateEnum
CREATE TYPE "IssueFlagStatus" AS ENUM ('open', 'resolved');

-- CreateEnum
CREATE TYPE "FileCategory" AS ENUM ('field_data', 'field_sketch', 'legal_document', 'cad_draft', 'signed_survey', 'staking_points', 'other');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobStatus" ADD VALUE 'ready_for_drafting';
ALTER TYPE "JobStatus" ADD VALUE 'drafted';
ALTER TYPE "JobStatus" ADD VALUE 'awaiting_corrections';
ALTER TYPE "JobStatus" ADD VALUE 'ready_for_delivery';

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'pls_assistant';

-- AlterTable
ALTER TABLE "document_metadata" ADD COLUMN     "chat_message_id" TEXT,
ADD COLUMN     "file_category" "FileCategory",
ADD COLUMN     "mime_type" TEXT;

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "claimed_at" TIMESTAMP(3),
ADD COLUMN     "claimed_by_id" TEXT,
ADD COLUMN     "complexity_tag" TEXT,
ADD COLUMN     "internal_due_date" DATE,
ADD COLUMN     "is_alta" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "last_status_changed_at" TIMESTAMP(3),
ADD COLUMN     "last_status_changed_by_id" TEXT,
ADD COLUMN     "pls_review_round_trips" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "property_lat" DECIMAL(10,7),
ADD COLUMN     "property_lng" DECIMAL(10,7),
ADD COLUMN     "special_notes" TEXT;

-- CreateTable
CREATE TABLE "routes" (
    "id" TEXT NOT NULL,
    "route_date" DATE NOT NULL,
    "crew_id" TEXT NOT NULL,
    "status" "RouteStatus" NOT NULL DEFAULT 'draft',
    "total_drive_time_minutes" INTEGER,
    "total_distance_meters" INTEGER,
    "directions_polyline" TEXT,
    "published_at" TIMESTAMP(3),
    "published_by_id" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_jobs" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "estimated_arrival" TIMESTAMP(3),
    "estimated_duration_minutes" INTEGER,
    "leg_drive_time_minutes" INTEGER,
    "leg_distance_meters" INTEGER,
    "site_access_email_job_id" TEXT,
    "site_contact_name" TEXT,
    "site_contact_email" TEXT,
    "site_contact_phone" TEXT,

    CONSTRAINT "route_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_chat_messages" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "author_id" TEXT,
    "content" TEXT NOT NULL,
    "mentioned_user_ids" TEXT[],
    "is_system_event" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "job_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_issue_flags" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "category" "IssueFlagCategory" NOT NULL,
    "severity" "IssueFlagSeverity" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "IssueFlagStatus" NOT NULL DEFAULT 'open',
    "raised_by_id" TEXT NOT NULL,
    "raised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution_note" TEXT,

    CONSTRAINT "job_issue_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pls_sign_offs" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "pls_user_id" TEXT NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "pls_sign_offs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "routes_route_date_idx" ON "routes"("route_date");

-- CreateIndex
CREATE INDEX "routes_status_idx" ON "routes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "routes_crew_id_route_date_key" ON "routes"("crew_id", "route_date");

-- CreateIndex
CREATE INDEX "route_jobs_job_id_idx" ON "route_jobs"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "route_jobs_route_id_sort_order_key" ON "route_jobs"("route_id", "sort_order");

-- CreateIndex
CREATE INDEX "job_chat_messages_job_id_created_at_idx" ON "job_chat_messages"("job_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "job_chat_messages_author_id_idx" ON "job_chat_messages"("author_id");

-- CreateIndex
CREATE INDEX "job_issue_flags_job_id_status_idx" ON "job_issue_flags"("job_id", "status");

-- CreateIndex
CREATE INDEX "pls_sign_offs_job_id_idx" ON "pls_sign_offs"("job_id");

-- CreateIndex
CREATE INDEX "jobs_internal_due_date_idx" ON "jobs"("internal_due_date");

-- CreateIndex
CREATE INDEX "jobs_claimed_by_id_idx" ON "jobs"("claimed_by_id");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_claimed_by_id_fkey" FOREIGN KEY ("claimed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_last_status_changed_by_id_fkey" FOREIGN KEY ("last_status_changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_metadata" ADD CONSTRAINT "document_metadata_chat_message_id_fkey" FOREIGN KEY ("chat_message_id") REFERENCES "job_chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_crew_id_fkey" FOREIGN KEY ("crew_id") REFERENCES "crews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_jobs" ADD CONSTRAINT "route_jobs_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_jobs" ADD CONSTRAINT "route_jobs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_chat_messages" ADD CONSTRAINT "job_chat_messages_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_chat_messages" ADD CONSTRAINT "job_chat_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_issue_flags" ADD CONSTRAINT "job_issue_flags_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_issue_flags" ADD CONSTRAINT "job_issue_flags_raised_by_id_fkey" FOREIGN KEY ("raised_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_issue_flags" ADD CONSTRAINT "job_issue_flags_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pls_sign_offs" ADD CONSTRAINT "pls_sign_offs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pls_sign_offs" ADD CONSTRAINT "pls_sign_offs_pls_user_id_fkey" FOREIGN KEY ("pls_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
