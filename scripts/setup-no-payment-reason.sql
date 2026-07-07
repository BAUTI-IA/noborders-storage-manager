-- "Trip sin payment" alert: why a trip job has no payment yet. Recording a
-- reason acknowledges the alert for that job. The app auto-applies this via
-- the exec_sql RPC; run it here only if that RPC is unavailable. Idempotent.
alter table public.storage_jobs add column if not exists no_payment_reason text;
