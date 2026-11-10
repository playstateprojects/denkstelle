/** Postgres-backed job queue. Pure SQL: shared by the container and the processor Worker's cron sweep,
 * so it must not import anything Node-specific.
 */
import type {Sql} from 'postgres';

export type JobKind='transcribe_and_ingest'|'render_highlight'|'compose_reel'|'render_reel';
export type Job={id:string;source_id:string|null;kind:JobKind;highlight_id:string|null;reel_id:string|null;attempts:number;max_attempts:number};
export type Handler=(sql:Sql,job:Job)=>Promise<void>;
export type Outcome='complete'|'retry'|'failed';

/** Throw from a handler when retrying cannot help (consent missing, source deleted, wrong state). */
export class PermanentError extends Error{}

/** Atomically claim the oldest due job. `skip locked` makes this safe with more than one worker. */
export async function claimJob(sql:Sql):Promise<Job|null>{
  const rows=await sql<Job[]>`
    update processing_jobs set status='running',attempts=attempts+1,started_at=now(),finished_at=null
    where id=(select id from processing_jobs where status='queued' and run_after<=now() order by created_at for update skip locked limit 1)
    returning id,source_id,kind,highlight_id,reel_id,attempts,max_attempts`;
  return rows[0]??null;
}

export async function runJob(sql:Sql,job:Job,handlers:Record<JobKind,Handler>):Promise<Outcome>{
  try{
    await handlers[job.kind](sql,job);
    await sql`update processing_jobs set status='complete',finished_at=now(),error=null where id=${job.id}`;
    return 'complete';
  }catch(err){
    console.error(`[job ${job.id}] ${job.kind} attempt ${job.attempts}/${job.max_attempts} failed:`,err);
    const retry=!(err instanceof PermanentError)&&job.attempts<job.max_attempts;
    const message=String(err).slice(0,2000);
    if(retry){
      // Back off 1, 2, 4... minutes (capped at 30). Nothing wakes the worker for this on its own: the caller
      // is told `retried>0` and schedules a delayed wake-up, and the cron sweep is the safety net.
      const delay=Math.min(1800,60*2**(job.attempts-1));
      await sql`update processing_jobs set status='queued',error=${message},run_after=now()+make_interval(secs=>${delay}) where id=${job.id}`;
    }else{
      await sql`update processing_jobs set status='failed',error=${message},finished_at=now() where id=${job.id}`;
    }
    await settleDerivedState(sql,job,retry?'queued':'failed',message);
    return retry?'retry':'failed';
  }
}

/** Keep sources/highlights consistent with the job after a failure or reap. */
async function settleDerivedState(sql:Sql,job:Pick<Job,'kind'|'source_id'|'highlight_id'|'reel_id'>,jobStatus:'queued'|'failed',message?:string){
  if(job.kind==='transcribe_and_ingest'&&job.source_id){
    // The ingest handler sets the source to 'processing'; put it back so a retry can claim it, or mark it failed.
    await sql`update sources set status=${jobStatus==='queued'?'uploaded':'failed'},updated_at=now() where id=${job.source_id} and status in ('processing','uploaded')`;
  }else if(job.kind==='compose_reel'||job.kind==='render_reel'){
    // A retry will redo the work; only a final failure marks the reel (the handler records its own message).
    if(job.reel_id&&jobStatus==='failed')await sql`update reels set status='failed',error=${message??'Job failed'} where id=${job.reel_id} and status in ('queued','composing','composed','rendering')`;
  }else if(job.highlight_id&&jobStatus==='failed'){
    await sql`update highlights set status='failed' where id=${job.highlight_id} and status='approved'`;
  }
}

/** Jobs stuck in 'running' (container crashed, deploy killed it) go back in the queue, or fail once out of attempts. */
export async function reapStuck(sql:Sql,minutes=30):Promise<number>{
  const rows=await sql<(Pick<Job,'id'|'kind'|'source_id'|'highlight_id'|'reel_id'>&{status:'queued'|'failed'})[]>`
    update processing_jobs set
      status=case when attempts>=max_attempts then 'failed' else 'queued' end,
      finished_at=case when attempts>=max_attempts then now() else null end,
      run_after=now(),error='Worker stopped before the job finished'
    where status='running' and started_at<now()-make_interval(mins=>${minutes})
    returning id,kind,source_id,highlight_id,reel_id,status`;
  for(const row of rows)await settleDerivedState(sql,row,row.status);
  return rows.length;
}

/** Queued jobs that have been due for over a minute: something should have picked them up already. */
export async function overdueCount(sql:Sql):Promise<number>{
  const [row]=await sql<{n:number}[]>`select count(*)::int as n from processing_jobs where status='queued' and run_after<=now()-interval '1 minute'`;
  return row?.n??0;
}
