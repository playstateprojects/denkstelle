-- 014: a theme's name and description are rewritten each time it has grown by REWRITE_EVERY statements (worker/src/theme-match.ts).
-- `named_size` is the number of statements the theme had when its wording was last written, so growth = size - named_size.
alter table themes add column if not exists named_size integer;
-- Existing themes were written from their whole membership: they are due after the next REWRITE_EVERY statements, not at once.
update themes t set named_size=(select count(*)::int from statement_themes x where x.theme_id=t.id) where named_size is null;

-- Every rewrite that changed something, so drift in a theme's meaning can be inspected afterwards.
create table if not exists theme_renames (
  id uuid primary key default gen_random_uuid(),
  theme_id uuid not null references themes(id) on delete cascade,
  old_name text not null,
  old_description text,
  new_name text not null,
  new_description text,
  size integer not null,
  judged_by text,
  renamed_at timestamptz not null default now()
);
create index if not exists theme_renames_theme_idx on theme_renames(theme_id,renamed_at desc);
alter table theme_renames enable row level security;
