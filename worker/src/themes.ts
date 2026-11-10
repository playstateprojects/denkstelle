/** Project-level theme synthesis: themes are the threads that run ACROSS interviews, and they are re-derived
 * from every statement in the project each time an interview finishes, so the list changes as the corpus grows.
 *
 * Per-interview tagging cannot do this: each transcript is analysed in isolation, so each invents its own labels
 * and nothing ever matches. Here one model call sees all statements together and groups them by underlying idea.
 * Ideas raised in only one interview are kept (MIN_SOURCES=1); themes are ranked by how many interviews raise them.
 */
import {z} from 'zod';
import type {Sql} from 'postgres';
import {modelDef,llmComplete,parseJson,LlmError,type Env} from './models.ts';
import type {Prompts} from './prompts.ts';
import {embeddings,vector} from './utils.ts';

export const MIN_SOURCES=1;

const Synthesis=z.object({themes:z.array(z.object({
  name:z.string().min(2),
  description:z.string().default(''),
  statement_ids:z.array(z.number().int().nonnegative()).min(1)
})).max(40)});

export type ThemeStatement={id:string;sourceId:string;text:string};
export type SynthesizedTheme={name:string;description:string;statementIds:string[];sourceCount:number};
export class ThemeError extends LlmError{}

export const canonical=(s:string)=>s.trim().toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N} ]/gu,'').replace(/\s+/g,' ').slice(0,90);

/** Pure step: statements in, shared themes out. Statements are numbered in the prompt, mapped back to ids here. */
export async function synthesize(env:Env,modelId:string,prompts:Prompts,input:{question:string;statements:ThemeStatement[];previous:{name:string;description:string|null}[]})
:Promise<{themes:SynthesizedTheme[];ms:number}>{
 const def=modelDef(modelId);if(!def)throw new ThemeError(`Unknown model "${modelId}"`);
 const label=new Map<string,number>();
 for(const s of input.statements)if(!label.has(s.sourceId))label.set(s.sourceId,label.size+1);
 if(label.size<MIN_SOURCES)return {themes:[],ms:0};
 const user=[
  `PROJECT QUESTION: ${input.question}`,
  `PREVIOUS THEMES:\n${input.previous.length?input.previous.map(t=>`- ${t.name}${t.description?`: ${t.description}`:''}`).join('\n'):'(none)'}`,
  `STATEMENTS:\n${input.statements.map((s,i)=>`[${i}] (I${label.get(s.sourceId)}) ${s.text}`).join('\n')}`,
  'Return JSON.'
 ].join('\n\n');
 const out=await llmComplete(def,env,{system:prompts.text('themes_system'),user,temperature:prompts.number('analysis_temperature')});
 let json:unknown;
 try{json=parseJson(out.raw)}catch{throw new ThemeError(`${def.label} did not return valid JSON`,out.raw,out.ms)}
 const parsed=Synthesis.safeParse(json);
 if(!parsed.success)throw new ThemeError(`${def.label} theme JSON does not match the expected shape: ${parsed.error.issues.slice(0,3).map(x=>`${x.path.join('.')||'(root)'}: ${x.message}`).join('; ')}`,out.raw,out.ms);
 // The model proposes; code enforces. Unknown ids are dropped, themes under MIN_SOURCES interviews are dropped (none at 1), same-name themes merge.
 const byName=new Map<string,SynthesizedTheme>();
 for(const t of parsed.data.themes){
  const name=t.name.trim().slice(0,80),key=canonical(name);if(!key)continue;
  const ids=[...new Set(t.statement_ids)].filter(i=>i<input.statements.length).map(i=>input.statements[i]);
  const merged=new Set([...(byName.get(key)?.statementIds??[]),...ids.map(s=>s.id)]);
  const sources=new Set(input.statements.filter(s=>merged.has(s.id)).map(s=>s.sourceId));
  if(sources.size<MIN_SOURCES)continue;
  byName.set(key,{name:byName.get(key)?.name??name,description:(byName.get(key)?.description||t.description).trim().slice(0,300),statementIds:[...merged],sourceCount:sources.size});
 }
 return {themes:[...byName.values()].sort((a,b)=>b.sourceCount-a.sourceCount||b.statementIds.length-a.statementIds.length),ms:out.ms};
}

/** Re-derives a project's themes from all its statements. With dryRun nothing is written (and no embeddings are made). */
export async function rebuildThemes(sql:Sql,env:Env,modelId:string,prompts:Prompts,projectId:string,opts:{dryRun?:boolean}={})
:Promise<{themes:SynthesizedTheme[];statements:ThemeStatement[];unthemed:number}>{
 const [project]=await sql<{question:string}[]>`select question from projects where id=${projectId}`;
 if(!project)throw new Error(`No project ${projectId}`);
 const rows=await sql<{id:string;source_id:string;text:string}[]>`
  select st.id,st.source_id,st.text from statements st join sources s on s.id=st.source_id
  where st.project_id=${projectId} and s.status='ready' order by s.created_at,st.created_at,st.id`;
 const statements=rows.map(r=>({id:r.id,sourceId:r.source_id,text:r.text}));
 const previous=await sql<{name:string;description:string|null}[]>`select name,description from themes where project_id=${projectId} order by name`;
 const {themes}=await synthesize(env,modelId,prompts,{question:project.question,statements,previous});
 const themed=new Set(themes.flatMap(t=>t.statementIds));
 const result={themes,statements,unthemed:statements.filter(s=>!themed.has(s.id)).length};
 if(opts.dryRun)return result;
 const vectors=await embeddings(themes.map(t=>t.description?`${t.name}: ${t.description}`:t.name));
 await sql.begin(async tx=>{
  await tx`select pg_advisory_xact_lock(hashtext(${'themes:'+projectId}))`;
  await tx`delete from statement_themes where statement_id in (select id from statements where project_id=${projectId})`;
  for(let i=0;i<themes.length;i++){
   const t=themes[i];
   // Same canonical name keeps the same row, so a theme that survives a rebuild keeps its identity.
   const [row]=await tx<{id:string}[]>`insert into themes(project_id,canonical,name,description,embedding)
    values(${projectId},${canonical(t.name)},${t.name},${t.description||null},${vector(vectors[i])}::vector)
    on conflict(project_id,canonical) do update set name=excluded.name,description=excluded.description,embedding=excluded.embedding returning id`;
   for(const sid of t.statementIds)await tx`insert into statement_themes(statement_id,theme_id) values(${sid},${row.id}) on conflict do nothing`;
  }
  await tx`delete from themes t where t.project_id=${projectId} and not exists (select 1 from statement_themes st where st.theme_id=t.id)`;
 });
 return result;
}
