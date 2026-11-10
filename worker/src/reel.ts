/** Theme reels: compose a highlight reel ACROSS interviews, then render it.
 *
 * compose_reel is a pipeline of small steps, each one a function so it can be swapped while experimenting:
 *   1. topThemes     deterministic: themes ranked by how many consenting interviews raise them
 *   2. candidates    for each theme, windows of transcript that carry it: the statement evidence plus the
 *                    segments semantically nearest the theme's embedding
 *   3. rate          LLM, one call per theme: rates every candidate on four criteria (prompt: reel_rate_system)
 *   4. select        deterministic: weights the ratings into a score, then picks within the time budget,
 *                    preferring different speakers
 *   5. arrange       LLM: running order, title, summary (prompt: reel_arrange_system); code validates the order
 * The model proposes ratings and an order; code owns the weights, the budget, consent and every id.
 * Nothing here is invented speech: every clip is a time span of a real recording.
 *
 * render_reel cuts the included clips (with captions) into one 9:16 MP4 in private R2.
 */
import {join,extname} from 'node:path';
import {rm} from 'node:fs/promises';
import {z} from 'zod';
import type {Sql} from 'postgres';
import {modelDef,llmComplete,parseJson,LlmError,DEFAULT_MODEL,type Env} from './models.ts';
import {getActiveModel,loadPrompts,type Prompts} from './prompts.ts';
import {downloadObject,uploadObject,tempWorkspace} from './utils.ts';
import {renderPart,concatParts} from './render.ts';
import {PermanentError,type Job} from './queue.ts';

export type ReelParams={target_ms:number;themes:number;min_score:number;model?:string};
export const DEFAULT_PARAMS:ReelParams={target_ms:60000,themes:5,min_score:3};
export const clampParams=(p:Partial<ReelParams>):ReelParams=>({
  target_ms:Math.min(180000,Math.max(20000,Math.round(Number(p.target_ms)||DEFAULT_PARAMS.target_ms))),
  themes:Math.min(8,Math.max(1,Math.round(Number(p.themes)||DEFAULT_PARAMS.themes))),
  min_score:Math.min(5,Math.max(1,Number(p.min_score)||DEFAULT_PARAMS.min_score)),
  model:p.model&&modelDef(p.model)?p.model:undefined
});

const MIN_SNIPPET_MS=4000,MAX_SNIPPET_MS=35000,PER_THEME=6,SEMANTIC_PER_THEME=6;
export const WEIGHTS={relevance:.35,standalone:.25,insight:.2,vividness:.2} as const;
export type Criterion=keyof typeof WEIGHTS;

type Seg={start_ms:number;end_ms:number;text:string};
type Theme={id:string;name:string;description:string|null;sources:number};
export type Candidate={source_id:string;lo:number;hi:number;start_ms:number;end_ms:number;text:string;weight:number};
type Rated=Candidate&{ratings:Record<Criterion,number>;score:number;rationale:string;theme:Theme};

const Ratings=z.object({ratings:z.array(z.object({
  snippet:z.number().int().nonnegative(),
  relevance:z.number().min(1).max(5),standalone:z.number().min(1).max(5),insight:z.number().min(1).max(5),vividness:z.number().min(1).max(5),
  rationale:z.string().default('')
}))});
const Arrangement=z.object({title:z.string().min(2),summary:z.string().default(''),order:z.array(z.number().int().nonnegative())});

export const score=(r:Record<Criterion,number>)=>Math.round((Object.keys(WEIGHTS) as Criterion[]).reduce((a,k)=>a+WEIGHTS[k]*r[k],0)*100)/100;

/** Sources that may appear in a reel: ready contributions with a still-valid public-excerpt permission. */
async function eligibleSources(sql:Sql,projectId:string):Promise<string[]>{
  const rows=await sql<{id:string}[]>`select s.id from sources s
    join source_permissions p on p.source_id=s.id and p.purpose='public_excerpt' and p.allowed and p.withdrawn_at is null
    where s.project_id=${projectId} and s.status='ready' and s.role='contribution' and s.media_key is not null`;
  return rows.map(r=>r.id);
}

/** Step 1. Ranked by distinct consenting interviews, then by statement count. */
export async function topThemes(sql:Sql,projectId:string,sourceIds:string[],n:number):Promise<Theme[]>{
  return sql<Theme[]>`select t.id,t.name,t.description,count(distinct st.source_id)::int as sources
    from themes t join statement_themes x on x.theme_id=t.id join statements st on st.id=x.statement_id
    where t.project_id=${projectId} and st.source_id in ${sql(sourceIds)}
    group by t.id order by sources desc,count(distinct st.id) desc,t.name limit ${n}`;
}

/** A transcript window around segments lo..hi: one neighbour of context each side, kept within the length limits. */
export function windowAround(segs:Seg[],lo:number,hi:number):{lo:number;hi:number}|null{
  if(!segs[lo]||!segs[hi])return null;
  lo=Math.max(0,lo-1);hi=Math.min(segs.length-1,hi+1);
  const len=()=>segs[hi].end_ms-segs[lo].start_ms;
  while(len()>MAX_SNIPPET_MS&&hi>lo)hi--;
  while(len()<MIN_SNIPPET_MS&&hi<segs.length-1)hi++;
  return len()>=MIN_SNIPPET_MS/2&&len()<=MAX_SNIPPET_MS?{lo,hi}:null;
}

/** Step 2. Non-overlapping windows for one theme: statement evidence first (a model already tied it to the theme),
 * then the segments nearest the theme's embedding, which finds apt passages no statement happened to cite. */
async function candidatesFor(sql:Sql,theme:Theme,sourceIds:string[],segments:Map<string,Seg[]>):Promise<Candidate[]>{
  const raw:{source_id:string;lo:number;hi:number;weight:number}[]=[];
  const evidence=await sql<{source_id:string;seqs:number[]}[]>`
    select st.source_id,array_agg(seg.sequence order by seg.sequence) as seqs
    from statement_themes x join statements st on st.id=x.statement_id
    join statement_evidence e on e.statement_id=st.id join source_segments seg on seg.id=e.segment_id
    where x.theme_id=${theme.id} and st.source_id in ${sql(sourceIds)} group by x.statement_id,st.source_id`;
  for(const e of evidence)raw.push({source_id:e.source_id,lo:Math.min(...e.seqs),hi:Math.max(...e.seqs),weight:2+e.seqs.length});
  const near=await sql<{source_id:string;sequence:number}[]>`
    select seg.source_id,seg.sequence from source_segments seg join themes t on t.id=${theme.id}
    where seg.source_id in ${sql(sourceIds)} and seg.embedding is not null and t.embedding is not null and seg.start_ms is not null
    order by seg.embedding<=>t.embedding limit ${SEMANTIC_PER_THEME}`;
  for(const n of near)raw.push({source_id:n.source_id,lo:n.sequence,hi:n.sequence,weight:1});
  const out:Candidate[]=[];
  for(const r of raw.sort((a,b)=>b.weight-a.weight)){
    const segs=segments.get(r.source_id);const w=segs&&windowAround(segs,r.lo,r.hi);
    if(!segs||!w)continue;
    if(out.some(o=>o.source_id===r.source_id&&o.lo<=w.hi&&w.lo<=o.hi))continue;
    out.push({source_id:r.source_id,lo:w.lo,hi:w.hi,start_ms:segs[w.lo].start_ms,end_ms:segs[w.hi].end_ms,
      text:segs.slice(w.lo,w.hi+1).map(s=>s.text).join(' ').replace(/\s+/g,' ').trim(),weight:r.weight});
    if(out.length>=PER_THEME)break;
  }
  return out;
}

/** Step 3. One call per theme. Unknown snippet numbers are ignored; an unrated candidate is simply not eligible. */
export async function rate(env:Env,modelId:string,prompts:Prompts,theme:Theme,cands:Candidate[]):Promise<{rated:Rated[];ms:number}>{
  const def=modelDef(modelId);if(!def)throw new LlmError(`Unknown model "${modelId}"`);
  if(!cands.length)return {rated:[],ms:0};
  const user=`THEME: ${theme.name}${theme.description?` — ${theme.description}`:''}\n\nSNIPPETS:\n${cands.map((c,i)=>`[${i}] (${Math.round((c.end_ms-c.start_ms)/1000)}s) ${c.text}`).join('\n')}\n\nReturn JSON.`;
  const out=await llmComplete(def,env,{system:prompts.text('reel_rate_system'),user,temperature:prompts.number('analysis_temperature')});
  let json:unknown;try{json=parseJson(out.raw)}catch{throw new LlmError(`${def.label} did not return valid JSON for theme "${theme.name}"`,out.raw,out.ms)}
  const parsed=Ratings.safeParse(json);
  if(!parsed.success)throw new LlmError(`${def.label} ratings do not match the expected shape: ${parsed.error.issues.slice(0,3).map(x=>`${x.path.join('.')||'(root)'}: ${x.message}`).join('; ')}`,out.raw,out.ms);
  const seen=new Set<number>(),rated:Rated[]=[];
  for(const r of parsed.data.ratings){
    const c=cands[r.snippet];if(!c||seen.has(r.snippet))continue;seen.add(r.snippet);
    const ratings={relevance:r.relevance,standalone:r.standalone,insight:r.insight,vividness:r.vividness};
    rated.push({...c,ratings,score:score(ratings),rationale:r.rationale.slice(0,300),theme});
  }
  return {rated,ms:out.ms};
}

/** Step 4. Pure. First the best clip of each theme from a different speaker where possible, then fill the remaining
 * time with the strongest clips, discounting speakers already heard. Never exceeds the budget by more than 10%. */
export function select(byTheme:Rated[][],p:Pick<ReelParams,'target_ms'|'min_score'>):Rated[]{
  const dur=(c:Rated)=>c.end_ms-c.start_ms,overlaps=(a:Rated,b:Rated)=>a.source_id===b.source_id&&a.lo<=b.hi&&b.lo<=a.hi;
  const limit=p.target_ms*1.1;
  const chosen:Rated[]=[];let total=0;
  const heard=(c:Rated)=>chosen.filter(x=>x.source_id===c.source_id).length;
  const fits=(c:Rated)=>total+dur(c)<=limit&&!chosen.some(x=>overlaps(x,c));
  for(const pool of byTheme){
    const options=pool.filter(c=>c.score>=p.min_score&&fits(c)).sort((a,b)=>(heard(a)-heard(b))||b.score-a.score);
    if(options[0]){chosen.push(options[0]);total+=dur(options[0]);}
  }
  const rest=()=>byTheme.flat().filter(c=>c.score>=p.min_score&&!chosen.includes(c)&&fits(c));
  for(let pool=rest();pool.length&&total<p.target_ms;pool=rest()){
    pool.sort((a,b)=>(b.score-.5*heard(b))-(a.score-.5*heard(a)));
    chosen.push(pool[0]);total+=dur(pool[0]);
  }
  return chosen;
}

/** Step 5. The model orders; this accepts the order only if it is a permutation, else keeps theme order. */
export async function arrange(env:Env,modelId:string,prompts:Prompts,clips:Rated[]):Promise<{title:string;summary:string;order:number[];ms:number;fallback:boolean}>{
  const identity=clips.map((_,i)=>i);
  if(clips.length<2)return {title:clips[0]?.theme.name??'',summary:'',order:identity,ms:0,fallback:true};
  const def=modelDef(modelId);if(!def)throw new LlmError(`Unknown model "${modelId}"`);
  const user=`CLIPS:\n${clips.map((c,i)=>`[${i}] theme: ${c.theme.name}\n${c.text}`).join('\n\n')}\n\nReturn JSON.`;
  const out=await llmComplete(def,env,{system:prompts.text('reel_arrange_system'),user,temperature:prompts.number('analysis_temperature')});
  let json:unknown;try{json=parseJson(out.raw)}catch{throw new LlmError(`${def.label} did not return valid JSON for the arrangement`,out.raw,out.ms)}
  const parsed=Arrangement.safeParse(json);
  if(!parsed.success)throw new LlmError(`${def.label} arrangement does not match the expected shape`,out.raw,out.ms);
  const o=parsed.data.order,valid=o.length===clips.length&&new Set(o).size===clips.length&&o.every(i=>i<clips.length);
  return {title:parsed.data.title.slice(0,120),summary:parsed.data.summary.slice(0,600),order:valid?o:identity,ms:out.ms,fallback:!valid};
}

export async function composeReel(sql:Sql,env:Env,reelId:string):Promise<void>{
  const [reel]=await sql<{project_id:string;params:Partial<ReelParams>;status:string}[]>`select project_id,params,status from reels where id=${reelId}`;
  if(!reel)throw new PermanentError('Reel no longer exists');
  const params=clampParams(reel.params);
  await sql`update reels set status='composing',error=null where id=${reelId}`;
  try{
    const sourceIds=await eligibleSources(sql,reel.project_id);
    if(!sourceIds.length)throw new PermanentError('No analysed recordings with public-excerpt permission in this project');
    const themes=await topThemes(sql,reel.project_id,sourceIds,params.themes);
    if(!themes.length)throw new PermanentError('No themes yet. Process at least one interview, or run `npm run themes:rebuild`');
    const modelId=params.model??await getActiveModel(sql)??DEFAULT_MODEL;
    const prompts=await loadPrompts(sql,modelId);
    const segRows=await sql<{source_id:string;sequence:number;start_ms:number;end_ms:number;text:string}[]>`
      select source_id,sequence,start_ms,end_ms,text from source_segments where source_id in ${sql(sourceIds)} and start_ms is not null and end_ms is not null order by source_id,sequence`;
    const segments=new Map<string,Seg[]>();
    for(const r of segRows){const a=segments.get(r.source_id)??[];a[r.sequence]=r;segments.set(r.source_id,a);}
    // Sequences are contiguous from ingest; a gap would break windowing, so such a source is skipped.
    for(const [id,a] of segments)if(a.some(x=>!x))segments.delete(id);

    const trace:{model:string;themes:unknown[];ms:Record<string,number>;arrangeFallback?:boolean}={model:modelId,themes:[],ms:{rate:0,arrange:0}};
    const byTheme:Rated[][]=[];
    for(const theme of themes){
      const cands=await candidatesFor(sql,theme,sourceIds,segments);
      const {rated,ms}=await rate(env,modelId,prompts,theme,cands);
      trace.ms.rate+=ms;byTheme.push(rated);
      trace.themes.push({id:theme.id,name:theme.name,interviews:theme.sources,candidates:cands.length,rated:rated.length,best:Math.max(0,...rated.map(r=>r.score))});
    }
    const chosen=select(byTheme,params);
    if(!chosen.length)throw new PermanentError(`No snippet scored at least ${params.min_score}. Lower the minimum score or add interviews`);
    const arr=await arrange(env,modelId,prompts,chosen);
    trace.ms.arrange=arr.ms;trace.arrangeFallback=arr.fallback;
    await sql.begin(async tx=>{
      await tx`delete from reel_clips where reel_id=${reelId}`;
      for(let pos=0;pos<arr.order.length;pos++){
        const c=chosen[arr.order[pos]];
        await tx`insert into reel_clips(reel_id,position,source_id,theme_id,theme_name,start_ms,end_ms,text,score,ratings,rationale)
          values(${reelId},${pos},${c.source_id},${c.theme.id},${c.theme.name},${c.start_ms},${c.end_ms},${c.text},${c.score},${tx.json(c.ratings)},${c.rationale||null})`;
      }
      await tx`update reels set status='composed',title=${arr.title||chosen[0].theme.name},summary=${arr.summary||null},trace=${tx.json(trace as never)},error=null where id=${reelId}`;
    });
    console.log('Composed reel',reelId,chosen.length,'clips from',themes.length,'themes');
  }catch(e){
    if(e instanceof PermanentError)await sql`update reels set status='failed',error=${e.message} where id=${reelId}`;
    throw e;
  }
}

export async function renderReel(sql:Sql,reelId:string):Promise<void>{
  const [reel]=await sql<{project_id:string}[]>`select project_id from reels where id=${reelId} and status in ('composed','rendering','rendered','failed')`;
  if(!reel)throw new PermanentError('Reel is not composed');
  // Consent is checked again now, not trusted from composition time: it may have been withdrawn since.
  const clips=await sql<{source_id:string;start_ms:number;end_ms:number;media_key:string;mime_type:string|null}[]>`
    select c.source_id,c.start_ms,c.end_ms,s.media_key,s.mime_type from reel_clips c join sources s on s.id=c.source_id
    join source_permissions p on p.source_id=s.id and p.purpose='public_excerpt' and p.allowed and p.withdrawn_at is null
    where c.reel_id=${reelId} and c.included and s.status='ready' and s.media_key is not null order by c.position`;
  const [{wanted}]=await sql<{wanted:number}[]>`select count(*)::int as wanted from reel_clips where reel_id=${reelId} and included`;
  if(!clips.length)throw new PermanentError('No included clips to render');
  if(clips.length<wanted)throw new PermanentError('A source lost its publication permission or was deleted. Recompose the reel');
  await sql`update reels set status='rendering',error=null where id=${reelId}`;
  let temp='';
  try{
    temp=await tempWorkspace();
    const files=new Map<string,string>();
    for(const c of clips)if(!files.has(c.source_id)){
      const f=join(temp,`src-${files.size}${extname(c.media_key)}`);await downloadObject(c.media_key,f);files.set(c.source_id,f);
    }
    const parts:string[]=[];
    for(let i=0;i<clips.length;i++){
      const c=clips[i],part=join(temp,`part-${i}.mp4`);
      await renderPart(sql,{sourceId:c.source_id,src:files.get(c.source_id)!,mime:c.mime_type,start_ms:c.start_ms,end_ms:c.end_ms,dir:temp,name:`captions-${i}`,part});
      parts.push(part);
    }
    const out=join(temp,'reel.mp4');await concatParts(parts,temp,out);
    const key=`projects/${reel.project_id}/reels/${reelId}.mp4`;await uploadObject(key,out,'video/mp4');
    await sql`update reels set media_key=${key},status='rendered' where id=${reelId}`;
    console.log('Rendered reel privately:',reelId,key);
  }catch(e){
    if(e instanceof PermanentError)await sql`update reels set status='failed',error=${e.message} where id=${reelId}`;
    throw e;
  }finally{if(temp)await rm(temp,{recursive:true,force:true});}
}

export async function compose(sql:Sql,job:Job):Promise<void>{
  if(!job.reel_id)throw new PermanentError('compose_reel job has no reel_id');
  await composeReel(sql,process.env,job.reel_id);
}
export async function renderReelJob(sql:Sql,job:Job):Promise<void>{
  if(!job.reel_id)throw new PermanentError('render_reel job has no reel_id');
  await renderReel(sql,job.reel_id);
}
