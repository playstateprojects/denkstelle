-- 015: themes that cover the same subject are merged (worker/src/theme-merge.ts).
-- The absorbed theme is deleted, so this keeps what it was: its wording, its size, how much it overlapped the survivor, and Jev's
-- probability that the two were the same topic.
create table if not exists theme_merges (
  id uuid primary key default gen_random_uuid(),
  survivor_id uuid not null references themes(id) on delete cascade,
  absorbed_id uuid not null,
  absorbed_name text not null,
  absorbed_description text,
  absorbed_size integer not null,
  survivor_name text not null,
  survivor_size integer not null,
  overlap integer not null,
  probability double precision not null,
  judged_by text,
  merged_at timestamptz not null default now()
);
create index if not exists theme_merges_survivor_idx on theme_merges(survivor_id,merged_at desc);
alter table theme_merges enable row level security;
