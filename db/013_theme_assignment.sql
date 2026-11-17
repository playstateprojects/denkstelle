-- 013: themes are built one statement at a time. Jev judges whether a statement belongs to each of its nearest themes;
-- code decides (worker/src/theme-match.ts). A statement that fits none starts a new theme; an unclear one waits as pending.
-- Replaces the project-wide theme pass as the way themes are made. `npm run themes:rebuild` still works and marks statements 'assigned'.

-- null = not looked at yet; 'assigned' = in at least one theme; 'pending' = Jev could not settle it, retried on the next run.
alter table statements add column if not exists theme_status text check (theme_status in ('assigned','pending'));
update statements s set theme_status='assigned' where theme_status is null and exists (select 1 from statement_themes x where x.statement_id=s.id);

-- How a statement came to be in a theme. `probability` is Jev's P(belongs); null where there is none (rebuild, name_match).
alter table statement_themes add column if not exists probability real;
alter table statement_themes add column if not exists method text not null default 'rebuild' check (method in ('rebuild','jev','seed','name_match'));
alter table statement_themes add column if not exists judged_by text;

-- Every judgement Jev made, including the "no" ones, so thresholds can change and be re-scored without new calls.
create table if not exists theme_judgements (
  statement_id uuid not null references statements(id) on delete cascade,
  theme_id uuid not null references themes(id) on delete cascade,
  probability real not null check (probability between 0 and 1),
  judged_by text not null,
  judged_at timestamptz not null default now(),
  primary key(statement_id,theme_id)
);
create index if not exists theme_judgements_theme_idx on theme_judgements(theme_id);
alter table theme_judgements enable row level security;
