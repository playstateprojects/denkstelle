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
- Worker-side database schema: orgs, projects, sources, permissions, segments, statements, evidence, themes, edges, highlights, jobs and reports
- Standalone processing script: FFmpeg audio extraction, Cloudflare Whisper timestamped transcription, DeepSeek statement/summary/clip suggestion extraction, Cloudflare Qwen embeddings, PostgreSQL graph ingestion
- Interactive 3D graph of co-occurring topics adapted from Space Between's `3d-force-graph`
- FFmpeg CLI for captioned, portrait (9:16) highlight reels assembled from multiple approved source excerpts in private R2
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

## Safety checklist before public pilot

- Replace the prototype privacy notice and `draft-2026-11-05` policy version with client-approved, versioned information.
- Confirm the actual processor roles, DPAs and processing regions for Cloudflare, DeepSeek and Resend; do not advertise the prototype as offline or GDPR-certified.
- Implement upload retries with idempotent confirmation, webhook/queue processing, hard retention/deletion timers, export and withdrawal audit trail.
- Add abuse/rate limits, per-project quotas, moderator review, content-security policy and security tests.
- Test deletion while jobs are running and external social reposts; do not promise deletion from third-party platforms.
- Add human review to factual claims, disagreement detection, highlight context and captions.

## Local-first roadmap

A swappable provider boundary is already implicit: `worker/src/utils.ts` contains the cloud calls and FFmpeg wrapper. Replace them with local ASR, LLM, embedding and file/object storage interfaces for the DGX Spark deployment; keep the relational evidence model and the public UI unchanged.
