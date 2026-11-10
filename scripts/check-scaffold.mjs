import {readFile,stat} from 'node:fs/promises';
import assert from 'node:assert/strict';
const required=['src/routes/p/[slug]/+page.svelte','src/routes/api/public/start/+server.ts','src/routes/api/public/upload/[id]/+server.ts','src/routes/dashboard/+page.server.ts','src/routes/dashboard/projects/[id]/nodes/+page.svelte','scripts/process-pending.ts','scripts/render-highlight.ts','worker/src/ingest.ts','worker/src/render.ts','worker/src/queue.ts','processor/src/index.ts','db/002_core.sql','db/003_job_queue.sql'];
for(const f of required){const s=await stat(f);assert(s.size>200,`${f} too small`)}
const sql=await readFile('db/002_core.sql','utf8');
for(const name of ['organizations','projects','sources','source_segments','source_permissions','statements','themes','statement_evidence','statement_themes','highlights','processing_jobs'])assert(sql.includes(`table if not exists ${name}`),`Missing ${name}`);
const pub=await readFile('src/routes/p/[slug]/+page.svelte','utf8');assert(pub.includes('getUserMedia'));assert(pub.includes('MediaRecorder'));assert(pub.includes('Datenschutz')||pub.includes('DATENSCHUTZ'));
const job=await readFile('worker/src/ingest.ts','utf8');assert(job.includes('ffmpeg'));assert(job.includes('whisper-large-v3-turbo'));assert(job.includes('statement_evidence'));
console.log('Scaffold structural checks passed:',required.length,'files');
