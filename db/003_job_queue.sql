-- Job queue support. Postgres stays the source of truth; the Cloudflare Queue is only a wake-up signal.
-- Idempotent: scripts/migrate.ts re-applies every file in db/ on each run.
alter table processing_jobs add column if not exists highlight_id uuid references highlights(id) on delete cascade;
alter table processing_jobs add column if not exists max_attempts integer not null default 3;
alter table processing_jobs add column if not exists run_after timestamptz not null default now();

-- Claiming and the cron sweep both filter on (status, run_after).
create index if not exists jobs_due_idx on processing_jobs(status,run_after);

-- Approving a highlight twice must not render it twice.
create unique index if not exists jobs_one_active_render on processing_jobs(highlight_id)
  where kind='render_highlight' and status in ('queued','running');
