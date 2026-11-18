# Denkstelle

**Setz dich. Denk laut.** A privacy-conscious interview capture and evidence-linked qualitative discovery prototype.

This is an independent SvelteKit app based on patterns proven in **Space Between**. The code contains no production secrets or user data. Do **not** point it at Space Between's existing database or media bucket.

## Implemented

- SvelteKit 5 + TypeScript + Tailwind 4, Cloudflare adapter
- Better Auth + Resend magic-link administrator login, with `ADMIN_EMAILS` allowlist
- Multiple projects; public project-specific recording link
- Grouped, granular consent. No visitor account needed. Optional emailed data-management receipt.
- iPad-friendly camera/microphone preview, sound level meter, maximum 3-minute recording, replay and retry
- Anonymous contributor receipt code, private R2 media upload, administrative playback
- Generic `sources` + `source_segments` with modality-specific locators. PDFs/imported videos can be added later.
- Worker-side database schema: orgs, projects, sources, permissions, segments, statements, evidence, themes, insights, highlights, jobs and reports
- Standalone processing script: FFmpeg audio extraction, Cloudflare Whisper timestamped transcription, DeepSeek statement/summary/clip suggestion extraction, Cloudflare Qwen embeddings, PostgreSQL graph ingestion
- Interactive 3D graph of co-occurring topics adapted from Space Between's `3d-force-graph`
- FFmpeg CLI for captioned, portrait (9:16) highlight reels assembled from multiple approved source excerpts in private R2
- Telephone simulator at `/phone` (signed-in admins) and a device API for a Raspberry Pi handset, see [DEVICE_API.md](DEVICE_API.md)
- Recording deletion by private recovery code, including managed source media and derived highlights

## Deliberate limitations

- **Not yet production-ready for public recording.** Complete client-specific privacy notice, controller contacts, lawful-basis analysis, processor agreements, retention/deletion schedules, access logging, security review and abuse prevention are required.
- **Not offline.** The current prototype uses a cloud database, private Cloudflare R2, Cloudflare Workers AI, DeepSeek and optionally Resend. A DGX Spark provider can replace cloud processing later.
- **Processing runs in a Cloudflare Container, not in the SvelteKit Worker** (FFmpeg is needed). See [Automated processing](#automated-processing). `npm run process:once` and `npm run render -- <id>` remain as manual escape hatches.
- Transcription inference requires a real video, FFmpeg, Cloudflare credentials and a network connection. Device/MIME compatibility must be checked on the actual iPad.
- There is no automated publishing. Reel candidates require review, and public/social uses require the participant's explicit permissions.
- The 3D links currently represent thematic *co-occurrence*, **not** agreement. Avoid reporting consensus or demographic representativeness based solely on theme frequency.
- Uploads are capped at 60 MB. A 3-minute 1.2 Mbps recording should usually fit; test and add multipart/resumable uploads before wider use.
- Public upload endpoints need Cloudflare WAF/rate limiting and moderation/abuse controls before exposing to unknown visitors.
- Better Auth user tables are based on the working Space Between integration, but schema changes in future versions of Better Auth should be checked against the installed version.
- FFmpeg filters require an installation with `libx264`, `aac` and `subtitles`/`libass` support.

## Database migrations

`npm run db:migrate` applies every `db/*.sql` file in filename order to `DATABASE_URL`.

- Applied files are recorded in a `schema_migrations` table (name, SHA-256 checksum, timestamp) and skipped on later runs.
- Each migration runs in its own transaction with its tracking row. A failure rolls that file back and stops the run.
- To add a migration, create the next numbered file (e.g. `db/006_something.sql`) and run the command again.
- Don't edit a migration after it has been applied. The script warns when a recorded checksum no longer matches but does not re-run the file. Put changes in a new file.
- The first run against a database that predates tracking re-runs `001`–`005` once before recording them, so keep those files idempotent.

## First setup

1. Create a **new, private** GitHub repo called `denkstelle` and push this folder (this package is not yet pushed to GitHub).
2. `npm install` (Node 22+ recommended). If dependency versions have moved, pin from the lockfile you generate.
3. Create a **new** PostgreSQL database with the `vector` extension available (e.g. Supabase project). Copy `.env.example` to `.env` and fill `DATABASE_URL`, `BETTER_AUTH_SECRET`, `ADMIN_EMAILS` and `BETTER_AUTH_URL`.
4. `npm run db:migrate` to apply all SQL files in `db/` (see [Database migrations](#database-migrations)).
5. Create a **private** Cloudflare R2 bucket `denkstelle-private` (or update the bucket name in `wrangler.jsonc`). Configure Workers AI and a Cloudflare Hyperdrive binding for the Denkstelle DB when deploying. For local Worker bindings, see Cloudflare's SvelteKit adapter documentation.
6. Configure Resend (`RESEND_API_KEY`, verified `EMAIL_FROM`) for real emails. In development, magic links log to the server if the key is absent. Set `BETTER_AUTH_SECRET` to a cryptographically random string and set the correct `BETTER_AUTH_URL`.
7. `npm run dev`; visit `/login`, sign in as an allowlisted administrator, go to `/dashboard`, create a project, and open its `/p/<slug>` link on an HTTPS-served iPad.
8. Confirm camera permissions, microphone source and MP4/WebM output on the *actual iPad*. MediaDevices requires HTTPS outside localhost; an iPad cannot use your laptop's `http://localhost`.
9. Set up [Automated processing](#automated-processing). Once a video uploads it is transcribed, analysed and turned into suggested highlight clips with no manual step. (Without the processor you can still run `npm run process:once` on a trusted machine with FFmpeg and the `R2_*`, `WORKERS_AI_API_TOKEN` and `DEEPSEEK_API_KEY` variables set; it drains every queued job.)
10. Approve the suggested excerpt in the dashboard. Rendering to private R2 with captions starts automatically; view it in the dashboard when its status is `rendered`. Manual publication should check both the clip's context and `social_media` permission.

Note: `wrangler.jsonc` contains **no production account IDs, secrets or pre-existing bucket names** from Space Between. You must bind your own resources. The app cannot complete a remote upload until the private `MEDIA` R2 binding is available.

## Automated processing

```
upload / approve ──► processing_jobs row (Postgres = source of truth)
        │
        └─► JOBS queue ──► denkstelle-processor Worker ──POST /drain──► Processor container
                                  ▲                                      (FFmpeg + Whisper + DeepSeek)
            cron, every 5 min ────┘  requeue stuck jobs, re-wake if anything has waited > 1 min
```

- **Postgres is the queue; the Cloudflare Queue only says "go look".** A lost, duplicated or delayed message is harmless: jobs are claimed atomically (`for update skip locked`), and the cron sweep re-wakes the worker for anything overdue.
- **One container, one job at a time.** `/drain` works through all due jobs serially and returns when none are left. The Worker's open request keeps the container awake; it then sleeps after 3 idle minutes and bills nothing.
- **Job kinds:** `transcribe_and_ingest` (created on upload) and `render_highlight` (created when a highlight is approved; double-approval cannot queue two).
- **Retries:** up to 3 attempts with 1, 2, 4 minute backoff. Missing consent, a deleted source or a bad state fail immediately (`PermanentError`). A job stuck in `running` for 30 minutes (crash, deploy) is requeued, or failed once attempts run out. The reason is in `processing_jobs.error`.
- **Deploys** send SIGTERM; the container finishes its current job and claims no more (15 minute grace).

Code: `worker/` (container: `src/queue.ts` SQL queue, `ingest.ts`, `render.ts`, `server.ts`), `processor/` (Worker + wrangler config), `db/003_job_queue.sql`.

### One-time setup

1. `npx wrangler queues create denkstelle-jobs`
2. `npm run db:migrate` (applies any pending migrations, including `003_job_queue.sql`).
3. Start Docker Desktop (Wrangler builds the container image locally), then `npm run deploy:processor`.
4. `cp processor/secrets.example processor/.secrets`, fill it in (a direct `DATABASE_URL`, the R2 S3 key pair, Workers AI token, DeepSeek key), then `npm run processor:secrets`.
5. `npm run deploy` for the SvelteKit app, which now also produces to the `JOBS` queue.
6. Upload a test recording and watch it with `npm run processor:logs`.

### Operating it

- `npm run test:worker` runs the queue tests; set `TEST_DATABASE_URL` to a scratch Postgres (they use a throw-away schema).
- `npm run check:worker` typechecks the container and Worker code.
- `npm run worker:dev` runs the container server locally (`POST localhost:8080/drain`).
- Failed jobs: `select id, kind, attempts, error from processing_jobs where status = 'failed'`. To retry one: `update processing_jobs set status='queued', attempts=0, run_after=now() where id = '…'` (and set its source back to `uploaded` for an ingest job), then wait for the next sweep.
- Cost: `standard-2` (1 vCPU, 6 GiB) bills memory while running and CPU only when active. A few minutes per interview sits well inside the Workers Paid included allowance. Check Billable Usage after the first week.

## Sources, statements, themes, insights

One chain, each step derived from the one before and linked back to it:

1. **Source** → `source_segments` (timestamped transcript) → **statements**, each citing its segments in `statement_evidence` (`worker/src/analysis.ts`, prompt `analysis_system`).
2. Statements → **themes**, topic first (`worker/src/topic-match.ts`, migration `016`; this is the default). Membership is `statement_themes`, an edge with a weight:
   - A chat model lists 1 to 3 **atomic topics** per statement (prompt `topic_extract_system`, editable at `/admin/prompts`): "the laser cutter lab is too expensive" gives "laser cutter lab" and "price". Names and descriptions are English whatever the statement's language. It is shown the themes of the statement's nearest statements and reuses their names. A name made only of words like "ideas" or "next steps" is dropped by code.
   - Each topic is matched to the project's themes: exact canonical name, then the 3 nearest themes by label embedding. **Jev scores the statement against every candidate** (one request per statement, `buildQuestions` in `theme-match.ts`); that probability is the edge weight in `statement_themes.probability`. An exact name is only a candidate: a sloppy reuse does not get weight 1.
   - A candidate at 0.5 or more gets the edge (at most 2 per topic). If none does, the topic starts a new theme named as the extractor wrote it. An exact name that Jev scored below 0.5 keeps its edge as `name_match` with Jev's weight. `method` is `seed` (started the theme), `exact`, `embed` or `name_match`; every judgement is also kept in `theme_judgements`.
   - Eval on 92 statements in 3 orders (`npm run eval:topics`, results in `eval/results/topics-*.json`): the largest theme holds 11 to 13% of statements (16 to 50% with the older method), and two orders agree on which statements share a theme at F1 0.50 (0.32 to 0.40). The number of themes is **not** lower (34 to 43), so expect themes at the grain of "price" or "booking system", many with only a few statements. Jev and Cloudflare's Clef (`worker/src/clef.ts`, `--judge clef`) gave the same quality; Jev is about 5x cheaper per token.
   - Not done: rewriting a theme's wording as it grows, merging, and the `pending` state (a statement is placed or fails and is retried on the next run). A parent/sub-theme layer was tried (`worker/src/topic-hierarchy.ts`, `npm run eval:topics`): parents read well in small clusters but differed between orders and the judge agreed with nearly every proposal, so it is not in the pipeline.
   - `npm run themes:assign -- <projectId>` places what is unplaced; `--reset` first saves the current themes and insights to `eval/results/` and starts over; `--insights` derives insights afterwards. `--classic` runs the older method described next.

   **Classic method** (`worker/src/theme-match.ts`, migration `013`; `themes:assign -- --classic`):
   - The statement's embedding finds its nearest statements; their themes are the candidates (at most 4).
   - Jev (`worker/src/jev.ts`) is asked one yes/no question per candidate, in a single request: does the statement speak to this issue? A statement can join several themes.
   - `decide` turns the probabilities into an outcome. Any candidate at 0.6 or more: join those (up to 3). Every candidate at 0.3 or less, or none found: the statement starts a theme, named by the chat model (prompt `theme_name_system`). Anything in between: pending for now.
   - A run then makes a second, settling pass over what the first left pending: the themes have grown and been rewritten, so each statement is asked again. A candidate at 0.5 or more (more likely than not) is joined; otherwise the statement starts its own theme. Nothing stays pending.
   - The project question is not used when building themes: not in Jev's state (with it, one theme about "improvements" absorbed 50+ of 92 statements in 2 of 3 orders), not in naming or rewriting. Themes describe what statements are about. It is still used for insights.
   - A theme's name and description are rewritten each time it has grown by 5 statements (`REWRITE_EVERY`; prompt `theme_rewrite_system`, migration `014`). The check runs right after each statement is placed, so a long batch is judged against wording that follows the theme, not the one statement that started it. The rewriter sees the current wording and up to 40 of the theme's statements and keeps the wording when it still holds. If the new name would equal another theme's, the old wording stays (that is a merge signal). Every change is kept in `theme_renames`. A failed rewrite never undoes a placement and is retried at the theme's next statement.
   - Every judgement is kept in `theme_judgements`, so thresholds can be changed and re-scored without new calls. Thresholds and question wording live in `theme-match.ts`; bump `THEME_JEV_VERSION` when either changes. Known limit: themes are named from one seed statement, so they start narrow and the run ends with roughly 3x more themes than a person would make (eval, 92 statements: 31 to 37 themes). A theme merge pass (`worker/src/theme-merge.ts`, run at the end of `assignThemes`, or alone with `npm run themes:assign -- <projectId>`) is the fix: themes whose statements overlap (at least 60% of the smaller theme inside the larger, at least 3 in common) are put to Jev as a pair, "are these the same topic, worded differently?", and merged at 0.7. The overlap only nominates; Jev decides. Merges are logged in `theme_merges`. On the Truth and lies project the nominated pairs overlapped 60 to 88% yet Jev put every one at 0.14 to 0.34 (different aspects of one subject), so nothing merged: heavy overlap there means related aspects, not duplicates, and that structure is for a parent/sub-theme step (not built). Pairs kept apart are asked again on every run.
   - Runs after every finished recording or document. `npm run themes:assign -- <projectId>` places what is unplaced; `--reset` first saves the current themes and insights to `eval/results/` and starts over. `npm run eval:themes` runs the same logic in memory over a frozen statement set in several orders, to measure order sensitivity.
   - Needs `TYPESAFE_API_KEY` (also a processor secret). The older whole-project pass (`themes.ts`, prompt `themes_system`, `npm run themes:rebuild`) still works and is kept for comparison.
3. Theme → **insights** (`worker/src/insights.ts`, prompt `insights_system`): one call per theme over that theme's statements. Each insight cites the statements it rests on in `insight_evidence`; the code drops citations the model invented and insights left without evidence.

So an insight resolves to a recording and a timestamp via `insight_evidence → statements → statement_evidence → source_segments → sources`.

Themes and insights are re-derived, never edited. A theme keeps its insights while its basis (model, prompt version, statement set, stored in `themes.insight_basis`) is unchanged; a renamed or dropped theme takes its insights with it. `npm run themes:rebuild` repairs both, `-- --insights` forces every theme.

Not built yet: contradictions (planned for the theme summary first) and edges between insights that cross themes. An earlier pairwise-relation experiment (classifier, Jev, eval harness and rubric) is kept in the local git tag `archive/pairwise-insight-experiment`; its data is still in `eval/`.

## Theme reels (experimental)

`/dashboard/projects/<id>/reels` composes one highlight reel across **all** interviews instead of within one. Job kinds `compose_reel` and `render_reel`; code in `worker/src/reel.ts`; tables `reels` and `reel_clips` (`db/007_reels.sql`).

1. **Top themes**: ranked by how many consenting interviews raise them.
2. **Candidates**: for each theme, transcript windows from its statement evidence plus the segments nearest the theme embedding.
3. **Rate** (LLM, prompt `reel_rate_system`): relevance, standalone, insight, vividness, 1-5, one call per theme.
4. **Select** (code): weighted score (`WEIGHTS` in `reel.ts`), best clip per theme, different speakers preferred, fill to the target length.
5. **Arrange** (LLM, prompt `reel_arrange_system`): running order, title, summary; code accepts the order only if it is a valid permutation.

The plan is reviewable (drop clips, watch each original span) before rendering. Only recordings with a valid `public_excerpt` permission are used, checked again at render time. Deleting a recording removes any rendered reel that included it. Tune the two prompts at `/admin/prompts`; each reel stores a trace of what each step found. Clips are real spans of the recordings; nothing is generated.

## Source-agnostic design

`source.kind`: `interview_video | uploaded_video | audio | pdf | document | text | external_url`.

`source.role`: `contribution | context | editorial`.

`source_segments`: text plus optional video `start_ms/end_ms`, PDF `page_number`, or text `char_start/char_end` locators. Every statement points via `statement_evidence` to one or more segments. Highlight generation only accepts video sources with concrete timestamps and suitable permissions. A future PDF importer can generate the exact same segments and graph relationships, but will never be miscounted as a human interview.

An imported context document may influence analysis but **must never inflate participant counts or be presented as a participant's opinion**. Source role and project isolation are explicit in the schema.

### Project context documents

Uploaded on the project page (PDF, TXT or pasted text; `src/lib/server/context.ts`, `src/lib/context-text.ts`) as sources with `role='context'`, cut into passages in `source_segments` (PDF passages keep `page_number`). The `ingest_context` job (`worker/src/context.ts`, migration `db/012_context_jobs.sql`) then:

1. **Embeds the passages.** `retrieveContext` finds the passages closest to an interview's transcript, and `analyze` receives them as BACKGROUND EXCERPTS, to understand what the speaker refers to. They are never a source of statements for that interview. Recordings analysed before a document is ready are not re-analysed automatically.
2. **Optionally reads the text itself** (the "extract" checkbox) in windows of 24 passages with the `context_system` prompt (editable at `/admin/prompts`). Statements are stored with `source_id` of the context source, so they flow into themes and insights. The job is resumable (`analysis.cursor`, committed with each window, one continuation job at a time) because the queue reaps jobs running over 30 minutes. Roughly 45 model calls for a 1.3M-character book.

Where context statements are kept apart from people: the theme and insight prompts tag interviews `I1..` and the text `T1..` with a note not to count the text as agreement; a theme's `sourceCount` (ranking, "N sources") counts interviews only; the dashboard marks theme counts and evidence "from the text". Reports (`ingest.ts`) still count only `role='contribution'`. To analyse participants alone, filter on `sources.role='contribution'` in the statement queries of `themes.ts` and `insights.ts`.

## Safety checklist before public pilot

- Replace the prototype privacy notice and `draft-2026-11-05` policy version with client-approved, versioned information.
- Confirm the actual processor roles, DPAs and processing regions for Cloudflare, DeepSeek and Resend; do not advertise the prototype as offline or GDPR-certified.
- Implement upload retries with idempotent confirmation, webhook/queue processing, hard retention/deletion timers, export and withdrawal audit trail.
- Add abuse/rate limits, per-project quotas, moderator review, content-security policy and security tests.
- Test deletion while jobs are running and external social reposts; do not promise deletion from third-party platforms.
- Add human review to factual claims, disagreement detection, highlight context and captions.

## Local-first roadmap

A swappable provider boundary is already implicit: `worker/src/utils.ts` contains the cloud calls and FFmpeg wrapper. Replace them with local ASR, LLM, embedding and file/object storage interfaces for the DGX Spark deployment; keep the relational evidence model and the public UI unchanged.
