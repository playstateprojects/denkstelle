-- Theme reels: an AI-composed highlight reel across ALL interviews in a project.
-- compose_reel picks the top themes, finds snippets that carry each one, rates them and arranges a plan;
-- render_reel cuts the included snippets together. Separate from per-interview `highlights`.
-- Idempotent: scripts/migrate.ts applies each file once, but every statement is safe to re-run.
create table if not exists reels (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  status text not null default 'queued' check(status in ('queued','composing','composed','rendering','rendered','failed')),
  params jsonb not null default '{}'::jsonb,   -- target_ms, themes, model: what this run was asked to do
  summary text,                                -- the arranger's one-paragraph rationale for the arc
  trace jsonb,                                 -- per-step timings and counts, for experimenting
  error text,
  media_key text,
  created_at timestamptz not null default now()
);
create index if not exists reels_project_idx on reels(project_id,created_at desc);

create table if not exists reel_clips (
  id uuid primary key default gen_random_uuid(),
  reel_id uuid not null references reels(id) on delete cascade,
  position integer not null,
  source_id uuid not null references sources(id) on delete cascade,
  theme_id uuid references themes(id) on delete set null,
  theme_name text not null,
  start_ms integer not null,
  end_ms integer not null,
  text text not null,
  score numeric(4,2) not null default 0,       -- weighted 0-5
  ratings jsonb not null default '{}'::jsonb,  -- per criterion 1-5
  rationale text,
  included boolean not null default true,
  check(end_ms>start_ms)
);
create index if not exists reel_clips_reel_idx on reel_clips(reel_id,position);

-- Reel jobs belong to a reel, not a source.
alter table processing_jobs alter column source_id drop not null;
alter table processing_jobs add column if not exists reel_id uuid references reels(id) on delete cascade;
alter table processing_jobs drop constraint if exists processing_jobs_kind_check;
alter table processing_jobs add constraint processing_jobs_kind_check
  check(kind in ('transcribe_and_ingest','render_highlight','compose_reel','render_reel'));
create unique index if not exists jobs_one_active_reel on processing_jobs(reel_id,kind)
  where kind in ('compose_reel','render_reel') and status in ('queued','running');

alter table reels enable row level security;
alter table reel_clips enable row level security;
