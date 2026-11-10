-- Admin access, versioned per-model prompts, and the pipeline's chosen model. Edited at /admin/prompts.
-- Idempotent: scripts/migrate.ts applies each file once, but every statement is safe to re-run.

-- Admins are users flagged in the database (grant with `npm run admin:grant -- you@example.com`).
-- This is separate from ADMIN_EMAILS, which only decides who may request a login link.
alter table "user" add column if not exists is_admin boolean not null default false;

-- Every edit is a new row (model, key, version); at most one version per (model, key) is active.
-- A (model, key) with no active row runs the default built into worker/src/prompts.ts, so
-- "back to default" is just deactivating.
create table if not exists prompts (
  id uuid primary key default gen_random_uuid(),
  model text not null,
  key text not null,
  version integer not null,
  body text not null,
  notes text,
  active boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  unique (model, key, version)
);
create unique index if not exists prompts_one_active_per_model_key on prompts (model, key) where active;

-- Small key/value settings. `active_model` is the model the ingest pipeline uses.
create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table prompts enable row level security;
alter table app_settings enable row level security;
