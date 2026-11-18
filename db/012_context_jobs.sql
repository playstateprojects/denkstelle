-- 012: Project context documents (sources with role 'context') are embedded and, optionally, read for statements by a job.
-- Idempotent: safe to run again.
alter table processing_jobs drop constraint if exists processing_jobs_kind_check;
alter table processing_jobs add constraint processing_jobs_kind_check
  check(kind in ('transcribe_and_ingest','render_highlight','compose_reel','render_reel','ingest_context'));

-- A long document is read in steps: each job does what fits in its time budget, then queues its own continuation.
-- Only one continuation may wait at a time, so a double click or a retry cannot queue two.
create unique index if not exists jobs_one_queued_context on processing_jobs(source_id)
  where kind='ingest_context' and status='queued';
