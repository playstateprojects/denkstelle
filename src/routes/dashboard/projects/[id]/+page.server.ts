import { error, fail, type PageServerLoad, type Actions } from '@sveltejs/kit';
import { requireAdmin,requireProjectAccess } from '$lib/server/access';
import {connect} from '$lib/server/db';
import {notifyJobs} from '$lib/server/jobs';
import {isCaptureMode,mediaBucket,maxGreetingBytes,greetingMime,mediaExtension} from '$lib/server/media';
import {getActiveModel,loadPrompts} from '../../../../../worker/src/prompts';
import {contextFileKind,titleFromFilename,maxContextBytes,maxContextChars,maxContextDocs} from '$lib/context-text';
import {ContextError,pdfPages,textPages,saveContext} from '$lib/server/context';
import {z} from 'zod';
import {Resend} from 'resend';
import {config} from '$lib/server/db';
import {translate} from '$lib/i18n';
import {renderReport} from '$lib/project-report';
import {loadReport} from '$lib/server/report';
type ContextDoc={id:string;title:string;kind:string;status:string;size_bytes:number|null;created_at:string;analysis:{chars?:number;chunks?:number;pages?:number;extract?:boolean;cursor?:number;statements?:number}|null};
type Insight={id:string;theme_id:string;title:string;description:string;evidence:{text:string;source_id:string;source:string;start_ms:number|null;page:number|null;from_text:boolean}[]};
export const load:PageServerLoad=async({params,locals,url,platform})=>{
  const u=requireAdmin(locals,url,platform);const sql=connect(platform);
  try{
    const project=await requireProjectAccess(sql,params.id,u.id);
    const [sources,themes,highlights,reports,insights,contextDocs]=await Promise.all([
      // Only participant contributions: context documents are listed separately and must never be offered for reprocessing.
      sql<{id:string;title:string;status:string;contributor_label:string|null;created_at:string;analysis:unknown;mime_type:string|null;kind:string}[]>`select id,title,status,contributor_label,created_at,analysis,mime_type,kind from sources where project_id=${params.id} and role='contribution' order by created_at desc limit 150`,
      // source_count is INTERVIEWS only; text_count is how many of the theme's statements were read from the reference text.
      sql<{id:string;name:string;description:string|null;source_count:number;text_count:number}[]>`select t.id,t.name,t.description,
        count(distinct s.source_id) filter (where so.role='contribution')::int as source_count,
        count(distinct s.id) filter (where so.role='context')::int as text_count
        from themes t left join statement_themes st on st.theme_id=t.id left join statements s on s.id=st.statement_id left join sources so on so.id=s.source_id
        where t.project_id=${params.id} group by t.id order by source_count desc, count(distinct s.id) desc, t.name limit 60`,
      sql<{id:string;source_id:string;title:string;reason:string|null;start_ms:number;end_ms:number;status:string;clips:unknown}[]>`select h.id,h.source_id,h.title,h.reason,h.start_ms,h.end_ms,h.status,h.clips from highlights h join sources s on s.id=h.source_id where s.project_id=${params.id} order by h.created_at desc limit 50`,
      sql<{report:unknown;created_at:string}[]>`select report,created_at from project_reports where project_id=${params.id} order by created_at desc limit 1`,
      // Each insight with the statements it rests on, the recording each came from and where in it (earliest cited segment).
      sql<Insight[]>`select i.id,i.theme_id,i.title,i.description,
        coalesce(json_agg(json_build_object('text',st.text,'source_id',s.id,'source',s.title,'start_ms',
          (select min(seg.start_ms) from statement_evidence e join source_segments seg on seg.id=e.segment_id where e.statement_id=st.id),
          'page',(select min(seg.page_number) from statement_evidence e join source_segments seg on seg.id=e.segment_id where e.statement_id=st.id),
          'from_text',s.role='context')
          order by s.created_at,st.created_at) filter (where st.id is not null),'[]') as evidence
        from insights i left join insight_evidence ie on ie.insight_id=i.id left join statements st on st.id=ie.statement_id left join sources s on s.id=st.source_id
        where i.project_id=${params.id} group by i.id order by i.created_at,i.id`
        // Before db/011_insights.sql is applied there are simply no insights.
        .catch((e:unknown)=>{if((e as {code?:string})?.code==='42P01')return [] as Insight[];throw e}),
      sql<ContextDoc[]>`select id,title,kind,status,size_bytes::int as size_bytes,created_at,analysis from sources where project_id=${params.id} and role='context' order by created_at desc`
    ]);
    // A recording is stale when it was analysed by another model or another version of that model's analysis prompt.
    const modelId=await getActiveModel(sql);const curVersion=(await loadPrompts(sql,modelId)).versions.analysis_system??0;
    const marked=sources.map(s=>{
      const a=(s.analysis&&typeof s.analysis==='object'?s.analysis:{}) as {model?:string;promptVersions?:Record<string,number>};
      return {...s,stale:s.status==='ready'&&(a.model!==modelId||(a.promptVersions?.analysis_system??0)!==curVersion)};
    });
    const [g]=await sql<{phone_greeting_key:string|null;phone_greeting_mime:string|null;phone_greeting_url:string|null;phone_greeting_updated_at:Date|null}[]>`select phone_greeting_key,phone_greeting_mime,phone_greeting_url,phone_greeting_updated_at from projects where id=${params.id}`;
    const greeting={uploaded:!!g?.phone_greeting_key,externalUrl:g?.phone_greeting_url??null,version:g?.phone_greeting_updated_at?.getTime()??0};
    return {project,sources:marked,themes:themes.map(th=>({...th,insights:insights.filter(i=>i.theme_id===th.id)})),highlights,report:reports[0]??null,greeting,contextDocs,userEmail:u.email};
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
  triggerProcessing:async({params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);const sql=connect(platform);
    try{await requireProjectAccess(sql,params.id,u.id)}finally{await sql.end({timeout:1})}
    const api=platform?.env?.PROCESSOR_API;
    if(!api)return fail(503,{message:'Processor is not connected (no PROCESSOR_API binding in this environment)'});
    try{
      const r=await api.fetch('https://processor/cron',{method:'POST'});
      if(!r.ok)return fail(502,{message:`Processor responded ${r.status}`});
      const b=await r.json() as {reaped?:number;overdue?:number};
      return {triggered:{reaped:b.reaped??0,overdue:b.overdue??0}};
    }catch(e){console.error('[trigger] processor call failed',e);return fail(502,{message:'Processor could not be reached'});}
  },
  uploadGreeting:async({request,params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);
    const file=(await request.formData()).get('greeting');
    if(!(file instanceof File)||!file.size)return fail(400,{greetingError:'noFile'});
    if(file.size>maxGreetingBytes)return fail(413,{greetingError:'tooLarge'});
    const mime=greetingMime(file);
    if(!mime)return fail(415,{greetingError:'badType'});
    const sql=connect(platform);
    try{
      await requireProjectAccess(sql,params.id,u.id);
      const bucket=mediaBucket(platform);
      // A new key per upload, so a replaced greeting is never served from a stale cache.
      const key=`projects/${params.id}/greeting/${crypto.randomUUID()}.${mediaExtension(mime)}`;
      await bucket.put(key,await file.arrayBuffer(),{httpMetadata:{contentType:mime}});
      const [old]=await sql<{phone_greeting_key:string|null}[]>`select phone_greeting_key from projects where id=${params.id}`;
      await sql`update projects set phone_greeting_key=${key},phone_greeting_mime=${mime},phone_greeting_updated_at=now() where id=${params.id}`;
      if(old?.phone_greeting_key)await bucket.delete(old.phone_greeting_key).catch(()=>{});
      return {greetingSaved:true};
    }finally{await sql.end({timeout:1});}
  },
  removeGreeting:async({params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);const sql=connect(platform);
    try{
      await requireProjectAccess(sql,params.id,u.id);
      const [old]=await sql<{phone_greeting_key:string|null}[]>`update projects p set phone_greeting_key=null,phone_greeting_mime=null,phone_greeting_updated_at=null
        from (select id,phone_greeting_key from projects where id=${params.id}) o where p.id=o.id returning o.phone_greeting_key`;
      if(old?.phone_greeting_key)await mediaBucket(platform).delete(old.phone_greeting_key).catch(()=>{});
      return {greetingRemoved:true};
    }finally{await sql.end({timeout:1});}
  },
  addContextFile:async({request,params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);
    const form=await request.formData();const file=form.get('file');
    if(!(file instanceof File)||!file.size)return fail(400,{contextError:'noFile'});
    if(file.size>maxContextBytes)return fail(413,{contextError:'tooLarge'});
    const type=contextFileKind(file);
    if(!type)return fail(415,{contextError:'badType'});
    const title=String(form.get('title')??'').trim().slice(0,160)||titleFromFilename(file.name);
    const sql=connect(platform);
    let key:string|null=null;
    try{
      await requireProjectAccess(sql,params.id,u.id);
      const [{n}]=await sql<{n:number}[]>`select count(*)::int as n from sources where project_id=${params.id} and role='context'`;
      if(n>=maxContextDocs)return fail(409,{contextError:'limit'});
      const bytes=await file.arrayBuffer();
      const pages=type.kind==='pdf'?await pdfPages(bytes):textPages(bytes);
      // Reject before storing anything if the text is unusable; keep the original only once it is known to be readable.
      if(!pages.some(p=>p.text.trim()))return fail(422,{contextError:'noText'});
      if(pages.reduce((c,p)=>c+p.text.length,0)>maxContextChars*1.2)return fail(422,{contextError:'tooLong'});
      const bucket=mediaBucket(platform);
      key=`projects/${params.id}/context/${crypto.randomUUID()}.${type.kind==='pdf'?'pdf':'txt'}`;
      await bucket.put(key,bytes,{httpMetadata:{contentType:type.mime}});
      const saved=await saveContext(sql,{projectId:params.id,title,kind:type.kind,mime:type.mime,sizeBytes:file.size,mediaKey:key,pages,extract:form.get('extract')==='on'});
      await notifyJobs(platform,'upload');
      return {contextSaved:{title,chunks:saved.chunks}};
    }catch(e){
      if(key)await mediaBucket(platform).delete(key).catch(()=>{});
      if(e instanceof ContextError)return fail(422,{contextError:e.code});
      throw e;
    }finally{await sql.end({timeout:1});}
  },
  addContextText:async({request,params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);
    const form=await request.formData();
    const text=String(form.get('text')??'');
    if(!text.trim())return fail(400,{contextError:'empty'});
    if(text.length>maxContextChars*1.2)return fail(422,{contextError:'tooLong'});
    const title=String(form.get('title')??'').trim().slice(0,160)||text.trim().split('\n')[0].slice(0,80);
    const sql=connect(platform);
    try{
      await requireProjectAccess(sql,params.id,u.id);
      const [{n}]=await sql<{n:number}[]>`select count(*)::int as n from sources where project_id=${params.id} and role='context'`;
      if(n>=maxContextDocs)return fail(409,{contextError:'limit'});
      const saved=await saveContext(sql,{projectId:params.id,title,kind:'text',mime:null,sizeBytes:null,mediaKey:null,pages:[{page:null,text}],extract:form.get('extract')==='on'});
      await notifyJobs(platform,'upload');
      return {contextSaved:{title,chunks:saved.chunks}};
    }catch(e){
      if(e instanceof ContextError)return fail(422,{contextError:e.code});
      throw e;
    }finally{await sql.end({timeout:1});}
  },
  removeContext:async({request,params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);
    const id=String((await request.formData()).get('sourceId')??'');
    if(!/^[a-f0-9-]{36}$/i.test(id))return fail(400,{message:'Invalid document ID'});
    const sql=connect(platform);
    try{
      await requireProjectAccess(sql,params.id,u.id);
      // Segments go with the source (on delete cascade). The role check keeps recordings out of reach of this action.
      const rows=await sql<{media_key:string|null}[]>`delete from sources where id=${id} and project_id=${params.id} and role='context' returning media_key`;
      if(!rows.length)return fail(404,{message:'Document not found'});
      if(rows[0].media_key)await mediaBucket(platform).delete(rows[0].media_key).catch(()=>{});
      // Its statements went with it. Drop the themes and insights that were left with no evidence; the rest are re-derived
      // (their basis changed) the next time an interview or document finishes, or by `npm run themes:rebuild`.
      await sql`delete from themes t where t.project_id=${params.id} and not exists (select 1 from statement_themes x where x.theme_id=t.id)`;
      await sql`delete from insights i where i.project_id=${params.id} and not exists (select 1 from insight_evidence e where e.insight_id=i.id)`;
      return {contextRemoved:id};
    }finally{await sql.end({timeout:1});}
  },
  // Sends the project report (numbers, top themes, top insights of the leading themes) to one address, in the sender's language.
  emailReport:async({request,params,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);
    const to=z.email().max(254).safeParse(String((await request.formData()).get('email')??'').trim());
    if(!to.success)return fail(400,{reportError:'badEmail'});
    const cfg=config(platform);
    if(!cfg.resendKey)return fail(503,{reportError:'notConfigured'});
    const sql=connect(platform);
    try{
      const project=await requireProjectAccess(sql,params.id,u.id);
      const data=await loadReport(sql,project,`${cfg.publicOrigin??url.origin}/dashboard/projects/${project.id}`);
      const mail=renderReport(data,(key,p)=>translate(locals.locale,key,p));
      const {error:sendError}=await new Resend(cfg.resendKey).emails.send({from:cfg.emailFrom??'Denkstelle <onboarding@resend.dev>',to:to.data,subject:mail.subject,text:mail.text,html:mail.html});
      if(sendError){console.error('[report] email failed',sendError);return fail(502,{reportError:'failed'});}
      return {reportSent:to.data};
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
