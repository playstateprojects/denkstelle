-- 016: themes are made topic first (worker/src/topic-match.ts). A statement is given 1 to 3 atomic topics, each matched to a theme by
-- exact name or embedding; a topic nothing matches starts a theme. statement_themes.probability stays the weight of the edge
-- (Jev's P(the statement is about the theme)); how an edge came about gains two values:
--   exact = the topic's name equals the theme's and Jev agreed, embed = found by label embedding and Jev agreed.
-- (name_match now also covers an exact name that Jev scored below the link threshold; seed = the topic started the theme.)
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid='statement_themes'::regclass and contype='c' and pg_get_constraintdef(oid) like '%method%' loop
    execute format('alter table statement_themes drop constraint %I',c);
  end loop;
end $$;
alter table statement_themes add constraint statement_themes_method_check check (method in ('rebuild','jev','seed','name_match','exact','embed'));
