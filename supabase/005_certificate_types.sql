-- 005: more certificate types for the X-Department certificate builder.
-- Run once in the Supabase SQL editor. Each ADD VALUE is idempotent.
alter type certificate_type add value if not exists 'phase1_pass';
alter type certificate_type add value if not exists 'phase2_pass';
alter type certificate_type add value if not exists 'funded';
alter type certificate_type add value if not exists 'achievement';
alter type certificate_type add value if not exists 'custom';
