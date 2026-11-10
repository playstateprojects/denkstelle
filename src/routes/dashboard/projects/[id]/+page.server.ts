import { error, fail, type PageServerLoad, type Actions } from '@sveltejs/kit';
import { requireAdmin,requireProjectAccess } from '$lib/server/access';
import {connect} from '$lib/server/db';
import {notifyJobs} from '$lib/server/jobs';
import {isCaptureMode} from '$lib/server/media';
import {getActiveModel,loadPrompts} from '../../../../../worker/src/prompts';
export const load:PageServerLoad=async({params,locals,url,platform})=>{
  const u=requireAdmin(locals,url,platform);const sql=connect(platform);
  try{
    const project=await requireProjectAccess(sql,params.id,u.id);
    const [sources,themes,highlights,reports]=await Promise.all([
      sql<{id:string;title:string;status:string;contributor_label:string|null;created_at:string;analysis:unknown}[]>`select id,title,status,contributor_label,created_at,analysis from sources where project_id=${params.id} order by created_at desc limit 150`,
      sql<{id:string;name:string;description:string|null;source_count:number}[]>`select t.id,t.name,t.description,count(distinct s.source_id)::int as source_count from themes t left join statement_themes st on st.theme_id=t.id left join statements s on s.id=st.statement_id where t.project_id=${params.id} group by t.id order by source_count desc, count(distinct s.id) desc, t.name limit 60`,
      sql<{id:string;source_id:string;title:string;reason:string|null;start_ms:number;end_ms:number;status:string;clips:unknown}[]>`select h.id,h.source_id,h.title,h.reason,h.start_ms,h.end_ms,h.status,h.clips from highlights h join sources s on s.id=h.source_id where s.project_id=${params.id} order by h.created_at desc limit 50`,
      sql<{report:unknown;created_at:string}[]>`select report,created_at from project_reports where project_id=${params.id} order by created_at desc limit 1`
    ]);
    // A recording is stale when it was analysed by another model or another version of that model's analysis prompt.
    const modelId=await getActiveModel(sql);const curVersion=(await loadPrompts(sql,modelId)).versions.analysis_system??0;
    const marked=sources.map(s=>{
      const a=(s.analysis&&typeof s.analysis==='object'?s.analysis:{}) as {model?:string;promptVersions?:Record<string,number>};
      return {...s,stale:s.status==='ready'&&(a.model!==modelId||(a.promptVersions?.analysis_system??0)!==curVersion)};
    });
    return {project,sources:marked,themes,highlights,report:reports[0]??null};
  } finally {await sql.end({timeout:1});}
};

export const actions:Actions={
  setMode:async({request,params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);
    const mode=String((await request.formData()).get('capture_mode')??'');
    if(!isCaptureMode(mode))return fail(400,{message:'Invalid recording mode'});
    const sql=connect(platform);
    try{
      await requireProjectAccess(sql,params.id,u.id);
      await sql`update projects set capture_mode=${mode} where id=${params.id}`;
      return {modeSaved:mode};
    }finally{await sql.end({timeout:1});}
  },
  reprocess:async({request,params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);
    const id=String((await (request.formData())).get('sourceId')??'');
    if(!/^[a-f0-9-]{36}$/i.test(id))return fail(400,{message:'Invalid recording ID'});
    const sql=connect(platform);
    try{
      await requireProjectAccess(sql,params.id,u.id);
      const done=await sql.begin(async tx=>{
        const r=await tx`update sources set status='uploaded',updated_at=now() where id=${id} and project_id=${params.id} and status='ready' returning id`;
        if(!r.length)return false;
        await tx`insert into processing_jobs(source_id,kind,status) values(${id},'transcribe_and_ingest','queued')`;
        return true;
      });
      if(!done)return fail(409,{message:'Recording is not ready, or does not belong to this project'});
      await notifyJobs(platform,'upload');
      return {reprocessed:id};
    }finally{await sql.end({timeout:1});}
  },
  approveHighlight:async({request,params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);
    const form=await request.formData();const id=String(form.get('highlightId')??'');
    if(!/^[a-f0-9-]{36}$/i.test(id))return fail(400,{message:'Invalid highlight ID'});
    const sql=connect(platform);
    try{
      await requireProjectAccess(sql,params.id,u.id);
      const rows=await sql<{id:string}[]>`select h.id from highlights h join sources s on s.id=h.source_id
        left join source_permissions p on p.source_id=s.id and p.purpose='public_excerpt'
        left join highlight_permissions hp on hp.highlight_id=h.id and hp.purpose='public_excerpt'
        where coalesce(hp.allowed,p.allowed,false) and h.id=${id} and s.project_id=${params.id} and h.status='suggested' limit 1`;
      if(!rows.length)return fail(403,{message:'Public excerpt permission or suggested highlight missing'});
      await sql`update highlights set status='approved' where id=${id}`;
      // Rendering is automatic from here: queue the job (a double click cannot queue two) and wake the worker.
      await sql`insert into processing_jobs(source_id,kind,highlight_id,status)
        select h.source_id,'render_highlight',h.id,'queued' from highlights h where h.id=${id} on conflict do nothing`;
      await notifyJobs(platform,'approve');
      return {approved:id};
    }finally{await sql.end({timeout:1});}
  }
};
