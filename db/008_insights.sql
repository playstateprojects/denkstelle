-- 008: Evidence-backed insight layer.
-- Statements and original source segments remain immutable evidence; insights are revisable interpretations.
-- Additive migration: existing themes and graph display remain unchanged until explicitly migrated.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS embedding vector(1024);
CREATE INDEX IF NOT EXISTS sources_embedding_idx ON sources USING hnsw (embedding vector_cosine_ops);

CREATE UNIQUE INDEX IF NOT EXISTS statements_project_id_uq ON statements(project_id,id);

CREATE TABLE IF NOT EXISTS insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('recurring','relational','distinctive')),
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','reviewed','rejected','superseded')),
  embedding vector(1024),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_model text,
  prompt_version text,
  predecessor_id uuid REFERENCES insights(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS insights_project_idx ON insights(project_id,status);
CREATE INDEX IF NOT EXISTS insights_embedding_idx ON insights USING hnsw (embedding vector_cosine_ops);
CREATE UNIQUE INDEX IF NOT EXISTS insights_project_id_uq ON insights(project_id,id);

-- This table represents evidence, never a destructive merge. One statement may support
-- multiple insights, or challenge a given insight, without losing its original wording.
CREATE TABLE IF NOT EXISTS insight_evidence (
  project_id uuid NOT NULL,
  insight_id uuid NOT NULL,
  statement_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('supports','challenges','context')),
  explanation text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (insight_id,statement_id,role),
  FOREIGN KEY (project_id,insight_id) REFERENCES insights(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY (project_id,statement_id) REFERENCES statements(project_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS insight_evidence_statement_idx ON insight_evidence(project_id,statement_id);

-- Record all candidate pair judgements, including negatives and uncertain results.
-- These are *assessments*, not authoritative graph edges. Directed pairs preserve
-- semantic direction for supports/elaborates; caller canonicalizes symmetric pairs.
CREATE TABLE IF NOT EXISTS relationship_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_statement_id uuid NOT NULL,
  to_statement_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN
    ('equivalent','supports','contradicts','related','elaborates','unrelated','insufficient_context')),
  retrieval_method text NOT NULL CHECK (retrieval_method IN
    ('nearest_statement','nearest_insight','counterclaim','manual')),
  model_id text NOT NULL,
  model_version text,
  prompt_version text,
  classifier_reason text,
  confidence double precision CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_status text NOT NULL DEFAULT 'suggested' CHECK (review_status IN ('suggested','confirmed','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,from_statement_id) REFERENCES statements(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY (project_id,to_statement_id) REFERENCES statements(project_id,id) ON DELETE CASCADE,
  CHECK (from_statement_id <> to_statement_id)
);
CREATE INDEX IF NOT EXISTS relationship_assessments_project_idx ON relationship_assessments(project_id,created_at DESC);
CREATE INDEX IF NOT EXISTS relationship_assessments_pair_idx ON relationship_assessments(project_id,from_statement_id,to_statement_id);

-- Insight-to-insight relations for the *interpretation* map, not raw co-occurrence.
CREATE TABLE IF NOT EXISTS insight_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_insight_id uuid NOT NULL,
  to_insight_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('supports','contradicts','related','elaborates')),
  explanation text NOT NULL,
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','reviewed','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,from_insight_id) REFERENCES insights(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY (project_id,to_insight_id) REFERENCES insights(project_id,id) ON DELETE CASCADE,
  CHECK (from_insight_id <> to_insight_id)
);
CREATE INDEX IF NOT EXISTS insight_edges_project_idx ON insight_edges(project_id);

ALTER TABLE insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight_edges ENABLE ROW LEVEL SECURITY;
