/** transcribe_and_ingest: FFmpeg audio extraction, Whisper, DeepSeek statement extraction, embeddings, graph ingestion.
 * Runs OUTSIDE the SvelteKit Worker (FFmpeg is needed): in the container, or locally via `npm run process:once`.
 * Claiming, retries and job/source status transitions live in queue.ts; this file only does the work and throws on failure.
 */
import {readFile,rm} from 'node:fs/promises';
import {join,extname} from 'node:path';
import type {Sql} from 'postgres';
import {downloadObject,tempWorkspace,ffmpeg,cloudflareAI,embeddings,vector} from './utils.ts';
import {analyze} from './analysis.ts';
import {rebuildThemes} from './themes.ts';
import {getActiveModel,loadPrompts} from './prompts.ts';
import {PermanentError,type Job} from './queue.ts';

function parseVtt(vtt:string){
 const lines=vtt.replace(/\r/g,'').split('\n');const out:{start:number;end:number;text:string}[]=[];
 const stamp=(v:string)=>{const parts=v.replace(',','.').split(':').map(Number);return parts.reduce((a,n)=>a*60+n,0)};
 for(let i=0;i<lines.length;i++){
   const match=lines[i].match(/((?:\d+:)?\d\d:\d\d[.,]\d+)\s+-->\s+((?:\d+:)?\d\d:\d\d[.,]\d+)/);
   if(match){let txt='';while(++i<lines.length&&lines[i].trim())txt+=(txt?' ':'')+lines[i].replace(/<[^>]*>/g,'');out.push({start:stamp(match[1]),end:stamp(match[2]),text:txt});}
 }
 return out;
}
type Segment={start_ms:number;end_ms:number;text:string};
function normalizeSegments(result:any):Segment[]{
 const raw:any[]=Array.isArray(result?.segments)?result.segments:parseVtt(result?.vtt??'');
 return raw.map((s:any)=>({start_ms:Math.round(Number(s.start)*1000),end_ms:Math.round(Number(s.end)*1000),text:String(s.text??'').trim()}))
 .filter((s:Segment)=>s.text&&Number.isFinite(s.start_ms)&&Number.isFinite(s.end_ms)&&s.end_ms>s.start_ms);
}

export async function ingest(sql:Sql,job:Job):Promise<void>{
 const [source]=await sql<{media_key:string;mime_type:string;project_id:string;status:string;question:string;title:string;contributor_label:string|null}[]>`
  select s.media_key,s.mime_type,s.project_id,s.status,s.contributor_label,p.question,p.title
  from sources s join projects p on p.id=s.project_id where s.id=${job.source_id}`;
 if(!source)throw new PermanentError('Source no longer exists');
 if(source.status!=='uploaded')throw new PermanentError(`Source is "${source.status}", expected "uploaded"`);
 await sql`update sources set status='processing',updated_at=now() where id=${job.source_id}`;
 let tmp='';
 try{
   tmp=await tempWorkspace();const video=join(tmp,`original${extname(source.media_key)}`);const audio=join(tmp,'speech.mp3');
   await downloadObject(source.media_key,video);
   await ffmpeg('-i',video,'-vn','-ac','1','-ar','16000','-c:a','libmp3lame','-b:a','48k',audio);
   const data=await readFile(audio);
   // Cloudflare Whisper supports an audio base64 input; MP3 is demuxed, never raw video bytes.
   const transcription=await cloudflareAI('@cf/openai/whisper-large-v3-turbo',{audio:data.toString('base64'),task:'transcribe'});
   const segments=normalizeSegments(transcription);
   if(!segments.length)throw new Error('Whisper returned no timed segments; refusing to invent timestamps');
   // The model and its prompts are chosen in /admin/prompts; each model has its own prompt versions.
   const modelId=await getActiveModel(sql);const prompts=await loadPrompts(sql,modelId);
   const {extracted}=await analyze(process.env,modelId,prompts,{title:source.title,question:source.question,speakerName:source.contributor_label??undefined,texts:segments.map(s=>s.text)});
   const cleaned=extracted.statements.map(s=>({...s,segment_indexes:[...new Set(s.segment_indexes)].filter(i=>i<segments.length)})).filter(s=>s.segment_indexes.length);
   const vectors=await embeddings([...segments.map(s=>s.text),...cleaned.map(s=>s.text)]);
   const segmentVectors=vectors.slice(0,segments.length),statementVectors=vectors.slice(segments.length);
   // Reruns of the same source replace its derived analysis, never the original video.
   await sql`delete from highlights where source_id=${job.source_id} and status='suggested'`;
   await sql`delete from statements where source_id=${job.source_id}`;
   await sql`delete from source_segments where source_id=${job.source_id}`;
   const ids:string[]=[];
   for(let i=0;i<segments.length;i++){
     const s=segments[i];const rows=await sql<{id:string}[]>`insert into source_segments(source_id,sequence,start_ms,end_ms,text,embedding)
       values(${job.source_id},${i},${s.start_ms},${s.end_ms},${s.text},${vector(segmentVectors[i])}::vector) returning id`;
     ids.push(rows[0].id);
   }
   for(let i=0;i<cleaned.length;i++){
     const claim=cleaned[i];const [statement]=await sql<{id:string}[]>`insert into statements(project_id,source_id,text,embedding,model_version)
       values(${source.project_id},${job.source_id},${claim.text},${vector(statementVectors[i])}::vector,${modelId}) returning id`;
     for(const index of claim.segment_indexes)await sql`insert into statement_evidence(statement_id,segment_id) values(${statement.id},${ids[index]}) on conflict do nothing`;
   }
   // Create one montage proposal from up to three authentic, non-overlapping excerpts.
   const proposed:{start_ms:number;end_ms:number;title:string;reason:string}[]=[];
   let totalMs=0;
   for(const h of extracted.highlights){
     const start=segments[h.start_segment],end=segments[h.end_segment];
     if(!start||!end||end.end_ms<=start.start_ms||end.end_ms-start.start_ms>60000)continue;
     const ms=end.end_ms-start.start_ms;if(totalMs+ms>90000)continue;
     proposed.push({start_ms:start.start_ms,end_ms:end.end_ms,title:h.title.slice(0,160),reason:h.reason.slice(0,500)});
     totalMs+=ms;if(proposed.length>=3)break;
   }
   if(proposed.length){
     const low=Math.min(...proposed.map(h=>h.start_ms)),high=Math.max(...proposed.map(h=>h.end_ms));
     await sql`insert into highlights(source_id,title,reason,start_ms,end_ms,clips,status)
       values(${job.source_id},'Die besten Gedanken',${proposed.map(p=>p.reason).join(' / ').slice(0,500)},${low},${high},${sql.json(proposed)},'suggested')`;
   }
   const newTitle=extracted.title.trim().slice(0,120);
   await sql`update sources set status='ready',title=coalesce(nullif(${newTitle},''),title),analysis=${sql.json({title:newTitle,summary:extracted.summary,statements:cleaned.length,segments:segments.length,model:modelId,promptVersions:prompts.versions})},processing_model=${'whisper-large-v3-turbo + '+modelId},updated_at=now() where id=${job.source_id}`;
   // Themes are shared threads across ALL interviews, so they are re-derived now that this one is ready.
   // A failure here must not fail the job: a retry would redo the whole transcription. `npm run themes:rebuild` repairs it.
   try{await rebuildThemes(sql,process.env,modelId,prompts,source.project_id)}
   catch(e){console.error('Theme synthesis failed; interview is ready, run `npm run themes:rebuild`:',e instanceof Error?e.message:e)}
   // Deterministic aggregates, never fabricate agreement/contestation from raw counts.
   const counts=await sql<{name:string;mentions:number}[]>`select t.name,count(distinct st.source_id)::int as mentions from themes t join statement_themes x on x.theme_id=t.id join statements st on st.id=x.statement_id where t.project_id=${source.project_id} group by t.id order by mentions desc limit 20`;
   const total=await sql<{n:number}[]>`select count(*)::int as n from sources where project_id=${source.project_id} and status='ready' and role='contribution'`;
   const report={sourceCount:total[0]?.n??0,commonThemes:counts,latestSourceSummary:extracted.summary,agreementNotes:'Theme frequency is not evidence of agreement; review the original statements.',generatedAt:new Date().toISOString()};
   await sql`insert into project_reports(project_id,report,model_version) values(${source.project_id},${sql.json(report)},'deterministic-v1')`;
   console.log('Processed',job.source_id,segments.length,'segments',cleaned.length,'statements');
 }finally{if(tmp)await rm(tmp,{recursive:true,force:true});}
}
