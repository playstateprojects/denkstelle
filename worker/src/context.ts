/** ingest_context: the worker half of project context documents (sources with role 'context').
 *
 * 1. Embed the document's passages, so a recording's analysis can pull in the passages it is talking about (retrieveContext).
 * 2. If the document was added with "extract", read it in windows of consecutive passages and store what the text says
 *    as statements. They join the interviews' statements in the theme and insight passes, tagged as coming from the text.
 *
 * A book is hundreds of passages, so this is resumable: each job works for a time budget (well under the queue's
 * 30-minute reaper), commits progress after every window (`analysis.cursor`), then queues its own continuation.
 * Progress and the statements it produced are written in one transaction, so a crash never duplicates a window.
 */
import {z} from 'zod';
import type {Sql} from 'postgres';
import {modelDef,llmComplete,parseJson,LlmError,type Env} from './models.ts';
import {embeddings,vector} from './utils.ts';
import {assignThemes} from './theme-match.ts';
import {rebuildInsights} from './insights.ts';
import {getActiveModel,loadPrompts,type Prompts} from './prompts.ts';
import {PermanentError,type Job} from './queue.ts';

/** Passages per extraction call: about 30,000 characters. */
export const WINDOW=24;
export const MAX_PER_WINDOW=15;
const BUDGET_MS=10*60_000;

export type Passage={id:string;sequence:number;page:number|null;text:string};
export class ContextExtractError extends LlmError{}

export function windowUser(i:{project:string;question:string;title:string;passages:Passage[]}):string{
 return `PROJECT: ${i.project}\nQUESTION: ${i.question}\nTEXT: ${i.title}\nPASSAGES WITH INDICES:\n${i.passages.map((p,n)=>`[${n}]${p.page?` (p.${p.page})`:''} ${p.text}`).join('\n')}\nReturn JSON.`;
}

const WindowOut=z.object({statements:z.array(z.object({
 text:z.string().min(8),
 passage_indexes:z.array(z.number().int().nonnegative()).default([])
})).max(60)});

/** The model proposes; code enforces. Citations are window-relative numbers mapped back to passage ids: unknown numbers
 * are dropped, a statement left with no passage is dropped, duplicates collapse, and the window is capped. */
export function groundWindow(raw:unknown,passages:Passage[]):{text:string;passageIds:string[]}[]{
 const parsed=WindowOut.safeParse(raw);
 if(!parsed.success)throw new ContextExtractError(`reference text JSON does not match the expected shape: ${parsed.error.issues.slice(0,3).map(x=>`${x.path.join('.')||'(root)'}: ${x.message}`).join('; ')}`);
 const seen=new Set<string>(),out:{text:string;passageIds:string[]}[]=[];
 for(const s of parsed.data.statements){
  const passageIds=[...new Set(s.passage_indexes)].filter(n=>n<passages.length).map(n=>passages[n].id);
  const text=s.text.trim().slice(0,500),key=text.toLowerCase();
  if(!passageIds.length||seen.has(key))continue;
  seen.add(key);out.push({text,passageIds});
  if(out.length>=MAX_PER_WINDOW)break;
 }
 return out;
}

export async function extractWindow(env:Env,modelId:string,prompts:Prompts,input:{project:string;question:string;title:string;passages:Passage[]}){
 const def=modelDef(modelId);if(!def)throw new ContextExtractError(`Unknown model "${modelId}"`);
 const out=await llmComplete(def,env,{system:prompts.text('context_system'),user:windowUser(input),temperature:prompts.number('analysis_temperature')});
 let json:unknown;
 try{json=parseJson(out.raw)}catch{throw new ContextExtractError(`${def.label} did not return valid JSON`,out.raw,out.ms)}
 return groundWindow(json,input.passages);
}

type State={chars?:number;chunks?:number;pages?:number;extract?:boolean;cursor?:number;statements?:number;done?:boolean};

export async function ingestContext(sql:Sql,job:Job):Promise<void>{
 if(!job.source_id)throw new PermanentError('ingest_context job has no source');
 const [src]=await sql<{id:string;project_id:string;title:string;role:string;status:string;analysis:State|null;question:string;project_title:string}[]>`
  select s.id,s.project_id,s.title,s.role,s.status,s.analysis,p.question,p.title as project_title
  from sources s join projects p on p.id=s.project_id where s.id=${job.source_id}`;
 if(!src)throw new PermanentError('Source no longer exists');
 if(src.role!=='context')throw new PermanentError(`Source has role "${src.role}", expected "context"`);
 // 'processing' is accepted: a continuation job finds the source where the previous job left it.
 if(src.status!=='uploaded'&&src.status!=='processing')throw new PermanentError(`Source is "${src.status}"`);
 await sql`update sources set status='processing',updated_at=now() where id=${src.id}`;
 const state:State={...(src.analysis??{})};
 const deadline=Date.now()+BUDGET_MS;
 const later=async()=>{
  // The current job is still 'running' while this insert happens; the unique index only covers 'queued' rows.
  await sql`insert into processing_jobs(source_id,kind,status) values(${src.id},'ingest_context','queued') on conflict do nothing`;
 };

 // 1. Embeddings.
 for(;;){
  const rows=await sql<{id:string;text:string}[]>`select id,text from source_segments where source_id=${src.id} and embedding is null order by sequence limit 100`;
  if(!rows.length)break;
  if(Date.now()>deadline)return later();
  const vectors=await embeddings(rows.map(r=>r.text));
  await sql.begin(async tx=>{for(let i=0;i<rows.length;i++)await tx`update source_segments set embedding=${vector(vectors[i])}::vector where id=${rows[i].id}`});
 }

 // 2. Statements from the text itself.
 if(state.extract&&!state.done){
  const modelId=await getActiveModel(sql);const prompts=await loadPrompts(sql,modelId);
  for(;;){
   const cursor=state.cursor??0;
   const passages=await sql<Passage[]>`select id,sequence,page_number as page,text from source_segments where source_id=${src.id} and sequence>=${cursor} order by sequence limit ${WINDOW}`;
   if(!passages.length)break;
   if(Date.now()>deadline)return later();
   const found=await extractWindow(process.env,modelId,prompts,{project:src.project_title,question:src.question,title:src.title,passages});
   const vectors=await embeddings(found.map(f=>f.text));
   const next:State={...state,cursor:passages[passages.length-1].sequence+1,statements:(state.statements??0)+found.length};
   await sql.begin(async tx=>{
    for(let i=0;i<found.length;i++){
     const [row]=await tx<{id:string}[]>`insert into statements(project_id,source_id,text,embedding,model_version)
      values(${src.project_id},${src.id},${found[i].text},${vector(vectors[i])}::vector,${modelId}) returning id`;
     for(const pid of found[i].passageIds)await tx`insert into statement_evidence(statement_id,segment_id) values(${row.id},${pid}) on conflict do nothing`;
    }
    await tx`update sources set analysis=${tx.json(next)},updated_at=now() where id=${src.id}`;
   });
   Object.assign(state,next);
  }
 }

 state.done=true;
 await sql`update sources set status='ready',analysis=${sql.json(state)},updated_at=now() where id=${src.id}`;
 // Like an interview, a finished document has its statements placed in themes and the touched themes' insights re-derived.
 // A failure here must not fail the job: a retry would redo nothing useful, and `npm run themes:assign` repairs it.
 if(state.statements){
  try{
   const modelId=await getActiveModel(sql);const prompts=await loadPrompts(sql,modelId);
   const t=await assignThemes(sql,process.env,modelId,prompts,src.project_id);
   for(const f of t.failed)console.error(`Statement ${f.statement} not placed in a theme; \`npm run themes:assign\` retries:`,f.error);
   const r=await rebuildInsights(sql,process.env,modelId,prompts,src.project_id);
   for(const f of r.failed)console.error(`Insights for theme "${f.theme}" failed; \`npm run themes:assign -- <projectId> --insights\` retries:`,f.error);
  }catch(e){console.error('Theme assignment failed; the document is ready, run `npm run themes:assign`:',e instanceof Error?e.message:e)}
 }
 console.log('Context ready',src.id,state.chunks,'passages',state.statements??0,'statements');
}

export type ContextHit={id:string;label:string;text:string;dist:number};
/** The closest distinct passages, best first, within a character budget. Pure. */
export function pickPassages(hits:ContextHit[],max=6,maxChars=5000):{label:string;text:string}[]{
 const best=new Map<string,ContextHit>();
 for(const h of hits){const cur=best.get(h.id);if(!cur||h.dist<cur.dist)best.set(h.id,h)}
 const out:{label:string;text:string}[]=[];let chars=0;
 for(const h of [...best.values()].sort((a,b)=>a.dist-b.dist)){
  if(out.length>=max||chars+h.text.length>maxChars)break;
  out.push({label:h.label,text:h.text});chars+=h.text.length;
 }
 return out;
}

/** Passages of the project's context documents closest to what a speaker said: for each transcript segment vector, its
 * nearest passages; then the best few overall. Returns nothing when the project has no embedded context. */
export async function retrieveContext(sql:Sql,projectId:string,vectors:number[][],opts:{perQuery?:number;max?:number;maxChars?:number;maxQueries?:number}={}):Promise<{label:string;text:string}[]>{
 const [any]=await sql<{one:number}[]>`select 1 as one from source_segments g join sources s on s.id=g.source_id
  where s.project_id=${projectId} and s.role='context' and g.embedding is not null limit 1`;
 if(!any||!vectors.length)return [];
 // A long recording has many segments: sample evenly rather than query every one.
 const cap=opts.maxQueries??40,step=Math.max(1,Math.ceil(vectors.length/cap));
 const queries=vectors.filter((_,i)=>i%step===0);
 const hits:ContextHit[]=[];
 for(let i=0;i<queries.length;i+=8){
  const batch=await Promise.all(queries.slice(i,i+8).map(v=>sql<{id:string;title:string;page:number|null;text:string;dist:number}[]>`
   select g.id,s.title,g.page_number as page,g.text,(g.embedding <=> ${vector(v)}::vector)::float8 as dist
   from source_segments g join sources s on s.id=g.source_id
   where s.project_id=${projectId} and s.role='context' and g.embedding is not null
   order by g.embedding <=> ${vector(v)}::vector limit ${opts.perQuery??3}`));
  for(const rows of batch)for(const r of rows)hits.push({id:r.id,label:`${r.title}${r.page?`, p.${r.page}`:''}`,text:r.text,dist:r.dist});
 }
 return pickPassages(hits,opts.max,opts.maxChars);
}
