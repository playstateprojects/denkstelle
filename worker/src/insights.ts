/** Insights: what a theme's statements add up to. One model call per theme sees that theme's statements and
 * derives insights, each citing the statements it rests on, so every insight links back through
 * statement_evidence to the transcript segments and the recording.
 *
 * Insights are re-derived, never edited. A theme is skipped while its basis (model, prompt version, statement set)
 * is unchanged, so an ingest only pays for the themes it actually touched.
 */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Sql} from 'postgres';
import {modelDef,llmComplete,parseJson,LlmError,type Env} from './models.ts';
import type {Prompts} from './prompts.ts';
import {sourceLabels,textNote} from './labels.ts';

export const MAX_PER_THEME=3;
/** A theme with fewer statements gets no insights: there is nothing to derive beyond the statements themselves. */
export const MIN_STATEMENTS=3;
/** An insight must connect at least this many statements; citing one is a paraphrase of it. */
export const MIN_EVIDENCE=2;
/** Part of every basis. Bump when the rules in this file or the default prompt change, so existing insights are re-derived. */
const RULES='r4';

const Derived=z.object({insights:z.array(z.object({
  title:z.string().min(2),
  description:z.string().default(''),
  statement_ids:z.array(z.number().int().nonnegative()).default([])
}))});

/** `fromText`: read from the project's reference text (role 'context'), not said by an interviewee. */
export type InsightStatement={id:string;sourceId:string;text:string;fromText?:boolean;sourceTitle?:string};
export type InsightTheme={name:string;description:string|null};
export type DerivedInsight={title:string;description:string;statementIds:string[]};
export class InsightError extends LlmError{}

/** The model proposes; code enforces. Citations are prompt numbers mapped back to statement ids: unknown numbers
 * are dropped, and an insight left with fewer than MIN_EVIDENCE statements is dropped with them. */
export function ground(raw:unknown,statements:InsightStatement[]):DerivedInsight[]{
 const parsed=Derived.safeParse(raw);
 if(!parsed.success)throw new InsightError(`insight JSON does not match the expected shape: ${parsed.error.issues.slice(0,3).map(x=>`${x.path.join('.')||'(root)'}: ${x.message}`).join('; ')}`);
 const out:DerivedInsight[]=[];
 for(const i of parsed.data.insights){
  const statementIds=[...new Set(i.statement_ids)].filter(n=>n<statements.length).map(n=>statements[n].id);
  if(statementIds.length<MIN_EVIDENCE)continue;
  out.push({title:i.title.trim().slice(0,160),description:i.description.trim().slice(0,600),statementIds});
  if(out.length>=MAX_PER_THEME)break;
 }
 return out;
}

/** Changes whenever the insights of a theme would: other statements, another model or another prompt version. */
export function basis(modelId:string,promptVersion:number,statementIds:string[]):string{
 return `${modelId}:${promptVersion}:${RULES}:${createHash('sha256').update([...statementIds].sort().join(',')).digest('hex').slice(0,32)}`;
}

export async function derive(env:Env,modelId:string,prompts:Prompts,input:{question:string;theme:InsightTheme;statements:InsightStatement[]}):Promise<DerivedInsight[]>{
 const def=modelDef(modelId);if(!def)throw new InsightError(`Unknown model "${modelId}"`);
 const label=sourceLabels(input.statements);
 const user=[
  `PROJECT QUESTION: ${input.question}`,
  `THEME: ${input.theme.name}${input.theme.description?`: ${input.theme.description}`:''}`,
  ...[textNote(input.statements,label)].filter((x):x is string=>!!x),
  `STATEMENTS:\n${input.statements.map((s,i)=>`[${i}] (${label.get(s.sourceId)}) ${s.text}`).join('\n')}`,
  'Return JSON.'
 ].join('\n\n');
 const out=await llmComplete(def,env,{system:prompts.text('insights_system'),user,temperature:prompts.number('analysis_temperature')});
 let json:unknown;
 try{json=parseJson(out.raw)}catch{throw new InsightError(`${def.label} did not return valid JSON`,out.raw,out.ms)}
 return ground(json,input.statements);
}

/** Re-derives the insights of every theme in a project whose basis changed (all of them with `force`).
 * One theme failing does not stop the others; it keeps its previous insights and is retried next time. */
export async function rebuildInsights(sql:Sql,env:Env,modelId:string,prompts:Prompts,projectId:string,opts:{force?:boolean}={})
:Promise<{themes:number;rebuilt:number;insights:number;failed:{theme:string;error:string}[]}>{
 const [project]=await sql<{question:string}[]>`select question from projects where id=${projectId}`;
 if(!project)throw new Error(`No project ${projectId}`);
 const themes=await sql<{id:string;name:string;description:string|null;insight_basis:string|null}[]>`
  select id,name,description,insight_basis from themes where project_id=${projectId} order by name`;
 const rows=await sql<{theme_id:string;id:string;source_id:string;text:string;from_text:boolean;source_title:string}[]>`
  select x.theme_id,st.id,st.source_id,st.text,s.role='context' as from_text,s.title as source_title from statement_themes x join statements st on st.id=x.statement_id
  join sources s on s.id=st.source_id where st.project_id=${projectId} and s.status='ready' order by s.created_at,st.created_at,st.id`;
 const result={themes:themes.length,rebuilt:0,insights:0,failed:[] as {theme:string;error:string}[]};
 for(const theme of themes){
  const statements=rows.filter(r=>r.theme_id===theme.id).map(r=>({id:r.id,sourceId:r.source_id,text:r.text,fromText:r.from_text,sourceTitle:r.source_title}));
  const next=basis(modelId,prompts.versions.insights_system??0,statements.map(s=>s.id));
  if(!opts.force&&theme.insight_basis===next)continue;
  try{
   const insights=statements.length>=MIN_STATEMENTS?await derive(env,modelId,prompts,{question:project.question,theme,statements}):[];
   await sql.begin(async tx=>{
    await tx`delete from insights where theme_id=${theme.id}`;
    for(const i of insights){
     const [row]=await tx<{id:string}[]>`insert into insights(project_id,theme_id,title,description,model_version)
      values(${projectId},${theme.id},${i.title},${i.description},${modelId}) returning id`;
     for(const sid of i.statementIds)await tx`insert into insight_evidence(insight_id,statement_id) values(${row.id},${sid}) on conflict do nothing`;
    }
    await tx`update themes set insight_basis=${next} where id=${theme.id}`;
   });
   result.rebuilt++;result.insights+=insights.length;
  }catch(e){result.failed.push({theme:theme.name,error:e instanceof Error?e.message:String(e)})}
 }
 return result;
}
