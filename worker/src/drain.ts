import type {Sql} from 'postgres';
import {claimJob,runJob,type Handler,type JobKind} from './queue.ts';
import {ingest} from './ingest.ts';
import {render} from './render.ts';
import {compose,renderReelJob} from './reel.ts';

export const handlers:Record<JobKind,Handler>={transcribe_and_ingest:ingest,render_highlight:render,compose_reel:compose,render_reel:renderReelJob};
export type DrainResult={processed:number;failed:number;retried:number;more:boolean};

/** Work through due jobs one at a time. `more` means it stopped early (time budget or shutdown) with work possibly left. */
export async function drainQueue(sql:Sql,opts:{maxMs?:number;shouldStop?:()=>boolean;onPoke?:()=>boolean}={}):Promise<DrainResult>{
  const started=Date.now(),out:DrainResult={processed:0,failed:0,retried:0,more:false};
  for(;;){
    for(;;){
      if((opts.maxMs&&Date.now()-started>opts.maxMs)||opts.shouldStop?.()){out.more=true;return out;}
      const job=await claimJob(sql);
      if(!job)break;
      const outcome=await runJob(sql,job,handlers);
      if(outcome==='complete')out.processed++;else if(outcome==='retry')out.retried++;else out.failed++;
    }
    // A wake-up that arrived while we were working may refer to a job we already passed over: look once more.
    if(!opts.onPoke?.())return out;
  }
}
