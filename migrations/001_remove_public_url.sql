-- Migration: Remove public_url column from assets table
-- Date: January 10, 2026
-- Reason: Raw assets are not served directly to users, only processed data from Supabase is shown

-- Remove public_url column from assets table
ALTER TABLE assets DROP COLUMN IF EXISTS public_url;

-- Add comment explaining the removal
COMMENT ON TABLE assets IS 'Stores metadata for files in R2. Raw files are not publicly accessible - only processed data is served to users via API.';
