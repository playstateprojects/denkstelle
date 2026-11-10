-- Per-clip sharing decisions made by the contributor on /manage.
-- A row is an explicit decision for that clip; no row means "inherit the recording-level permission".
-- Idempotent: scripts/migrate.ts re-applies every file in db/ on each run.
create table if not exists highlight_permissions (
  highlight_id uuid not null references highlights(id) on delete cascade,
  purpose text not null check(purpose in ('public_excerpt','social_media')),
  allowed boolean not null,
  policy_version text not null,
  decided_at timestamptz not null default now(),
  primary key(highlight_id,purpose)
);
alter table highlight_permissions enable row level security;
