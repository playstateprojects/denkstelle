-- Which kind of recording a project accepts: 'video', 'audio', or 'either' (contributor chooses).
-- Existing projects keep today's behaviour (video). Idempotent: scripts/migrate.ts re-applies every file in db/.
alter table projects add column if not exists capture_mode text not null default 'video';
do $$ begin
  if not exists (select 1 from pg_constraint where conname='projects_capture_mode_check') then
    alter table projects add constraint projects_capture_mode_check check(capture_mode in ('video','audio','either'));
  end if;
end $$;
