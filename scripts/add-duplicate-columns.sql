-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- Project: njqavagyuwdmkeyoscbz
-- Required for Lowe's lead duplicate detection feature

ALTER TABLE lowes_leads_cache ADD COLUMN IF NOT EXISTS duplicate_sf_id text;
ALTER TABLE lowes_leads_cache ADD COLUMN IF NOT EXISTS duplicate_type text;

-- Verify
SELECT column_name, data_type FROM information_schema.columns 
WHERE table_name = 'lowes_leads_cache' 
AND column_name IN ('duplicate_sf_id', 'duplicate_type');
