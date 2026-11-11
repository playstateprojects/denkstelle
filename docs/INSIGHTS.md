# Evidence-backed insights: design and rollout

**Status:** schema + decision policy only. This PR does **not** claim to run JEV, automatically populate insights, or replace the existing theme graph. The existing UI and ingestion pipeline remain operational on their previous model.

## Invariants

1. `sources` and `source_segments` are source truth; `statements` are extracted, source-linked claims. Preserve source text and segment evidence even when later interpretations change.
2. Embed individual statements and optionally complete recordings for contextual retrieval. **Do not cluster an entire interview embedding as if it were an atomic opinion.**
3. Nearest-neighbour retrieval is candidate generation, not proof of identity or agreement. Search near statements / existing insights, with optional counterclaim search for contradiction recall. **Never infer contradiction by choosing the farthest vectors.**
4. Classify candidate pairs with JEV or another explicitly configured classifier. Record `model_id`, `model_version`, `prompt_version`, retrieval method, reason, source-segment evidence, and review state in `relationship_assessments`. `insufficient_context` must be a valid response.
5. `equivalent` can propose insight membership, but should be checked against the **canonical insight meaning**, not blindly merged transitively: A≈B and B≈C does not prove A≈C. `supports`, `contradicts`, `related`, `elaborates` remain typed relations, not merge commands.
6. `insight_evidence` preserves support, challenge and context, including singleton perspectives. The map may include distinctive one-person insights; frequency is not significance.
7. `insight_edges` represent explicit interpreted relations between insights. Do not turn embedding proximity or co-occurring themes into consensus.
8. Insights are revisable. When the meaning changes substantially, create a successor with `predecessor_id` and mark the old insight `superseded`; never overwrite or delete the evidence.
9. Evidence from other projects must not leak across project boundaries. Composite project-key foreign keys enforce this in the new tables.
10. All claims stay candidates until evaluated. Classification scores are not calibrated probabilities. A human must review important contradictions and recommendations.

## Next-stage pipeline (not wired in this PR)

```
source audio/text
  -> transcription + timestamped segments (existing)
  -> atomic statements + statement_evidence (existing)
  -> statement embeddings (existing) + source embedding (new nullable column)
  -> pgvector nearest statement/insight candidates (to implement)
  -> optional generated counterclaim -> retrieve nearest actual statements (to implement)
  -> pairwise typed classifier + evidence, provenance and uncertainty (to implement)
  -> save relationship_assessments (to implement)
  -> cluster only well-supported equivalent statements, validate against canonical insight
  -> save insights + insight_evidence (to implement)
  -> create typed insight_edges for supported tension / relatedness (to implement)
  -> self-organizing graph of insights; source-linked drilldown (to implement)
  -> periodic review of split/merge, contradictions, outliers and unanswered questions
```

## What changes in the database

- `sources.embedding`: optional complete-source embedding (1024-dimensional, aligned with existing embedding provider).
- `insights`: interpretation layer with type, status, embedding and revision/successor fields.
- `insight_evidence`: multiple evidence roles, grounded in statements within the same project.
- `relationship_assessments`: auditable pairwise candidate judgements, including rejected or insufficient-context cases.
- `insight_edges`: typed relations between insight nodes, kept distinct from the existing `graph_edges` and thematic co-occurrence graph.

This is an additive migration. Existing `themes`, `statement_themes` and `graph_edges` remain untouched until a dedicated UI/ingestion migration is developed.

Run `npm run db:migrate` with a backup on a development database first. This migration enables RLS on the new tables, matching the existing server-only database-access pattern. Validate project-level authorization in application handlers before exposing writes or reads.

## Evaluation before production

Use a small consented or openly licensed dataset (e.g. Polis or community feedback) and hand-label difficult pairs. Compare nearest-only retrieval with nearest+counterclaim; report pairwise precision/recall, contradiction retrieval recall, cluster purity and source-grounding error rate. Keep evaluation labels independent of model outputs. Run each model and prompt revision on the same frozen source set.

## Status and next steps

Work in small steps; tick these off as they land.

- [x] Schema (`db/008_insights.sql`) and pure decision policy (`worker/src/insight-logic.ts`) with tests.
- [ ] **Gate:** do not run migration 008 in production until the evaluation harness below exists.
- [x] Classifier evaluation harness: `npm run eval:insights -- --pairs eval/pairs.jsonl --model mistral-large --swap` (format in `eval/pairs.example.jsonl`; reports per-relation precision/recall, false-merge rate, contradiction recall, over-abstention and A/B swap consistency).
- [ ] Write ~30 real hand-labelled pairs into `eval/pairs.jsonl` (git-ignored; include hard negatives, contradictions, can't-tell cases) and run it on each configured model. No interview data yet? `npm run mine:pairs` pulls candidate pairs from the public `sealuzh/app_reviews` set (licence unknown: keep local, internal eval only) and `npm run label:pairs` is the labelling CLI. App-review text is a stand-in; replace or supplement it with real interview pairs once you have them. Decide from the numbers whether the classifier is good enough to continue.
- [ ] Retrieval evaluation: nearest-only vs nearest + counterclaim, measuring contradiction recall against the labelled set.
- [ ] Compare nearest-only retrieval against nearest + counterclaim. Counterclaim search is an experiment, not a commitment; drop it (and its retrieval method) if recall gain is small.
- [ ] Decide whether `insight_edges` and `nearest_insight` are needed before building them.

Open questions:

- **Cost:** up to N x 20 classifier calls per ingest, repeated per prompt/model version. Needs a pair + prompt_version cache and a cheap first-pass filter.
- **Themes vs insights:** both exist during the transition. Decide when the UI switches and how `themes` data migrates.
- **Review:** `candidate`/`reviewed` statuses need a review queue and UI, or they will pile up unread.
- **Evidence integrity:** `relationship_assessments.evidence` is free-form jsonb; segment IDs are not FK-checked. Validate in the application layer or move to a join table.
- **Assessment uniqueness:** duplicates per (pair, model, prompt_version) are currently allowed (audit log). Add a unique index if that is not intended.
- **Revision bookkeeping:** `revision` / `updated_at` have no trigger and `superseded` is not tied to a successor by a constraint.
