-- Payment allocation: link a payment line to the specific job extra it pays.
-- Paste into the Supabase SQL editor and run (idempotent). Normally not needed:
-- the app adds this column automatically at load when exec_sql is available.
alter table public.payments add column if not exists job_extra_id bigint;
