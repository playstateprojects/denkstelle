// Theme reels: compose an AI-assembled highlight reel across all interviews, review the plan, render it.
import {fail} from '@sveltejs/kit';
import type {PageServerLoad,Actions} from './$types';
import {requireAdmin,requireProjectAccess} from '$lib/server/access';
import {connect} from '$lib/server/db';
import {notifyJobs} from '$lib/server/jobs';
import {llmEnv} from '$lib/server/llm-env';
import {MODELS,modelConfigured,DEFAULT_MODEL} from '../../../../../../worker/src/models';
import {getActiveModel} from '../../../../../../worker/src/prompts';
import {clampParams,DEFAULT_PARAMS} from '../../../../../../worker/src/reel';

const UUID=/^[a-f0-9-]{36}$/i;
type Sql=ReturnType<typeof connect>;

/** The reel must belong to this project. */
async function ownReel(sql:Sql,projectId:string,id:string){
  const [r]=await sql<{id:string;status:string}[]>`select id,status from reels where id=${id} and project_id=${projectId}`;
  return r;
}

export const load:PageServerLoad=async({params,locals,url,platform})=>{
  const u=requireAdmin(locals,url,platform);const sql=connect(platform);
  try{
    const project=await requireProjectAccess(sql,params.id,u.id);
    const reels=await sql<{id:string;title:string;status:string;params:Record<string,unknown>;summary:string|null;trace:unknown;error:string|null;created_at:string}[]>`
      select id,title,status,params,summary,trace,error,created_at::text as created_at from reels where project_id=${params.id} order by created_at desc limit 20`;
    const ids=reels.map(r=>r.id);
    const clips=ids.length?await sql<{id:string;reel_id:string;position:number;source_id:string;theme_name:string;start_ms:number;end_ms:number;text:string;score:number;ratings:Record<string,number>;rationale:string|null;included:boolean;speaker:string|null}[]>`
      select c.id,c.reel_id,c.position,c.source_id,c.theme_name,c.start_ms,c.end_ms,c.text,c.score::float8 as score,c.ratings,c.rationale,c.included,s.contributor_label as speaker
      from reel_clips c join sources s on s.id=c.source_id where c.reel_id in ${sql(ids)} order by c.reel_id,c.position`:[];
    const [counts]=await sql<{eligible:number;themes:number}[]>`select
      (select count(*) from sources s join source_permissions p on p.source_id=s.id and p.purpose='public_excerpt' and p.allowed and p.withdrawn_at is null
        where s.project_id=${params.id} and s.status='ready' and s.role='contribution')::int as eligible,
      (select count(*) from themes where project_id=${params.id})::int as themes`;
    const env=llmEnv(platform);
    return {project,reels,clips,counts,defaults:DEFAULT_PARAMS,
      activeModel:await getActiveModel(sql),
      models:MODELS.map(m=>({id:m.id,label:m.label,ready:modelConfigured(m,env)})),defaultModel:DEFAULT_MODEL};
  }finally{await sql.end({timeout:1});}
};

export const actions:Actions={
  compose:async({request,params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);const f=await request.formData();
    const p=clampParams({target_ms:Number(f.get('seconds'))*1000,themes:Number(f.get('themes')),min_score:Number(f.get('min_score')),model:String(f.get('model')||'')});
    const sql=connect(platform);
    try{
      await requireProjectAccess(sql,params.id,u.id);
      const id=await sql.begin(async tx=>{
        const [r]=await tx<{id:string}[]>`insert into reels(project_id,title,status,params) values(${params.id},'…','queued',${tx.json(p as never)}) returning id`;
        await tx`insert into processing_jobs(kind,reel_id,status) values('compose_reel',${r.id},'queued')`;
        return r.id;
      }) as string;
      await notifyJobs(platform,'reel');
      return {queued:id};
    }finally{await sql.end({timeout:1});}
  },
  /** Include/exclude one clip from the render. Only while the plan is editable. */
  toggle:async({request,params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);const f=await request.formData();
    const id=String(f.get('clipId')??'');if(!UUID.test(id))return fail(400,{message:'Invalid clip'});
    const sql=connect(platform);
    try{
      await requireProjectAccess(sql,params.id,u.id);
      await sql`update reel_clips c set included=not included from reels r where c.id=${id} and r.id=c.reel_id and r.project_id=${params.id} and r.status in ('composed','rendered','failed')`;
      // The rendered file no longer matches the plan.
      await sql`update reels set status='composed' where status='rendered' and id=(select reel_id from reel_clips where id=${id})`;
      return {toggled:id};
    }finally{await sql.end({timeout:1});}
  },
  render:async({request,params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);const id=String((await request.formData()).get('reelId')??'');
    if(!UUID.test(id))return fail(400,{message:'Invalid reel'});
    const sql=connect(platform);
    try{
      await requireProjectAccess(sql,params.id,u.id);
      const r=await ownReel(sql,params.id,id);
      if(!r||!['composed','failed'].includes(r.status))return fail(409,{message:'Reel is not ready to render'});
      const [n]=await sql<{n:number}[]>`select count(*)::int as n from reel_clips where reel_id=${id} and included`;
      if(!n.n)return fail(400,{message:'Include at least one clip'});
      await sql`update reels set status='rendering',error=null where id=${id}`;
      await sql`insert into processing_jobs(kind,reel_id,status) values('render_reel',${id},'queued') on conflict do nothing`;
      await notifyJobs(platform,'reel');
      return {rendering:id};
    }finally{await sql.end({timeout:1});}
  },
  remove:async({request,params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);const id=String((await request.formData()).get('reelId')??'');
    if(!UUID.test(id))return fail(400,{message:'Invalid reel'});
    const sql=connect(platform);
    try{
      await requireProjectAccess(sql,params.id,u.id);
      const [r]=await sql<{media_key:string|null}[]>`delete from reels where id=${id} and project_id=${params.id} and status<>'rendering' returning media_key`;
      if(!r)return fail(409,{message:'Reel not found or currently rendering'});
      if(r.media_key)await platform?.env?.MEDIA?.delete(r.media_key).catch(()=>{});
      return {removed:id};
    }finally{await sql.end({timeout:1});}
  }
};
