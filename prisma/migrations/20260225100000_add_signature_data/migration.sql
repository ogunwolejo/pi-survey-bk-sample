-- Add signature_data column to store signature metadata (type, text, imageData)
ALTER TABLE "contract_signatures" ADD COLUMN "signature_data" JSONB;
