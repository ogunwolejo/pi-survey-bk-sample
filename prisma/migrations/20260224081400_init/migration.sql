-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('new', 'pending_review', 'sent', 'accepted', 'declined', 'expired');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('draft', 'pending_contract', 'pending_payment', 'paid', 'research_in_progress', 'research_complete', 'ready_for_field');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('unassigned', 'assigned', 'in_progress', 'field_complete', 'drafting', 'pls_review', 'complete');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'sent', 'paid', 'partial', 'overdue', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "SurveyType" AS ENUM ('boundary', 'alta', 'condominium', 'topography', 'other');

-- CreateEnum
CREATE TYPE "PaymentTerms" AS ENUM ('pre_pay', 'fifty_fifty', 'full_with_discount', 'post_closing');

-- CreateEnum
CREATE TYPE "ClientPaymentTerms" AS ENUM ('pre_pay', 'post_closing', 'net_30', 'net_60');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "Team" AS ENUM ('residential', 'public');

-- CreateEnum
CREATE TYPE "UserTeam" AS ENUM ('residential', 'public', 'both');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('super_admin', 'admin', 'office_manager', 'crew_manager', 'pls_reviewer', 'field_crew', 'drafter', 'shipping_admin');

-- CreateEnum
CREATE TYPE "PlatformAccess" AS ENUM ('web', 'mobile', 'both');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('homeowner', 'attorney', 'title_company', 'other');

-- CreateEnum
CREATE TYPE "ClientSource" AS ENUM ('order_form', 'quote_form', 'internal', 'imported');

-- CreateEnum
CREATE TYPE "QuoteSource" AS ENUM ('website', 'internal');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('website', 'internal', 'quote_acceptance');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('standard', 'public_municipal');

-- CreateEnum
CREATE TYPE "PropertyType" AS ENUM ('sfr', 'sfr_townhome', 'apartment', 'commercial', 'vacant_land', 'farm', 'other');

-- CreateEnum
CREATE TYPE "DeliveryPreference" AS ENUM ('pdf_only', 'pdf_usps', 'pdf_fedex');

-- CreateEnum
CREATE TYPE "LockedGates" AS ENUM ('yes', 'no', 'na');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('credit_card', 'ach', 'check', 'cash', 'other');

-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('quickbooks_payments', 'manual');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('pending', 'synced', 'failed');

-- CreateEnum
CREATE TYPE "FormType" AS ENUM ('quote_request', 'direct_order', 'quote_acceptance');

-- CreateEnum
CREATE TYPE "Carrier" AS ENUM ('usps', 'fedex');

-- CreateEnum
CREATE TYPE "ShippingTaskStatus" AS ENUM ('pending', 'ready_to_ship', 'shipped');

-- CreateEnum
CREATE TYPE "DeliveryChecklistStatus" AS ENUM ('not_started', 'in_progress', 'complete');

-- CreateEnum
CREATE TYPE "DeliveryTrackingStatus" AS ENUM ('preparing', 'email_sent', 'shipping_label_printed', 'shipped', 'delivered');

-- CreateEnum
CREATE TYPE "DeliveryLocation" AS ENUM ('property', 'office');

-- CreateEnum
CREATE TYPE "StakingRequestStatus" AS ENUM ('pending', 'in_progress', 'completed', 'timed_out');

-- CreateEnum
CREATE TYPE "CompanyType" AS ENUM ('law_firm', 'title_company', 'other');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('created', 'updated', 'deleted', 'restored');

-- CreateEnum
CREATE TYPE "AuditSource" AS ENUM ('web_portal', 'mobile_app', 'api', 'system');

-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('token_link', 'magic_link');

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "quote_number" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'new',
    "client_id" TEXT NOT NULL,
    "billing_client_id" TEXT,
    "property_address_line_1" TEXT NOT NULL,
    "property_address_line_2" TEXT,
    "property_city" TEXT NOT NULL,
    "property_state" TEXT NOT NULL,
    "property_zip" TEXT NOT NULL,
    "property_county" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "additional_pins" TEXT[],
    "survey_type" "SurveyType" NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "base_price_at_creation" DECIMAL(65,30) NOT NULL,
    "price_override_reason" TEXT,
    "estimated_timeframe" TEXT,
    "payment_terms" "PaymentTerms",
    "expiry_date" DATE NOT NULL,
    "source" "QuoteSource" NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'normal',
    "assigned_to" TEXT,
    "internal_notes" TEXT,
    "referral_source" TEXT,
    "team" "Team" NOT NULL DEFAULT 'residential',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_signatures" (
    "id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "signer_name" TEXT NOT NULL,
    "signer_email" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "signed_at" TIMESTAMP(3) NOT NULL,
    "ip_address" INET,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abandoned_forms" (
    "id" TEXT NOT NULL,
    "form_type" "FormType" NOT NULL,
    "email" TEXT NOT NULL,
    "partial_data" JSONB NOT NULL,
    "quote_id" TEXT,
    "abandoned_at" TIMESTAMP(3) NOT NULL,
    "recovered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "abandoned_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "quote_id" TEXT,
    "client_id" TEXT NOT NULL,
    "billing_client_id" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'draft',
    "order_type" "OrderType" NOT NULL DEFAULT 'standard',
    "property_address_line_1" TEXT NOT NULL,
    "property_address_line_2" TEXT,
    "property_city" TEXT NOT NULL,
    "property_state" TEXT NOT NULL,
    "property_zip" TEXT NOT NULL,
    "property_county" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "additional_pins" TEXT[],
    "property_type" "PropertyType",
    "survey_type" "SurveyType" NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "payment_terms" "PaymentTerms" NOT NULL,
    "closing_date" DATE,
    "onsite_contact_first_name" TEXT,
    "onsite_contact_last_name" TEXT,
    "onsite_contact_phone" TEXT,
    "locked_gates" "LockedGates",
    "delivery_preference" "DeliveryPreference",
    "legal_description" TEXT,
    "title_commitment_s3_key" TEXT,
    "drop_dead_date" DATE NOT NULL,
    "internal_closing_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "is_rush" BOOLEAN NOT NULL DEFAULT false,
    "rush_fee_waived" BOOLEAN NOT NULL DEFAULT false,
    "rush_fee_waived_reason" TEXT,
    "source" "OrderSource" NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'normal',
    "team" "Team" NOT NULL,
    "suppress_client_emails" BOOLEAN NOT NULL DEFAULT false,
    "internal_notes" TEXT,
    "referral_source" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "job_number" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'unassigned',
    "assigned_crew_id" TEXT,
    "field_date" DATE,
    "staking_required" BOOLEAN NOT NULL DEFAULT false,
    "team" "Team" NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "invoice_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "subtotal" DECIMAL(65,30) NOT NULL,
    "tax_rate" DECIMAL(65,30) NOT NULL,
    "tax_amount" DECIMAL(65,30) NOT NULL,
    "discount_amount" DECIMAL(65,30) NOT NULL,
    "credit_applied" DECIMAL(65,30) NOT NULL,
    "total_amount" DECIMAL(65,30) NOT NULL,
    "amount_paid" DECIMAL(65,30) NOT NULL,
    "balance_due" DECIMAL(65,30) NOT NULL,
    "tax_exempt" BOOLEAN NOT NULL DEFAULT false,
    "tax_exempt_certificate" TEXT,
    "notes" TEXT,
    "quickbooks_invoice_id" TEXT,
    "sync_status" "SyncStatus" NOT NULL DEFAULT 'pending',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(65,30) NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "payment_date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "payment_method" "PaymentMethod" NOT NULL,
    "card_brand" TEXT,
    "card_last_four" TEXT,
    "transaction_id" TEXT,
    "credit_card_fee" DECIMAL(65,30),
    "payment_source" "PaymentSource" NOT NULL,
    "recorded_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credits" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "invoice_id" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "reason" TEXT NOT NULL,
    "approved_by" TEXT NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_2" TEXT,
    "phone" TEXT NOT NULL,
    "address_line_1" TEXT,
    "address_line_2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip_code" TEXT,
    "customer_type" "CustomerType" NOT NULL,
    "payment_terms" "ClientPaymentTerms",
    "preferred_payment_method" TEXT,
    "vip" BOOLEAN NOT NULL DEFAULT false,
    "credit_limit" DECIMAL(65,30),
    "communication_preferences" JSONB,
    "operational_notes" TEXT,
    "source" "ClientSource" NOT NULL,
    "total_orders" INTEGER NOT NULL DEFAULT 0,
    "last_order_date" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_delivery_preferences" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "delivery_method" "DeliveryPreference" NOT NULL,
    "mailing_address_line_1" TEXT,
    "mailing_address_line_2" TEXT,
    "mailing_city" TEXT,
    "mailing_state" TEXT,
    "mailing_zip" TEXT,
    "email_recipients" TEXT[],
    "cc_recipients" TEXT[],
    "charge_for_shipping" BOOLEAN NOT NULL DEFAULT false,
    "include_physical_invoice" BOOLEAN NOT NULL DEFAULT false,
    "delivery_location" "DeliveryLocation",
    "special_instructions" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_delivery_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address_line_1" TEXT,
    "address_line_2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip_code" TEXT,
    "type" "CompanyType" NOT NULL,
    "billing_email" TEXT,
    "default_payment_terms" "ClientPaymentTerms",
    "is_ort" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_contacts" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "company_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "role" "UserRole" NOT NULL,
    "platform_access" "PlatformAccess" NOT NULL,
    "team" "UserTeam" NOT NULL DEFAULT 'residential',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notification_preferences" JSONB,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "platform_access" "PlatformAccess" NOT NULL,
    "team" "UserTeam" NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crews" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "starting_location_lat" DECIMAL(10,7),
    "starting_location_lng" DECIMAL(10,7),
    "capability_tags" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "current_lat" DECIMAL(10,7),
    "current_lng" DECIMAL(10,7),
    "gps_updated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_tasks" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "status" "ShippingTaskStatus" NOT NULL DEFAULT 'pending',
    "carrier" "Carrier" NOT NULL,
    "mailing_address_line_1" TEXT NOT NULL,
    "mailing_address_line_2" TEXT,
    "mailing_city" TEXT NOT NULL,
    "mailing_state" TEXT NOT NULL,
    "mailing_zip" TEXT NOT NULL,
    "recipient_name" TEXT NOT NULL,
    "charge_for_shipping" BOOLEAN NOT NULL DEFAULT false,
    "include_physical_invoice" BOOLEAN NOT NULL DEFAULT false,
    "tracking_number" TEXT,
    "shipped_at" TIMESTAMP(3),
    "shipped_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_checklists" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "delivery_method" "DeliveryPreference" NOT NULL,
    "status" "DeliveryChecklistStatus" NOT NULL DEFAULT 'not_started',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "completed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_checklist_items" (
    "id" TEXT NOT NULL,
    "checklist_id" TEXT NOT NULL,
    "step_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "is_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_by" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "delivery_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_tracking" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "tracking_token" TEXT NOT NULL,
    "delivery_method" "DeliveryPreference" NOT NULL,
    "status" "DeliveryTrackingStatus" NOT NULL DEFAULT 'preparing',
    "email_sent_at" TIMESTAMP(3),
    "email_opened_at" TIMESTAMP(3),
    "carrier" "Carrier",
    "tracking_number" TEXT,
    "carrier_url" TEXT,
    "shipped_at" TIMESTAMP(3),
    "estimated_delivery" DATE,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_tracking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_tracking_events" (
    "id" TEXT NOT NULL,
    "tracking_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_tracking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_audit_log" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "entity_number" TEXT,
    "action" "AuditAction" NOT NULL,
    "user_id" TEXT,
    "user_name" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL,
    "changes" JSONB NOT NULL,
    "change_summary" TEXT NOT NULL,
    "ip_address" INET,
    "user_agent" TEXT,
    "source" "AuditSource" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_feed" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "user_id" TEXT,
    "event_type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_feed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_portal_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_accessed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "client_portal_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_portal_sessions" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "session_token" TEXT NOT NULL,
    "auth_method" "AuthMethod" NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_portal_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "magic_link_requests" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "client_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "magic_link_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staking_requests" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "status" "StakingRequestStatus" NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMP(3) NOT NULL,
    "responded_at" TIMESTAMP(3),
    "responded_by" TEXT,
    "timeout_at" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,

    CONSTRAINT "staking_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_metadata" (
    "id" TEXT NOT NULL,
    "job_id" TEXT,
    "order_id" TEXT,
    "document_type" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "file_size" BIGINT NOT NULL,
    "version_number" INTEGER NOT NULL DEFAULT 1,
    "uploaded_by" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotes_quote_number_key" ON "quotes"("quote_number");

-- CreateIndex
CREATE INDEX "quotes_client_id_idx" ON "quotes"("client_id");

-- CreateIndex
CREATE INDEX "quotes_status_idx" ON "quotes"("status");

-- CreateIndex
CREATE INDEX "quotes_assigned_to_idx" ON "quotes"("assigned_to");

-- CreateIndex
CREATE INDEX "quotes_team_status_idx" ON "quotes"("team", "status");

-- CreateIndex
CREATE UNIQUE INDEX "quote_tokens_token_key" ON "quote_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "orders_quote_id_key" ON "orders"("quote_id");

-- CreateIndex
CREATE INDEX "orders_client_id_idx" ON "orders"("client_id");

-- CreateIndex
CREATE INDEX "orders_quote_id_idx" ON "orders"("quote_id");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_team_status_idx" ON "orders"("team", "status");

-- CreateIndex
CREATE INDEX "orders_due_date_idx" ON "orders"("due_date");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_job_number_key" ON "jobs"("job_number");

-- CreateIndex
CREATE INDEX "jobs_order_id_idx" ON "jobs"("order_id");

-- CreateIndex
CREATE INDEX "jobs_assigned_crew_id_idx" ON "jobs"("assigned_crew_id");

-- CreateIndex
CREATE INDEX "jobs_field_date_idx" ON "jobs"("field_date");

-- CreateIndex
CREATE INDEX "jobs_status_team_idx" ON "jobs"("status", "team");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_number_key" ON "invoices"("invoice_number");

-- CreateIndex
CREATE INDEX "invoices_order_id_idx" ON "invoices"("order_id");

-- CreateIndex
CREATE INDEX "invoices_client_id_idx" ON "invoices"("client_id");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE INDEX "invoices_sync_status_idx" ON "invoices"("sync_status");

-- CreateIndex
CREATE UNIQUE INDEX "clients_email_key" ON "clients"("email");

-- CreateIndex
CREATE UNIQUE INDEX "client_delivery_preferences_client_id_key" ON "client_delivery_preferences"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_contacts_company_id_client_id_key" ON "company_contacts"("company_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_key" ON "invitations"("token");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_checklists_order_id_key" ON "delivery_checklists"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_checklists_job_id_key" ON "delivery_checklists"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_checklist_items_checklist_id_step_key_key" ON "delivery_checklist_items"("checklist_id", "step_key");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_tracking_order_id_key" ON "delivery_tracking"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_tracking_job_id_key" ON "delivery_tracking"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_tracking_tracking_token_key" ON "delivery_tracking"("tracking_token");

-- CreateIndex
CREATE INDEX "delivery_tracking_events_tracking_id_occurred_at_idx" ON "delivery_tracking_events"("tracking_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "holidays_date_key" ON "holidays"("date");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- CreateIndex
CREATE INDEX "entity_audit_log_entity_type_entity_id_idx" ON "entity_audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "entity_audit_log_user_id_idx" ON "entity_audit_log"("user_id");

-- CreateIndex
CREATE INDEX "entity_audit_log_changed_at_idx" ON "entity_audit_log"("changed_at" DESC);

-- CreateIndex
CREATE INDEX "entity_audit_log_entity_number_idx" ON "entity_audit_log"("entity_number");

-- CreateIndex
CREATE INDEX "activity_feed_job_id_created_at_idx" ON "activity_feed"("job_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_is_read_created_at_idx" ON "notifications"("user_id", "is_read", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "client_portal_tokens_token_key" ON "client_portal_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "client_portal_sessions_session_token_key" ON "client_portal_sessions"("session_token");

-- CreateIndex
CREATE UNIQUE INDEX "magic_link_requests_token_key" ON "magic_link_requests"("token");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_billing_client_id_fkey" FOREIGN KEY ("billing_client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_tokens" ADD CONSTRAINT "quote_tokens_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_signatures" ADD CONSTRAINT "contract_signatures_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abandoned_forms" ADD CONSTRAINT "abandoned_forms_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_billing_client_id_fkey" FOREIGN KEY ("billing_client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_crew_id_fkey" FOREIGN KEY ("assigned_crew_id") REFERENCES "crews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credits" ADD CONSTRAINT "credits_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credits" ADD CONSTRAINT "credits_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credits" ADD CONSTRAINT "credits_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_delivery_preferences" ADD CONSTRAINT "client_delivery_preferences_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_contacts" ADD CONSTRAINT "company_contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_contacts" ADD CONSTRAINT "company_contacts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_tasks" ADD CONSTRAINT "shipping_tasks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_tasks" ADD CONSTRAINT "shipping_tasks_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_tasks" ADD CONSTRAINT "shipping_tasks_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_tasks" ADD CONSTRAINT "shipping_tasks_shipped_by_fkey" FOREIGN KEY ("shipped_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_checklists" ADD CONSTRAINT "delivery_checklists_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_checklists" ADD CONSTRAINT "delivery_checklists_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_checklists" ADD CONSTRAINT "delivery_checklists_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_checklist_items" ADD CONSTRAINT "delivery_checklist_items_checklist_id_fkey" FOREIGN KEY ("checklist_id") REFERENCES "delivery_checklists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_checklist_items" ADD CONSTRAINT "delivery_checklist_items_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_tracking" ADD CONSTRAINT "delivery_tracking_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_tracking" ADD CONSTRAINT "delivery_tracking_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_tracking_events" ADD CONSTRAINT "delivery_tracking_events_tracking_id_fkey" FOREIGN KEY ("tracking_id") REFERENCES "delivery_tracking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_audit_log" ADD CONSTRAINT "entity_audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_feed" ADD CONSTRAINT "activity_feed_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_feed" ADD CONSTRAINT "activity_feed_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_tokens" ADD CONSTRAINT "client_portal_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_sessions" ADD CONSTRAINT "client_portal_sessions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "magic_link_requests" ADD CONSTRAINT "magic_link_requests_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staking_requests" ADD CONSTRAINT "staking_requests_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staking_requests" ADD CONSTRAINT "staking_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staking_requests" ADD CONSTRAINT "staking_requests_responded_by_fkey" FOREIGN KEY ("responded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_metadata" ADD CONSTRAINT "document_metadata_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_metadata" ADD CONSTRAINT "document_metadata_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_metadata" ADD CONSTRAINT "document_metadata_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
