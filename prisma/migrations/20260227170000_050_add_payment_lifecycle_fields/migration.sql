-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "failed_at" TIMESTAMP(3),
ADD COLUMN     "failure_reason" TEXT;
