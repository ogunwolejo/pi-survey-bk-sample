-- CreateEnum
CREATE TYPE "ChatEntityType" AS ENUM ('quote', 'order', 'job');

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "entity_type" "ChatEntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "author_id" TEXT,
    "content" VARCHAR(5000) NOT NULL,
    "mentioned_user_ids" TEXT[],
    "is_system_event" BOOLEAN NOT NULL DEFAULT false,
    "event_type" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_messages_entity_type_entity_id_created_at_idx" ON "chat_messages"("entity_type", "entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "chat_messages_author_id_idx" ON "chat_messages"("author_id");

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
