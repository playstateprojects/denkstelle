/** Queue behaviour against a real Postgres.
 *   TEST_DATABASE_URL=postgresql://localhost:5432/postgres npm run test:worker
 * Skipped when TEST_DATABASE_URL is not set. Everything happens in a throw-away schema that is dropped afterwards.
 * The processing_jobs DDL is taken from db/002_core.sql and db/003_job_queue.sql so the test cannot drift from them.
 */
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import postgres from 'postgres';
import {claimJob,runJob,reapStuck,overdueCount,PermanentError,type Handler,type JobKind} from '../src/queue.ts';

const url=process.env.TEST_DATABASE_URL;
const schema=`queue_test_${process.pid}`;
const skip=url?false:'TEST_DATABASE_URL not set';
let sql:postgres.Sql;

before(async()=>{
  if(!url)return;
  const admin=postgres(url,{max:1});
  await admin.unsafe(`create schema ${schema}`);await admin.end();
  sql=postgres(url,{max:6,connection:{search_path:schema},onnotice:()=>{}});
  const core=await readFile(new URL('../../db/002_core.sql',import.meta.url),'utf8');
  const jobsDdl=core.match(/create table if not exists processing_jobs \([\s\S]*?\n\);/)?.[0];
  assert.ok(jobsDdl,'processing_jobs DDL not found in db/002_core.sql');
  // Minimal stand-ins for the tables processing_jobs references (the real ones need pgvector etc.).
  await sql.unsafe(`create table sources(id uuid primary key default gen_random_uuid(),status text not null default 'uploaded',updated_at timestamptz default now())`);
  await sql.unsafe(`create table highlights(id uuid primary key default gen_random_uuid(),source_id uuid not null references sources(id) on delete cascade,status text not null default 'approved')`);
  await sql.unsafe(jobsDdl);
  await sql.unsafe(await readFile(new URL('../../db/003_job_queue.sql',import.meta.url),'utf8'));
  await sql.unsafe(await readFile(new URL('../../db/003_job_queue.sql',import.meta.url),'utf8')); // idempotent: migrate.ts re-applies it
  // The job-queue half of 007_reels.sql (reel_id, wider kind check), against a stand-in reels table.
  await sql.unsafe(`create table reels(id uuid primary key default gen_random_uuid(),status text,error text)`);
  const reels=await readFile(new URL('../../db/007_reels.sql',import.meta.url),'utf8');
  await sql.unsafe(reels.slice(reels.indexOf('-- Reel jobs belong'),reels.indexOf('alter table reels enable')));
});
after(async()=>{
  if(!url)return;
  await sql?.end();
  const admin=postgres(url,{max:1});await admin.unsafe(`drop schema ${schema} cascade`);await admin.end();
});
beforeEach(async()=>{if(url)await sql`truncate sources cascade`;});

async function source(status='uploaded'){const [s]=await sql<{id:string}[]>`insert into sources(status) values(${status}) returning id`;return s.id;}
async function job(sourceId:string,kind:JobKind='transcribe_and_ingest',extra:{highlight?:string;createdAgo?:number}={}){
  const [j]=await sql<{id:string}[]>`insert into processing_jobs(source_id,kind,highlight_id,created_at)
    values(${sourceId},${kind},${extra.highlight??null},now()-make_interval(secs=>${extra.createdAgo??0})) returning id`;
  return j.id;
}
const status=async(id:string)=>(await sql<{status:string;attempts:number;error:string|null;run_after:Date}[]>`select status,attempts,error,run_after from processing_jobs where id=${id}`)[0];
const handlers=(fn:Handler):Record<JobKind,Handler>=>({transcribe_and_ingest:fn,render_highlight:fn,compose_reel:fn,render_reel:fn});

test('claims the oldest due job first and marks it running',{skip},async()=>{
  const s=await source();const newer=await job(s,'transcribe_and_ingest',{createdAgo:10}),older=await job(s,'transcribe_and_ingest',{createdAgo:60});
  const claimed=await claimJob(sql);
  assert.equal(claimed?.id,older);assert.equal(claimed?.attempts,1);
  assert.equal((await status(older)).status,'running');assert.equal((await status(newer)).status,'queued');
});

test('returns null when nothing is due, including jobs backing off in the future',{skip},async()=>{
  assert.equal(await claimJob(sql),null);
  const s=await source();const j=await job(s);
  await sql`update processing_jobs set run_after=now()+interval '5 minutes' where id=${j}`;
  assert.equal(await claimJob(sql),null);
});

test('concurrent workers never claim the same job (skip locked)',{skip},async()=>{
  const s=await source();for(let i=0;i<8;i++)await job(s);
  const claims=await Promise.all(Array.from({length:8},()=>claimJob(sql)));
  const ids=claims.map(c=>c?.id);
  assert.ok(ids.every(Boolean),'every concurrent claim should get a job');
  assert.equal(new Set(ids).size,8,'no job was claimed twice');
});

test('success completes the job and clears the error',{skip},async()=>{
  const s=await source();const j=await job(s);
  const outcome=await runJob(sql,(await claimJob(sql))!,handlers(async()=>{}));
  assert.equal(outcome,'complete');const row=await status(j);assert.equal(row.status,'complete');assert.equal(row.error,null);
});

test('a failing ingest is requeued with backoff and the source is reset so it can be claimed again',{skip},async()=>{
  const s=await source();const j=await job(s);
  const outcome=await runJob(sql,(await claimJob(sql))!,handlers(async()=>{await sql`update sources set status='processing' where id=${s}`;throw new Error('whisper timeout');}));
  assert.equal(outcome,'retry');
  const row=await status(j);assert.equal(row.status,'queued');assert.match(row.error??'',/whisper timeout/);
  assert.ok(row.run_after.getTime()>Date.now()+30_000,'backs off about a minute');
  assert.equal((await sql`select status from sources where id=${s}`)[0].status,'uploaded');
  assert.equal(await claimJob(sql),null,'not due yet');
  await sql`update processing_jobs set run_after=now() where id=${j}`;
  assert.equal((await claimJob(sql))?.attempts,2);
});

test('fails for good after max_attempts and marks the source failed',{skip},async()=>{
  const s=await source();const j=await job(s);await sql`update processing_jobs set max_attempts=2 where id=${j}`;
  const boom=handlers(async()=>{await sql`update sources set status='processing' where id=${s}`;throw new Error('boom');});
  assert.equal(await runJob(sql,(await claimJob(sql))!,boom),'retry');
  await sql`update processing_jobs set run_after=now() where id=${j}`;
  assert.equal(await runJob(sql,(await claimJob(sql))!,boom),'failed');
  assert.equal((await status(j)).status,'failed');
  assert.equal((await sql`select status from sources where id=${s}`)[0].status,'failed');
});

test('a PermanentError is never retried',{skip},async()=>{
  const s=await source();const j=await job(s);
  assert.equal(await runJob(sql,(await claimJob(sql))!,handlers(async()=>{throw new PermanentError('no consent');})),'failed');
  assert.equal((await status(j)).status,'failed');assert.equal((await status(j)).attempts,1);
});

test('a permanently failed render marks the highlight failed',{skip},async()=>{
  const s=await source('ready');const [h]=await sql<{id:string}[]>`insert into highlights(source_id) values(${s}) returning id`;
  const j=await job(s,'render_highlight',{highlight:h.id});
  assert.equal(await runJob(sql,(await claimJob(sql))!,handlers(async()=>{throw new PermanentError('No publication permission');})),'failed');
  assert.equal((await sql`select status from highlights where id=${h.id}`)[0].status,'failed');
  assert.equal((await status(j)).status,'failed');
});

test('approving twice cannot queue two render jobs',{skip},async()=>{
  const s=await source('ready');const [h]=await sql<{id:string}[]>`insert into highlights(source_id) values(${s}) returning id`;
  const enqueue=()=>sql`insert into processing_jobs(source_id,kind,highlight_id,status)
    select h.source_id,'render_highlight',h.id,'queued' from highlights h where h.id=${h.id} on conflict do nothing`;
  await enqueue();await enqueue();
  assert.equal((await sql`select count(*)::int as n from processing_jobs where highlight_id=${h.id}`)[0].n,1);
});

test('reapStuck requeues crashed jobs, fails exhausted ones, and leaves fresh ones alone',{skip},async()=>{
  const s1=await source('processing'),s2=await source('processing'),s3=await source('processing');
  const crashed=await job(s1),exhausted=await job(s2),fresh=await job(s3);
  await sql`update processing_jobs set status='running',attempts=1,started_at=now()-interval '45 minutes' where id=${crashed}`;
  await sql`update processing_jobs set status='running',attempts=3,started_at=now()-interval '45 minutes' where id=${exhausted}`;
  await sql`update processing_jobs set status='running',attempts=1,started_at=now()-interval '2 minutes' where id=${fresh}`;
  assert.equal(await reapStuck(sql,30),2);
  assert.equal((await status(crashed)).status,'queued');assert.equal((await status(exhausted)).status,'failed');assert.equal((await status(fresh)).status,'running');
  assert.equal((await sql`select status from sources where id=${s1}`)[0].status,'uploaded');
  assert.equal((await sql`select status from sources where id=${s2}`)[0].status,'failed');
  assert.equal((await sql`select status from sources where id=${s3}`)[0].status,'processing');
});

test('overdueCount only counts jobs that have been due for over a minute',{skip},async()=>{
  const s=await source();await job(s,'transcribe_and_ingest',{createdAgo:5});
  assert.equal(await overdueCount(sql),0);
  const old=await job(s,'transcribe_and_ingest',{createdAgo:300});await sql`update processing_jobs set run_after=created_at where id=${old}`;
  assert.equal(await overdueCount(sql),1,'only the 5-minute-old job counts; the 5-second-old one is still fresh');
});
