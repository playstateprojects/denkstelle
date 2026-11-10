create extension if not exists vector;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),name text not null,created_at timestamptz not null default now()
);
create table if not exists organization_members (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id text not null references "user"(id) on delete cascade,
  role text not null check(role in ('owner','admin','editor','viewer')),
  primary key(organization_id,user_id)
);
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),organization_id uuid not null references organizations(id) on delete cascade,
  slug text not null unique,title text not null,question text not null,description text,
  status text not null default 'open' check(status in ('draft','open','closed')),
  created_at timestamptz not null default now()
);
create index if not exists projects_org_idx on projects(organization_id);

-- Universal source registry: V1 creates interview_video, future adapters add PDFs, imported video, etc.
create table if not exists sources (
  id uuid primary key default gen_random_uuid(),project_id uuid not null references projects(id) on delete cascade,
  kind text not null check(kind in ('interview_video','uploaded_video','audio','pdf','document','text','external_url')),
  role text not null check(role in ('contribution','context','editorial')),
  title text not null,contributor_label text,receipt_email text,
  status text not null default 'awaiting_upload' check(status in ('awaiting_upload','uploaded','processing','ready','failed','deleted')),
  media_key text,mime_type text,size_bytes bigint,duration_ms integer,
  receipt_token_hash text,processing_model text,analysis jsonb,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index if not exists sources_project_idx on sources(project_id,created_at desc);

-- These are permissions, not necessarily the complete GDPR lawful-basis analysis.
create table if not exists source_permissions (
  source_id uuid not null references sources(id) on delete cascade,
  purpose text not null check(purpose in ('capture_analysis','public_excerpt','social_media','email_receipt')),
  allowed boolean not null,policy_version text not null,granted_at timestamptz not null default now(),
  withdrawn_at timestamptz,primary key(source_id,purpose)
);

-- Each text passage keeps its own modality-appropriate locator. Null timestamps are fine for PDFs.
create table if not exists source_segments (
  id uuid primary key default gen_random_uuid(),source_id uuid not null references sources(id) on delete cascade,
  sequence integer not null,start_ms integer,end_ms integer,page_number integer,char_start integer,char_end integer,
  text text not null,speaker_label text,embedding vector(1024),created_at timestamptz not null default now(),
  unique(source_id,sequence),check(start_ms is null or end_ms is null or end_ms>=start_ms)
);
create index if not exists source_segments_source_idx on source_segments(source_id);
create index if not exists source_segments_embedding_idx on source_segments using hnsw(embedding vector_cosine_ops);

create table if not exists themes (
  id uuid primary key default gen_random_uuid(),project_id uuid not null references projects(id) on delete cascade,
  canonical text not null,name text not null,description text,embedding vector(1024),
  created_at timestamptz not null default now(),unique(project_id,canonical)
);
create index if not exists themes_embedding_idx on themes using hnsw(embedding vector_cosine_ops);
create table if not exists statements (
  id uuid primary key default gen_random_uuid(),project_id uuid not null references projects(id) on delete cascade,
  source_id uuid not null references sources(id) on delete cascade,
  text text not null,embedding vector(1024),review_status text not null default 'suggested',
  model_version text,created_at timestamptz not null default now()
);
create index if not exists statements_embedding_idx on statements using hnsw(embedding vector_cosine_ops);
create table if not exists statement_evidence (
  statement_id uuid not null references statements(id) on delete cascade,
  segment_id uuid not null references source_segments(id) on delete cascade,
  primary key(statement_id,segment_id)
);
create table if not exists statement_themes (
  statement_id uuid not null references statements(id) on delete cascade,
  theme_id uuid not null references themes(id) on delete cascade,
  primary key(statement_id,theme_id)
);
-- Future semantic links supplement the evidence-backed statement -> theme relations.
create table if not exists graph_edges (
  id uuid primary key default gen_random_uuid(),project_id uuid not null references projects(id) on delete cascade,
  from_statement_id uuid references statements(id) on delete cascade,
  to_statement_id uuid references statements(id) on delete cascade,
  relationship text not null check(relationship in ('supports','contradicts','elaborates','references')),
  review_status text not null default 'suggested',model_version text,evidence jsonb not null default '[]',
  created_at timestamptz not null default now(),
  check(from_statement_id is distinct from to_statement_id)
);
create table if not exists highlights (
  id uuid primary key default gen_random_uuid(),source_id uuid not null references sources(id) on delete cascade,
  title text not null,reason text,start_ms integer not null,end_ms integer not null,
  status text not null default 'suggested' check(status in ('suggested','approved','rendered','rejected','failed')),
  clips jsonb not null default '[]'::jsonb,
  media_key text,created_at timestamptz not null default now(),check(end_ms>start_ms)
);
create table if not exists processing_jobs (
  id uuid primary key default gen_random_uuid(),source_id uuid not null references sources(id) on delete cascade,
  kind text not null check(kind in ('transcribe_and_ingest','render_highlight')),
  status text not null default 'queued' check(status in ('queued','running','complete','failed')),
  attempts integer not null default 0,error text,started_at timestamptz,finished_at timestamptz,created_at timestamptz not null default now()
);
create index if not exists jobs_queue_idx on processing_jobs(status,created_at);
create table if not exists project_reports (
  id uuid primary key default gen_random_uuid(),project_id uuid not null references projects(id) on delete cascade,
  report jsonb not null,model_version text,created_at timestamptz not null default now()
);

-- No direct anonymous Supabase access; all queries go through authorized SvelteKit handlers.
do $$ declare t text; begin
  foreach t in array array['organizations','organization_members','projects','sources','source_permissions','source_segments','themes','statements','statement_evidence','statement_themes','graph_edges','highlights','processing_jobs','project_reports'] loop
    execute format('alter table %I enable row level security',t);
  end loop;
end $$;
