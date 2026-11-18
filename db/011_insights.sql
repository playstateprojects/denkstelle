-- 011: Insights are derived from the content of ONE theme and cite the statements they rest on.
-- Chain back to the recording: insight -> insight_evidence -> statement -> statement_evidence -> source_segment -> source.
-- Replaces the pairwise-relation experiment (former 008, snapshot in git tag archive/pairwise-insight-experiment).
-- Nothing ever wrote to the dropped tables or columns, so no data is lost.
drop table if exists insight_edges, relationship_assessments, insight_evidence, insights cascade;
drop table if exists graph_edges;
drop index if exists statements_project_id_uq;
alter table sources drop column if exists embedding;
alter table statements drop column if exists review_status;

-- Insights are re-derived, not edited: they go with their theme, and a theme whose statements changed gets new ones.
create table insights (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  theme_id uuid not null references themes(id) on delete cascade,
  title text not null,
  description text not null default '',
  model_version text,
  created_at timestamptz not null default now()
);
create index insights_theme_idx on insights(theme_id);
create index insights_project_idx on insights(project_id);

create table insight_evidence (
  insight_id uuid not null references insights(id) on delete cascade,
  statement_id uuid not null references statements(id) on delete cascade,
  primary key(insight_id,statement_id)
);
create index insight_evidence_statement_idx on insight_evidence(statement_id);

-- What the theme's current insights were derived from (model, prompt version, statement set).
-- The insight pass skips a theme whose basis is unchanged.
alter table themes add column if not exists insight_basis text;

alter table insights enable row level security;
alter table insight_evidence enable row level security;
