/** The prompts the analysis runs on, where they live, and which model the pipeline uses.
 *
 * Each prompt is a named, versioned row in `prompts` (db/006_admin_prompts.sql), kept PER MODEL so
 * Mistral and DeepSeek can each be tuned separately. Exactly one version per (model, key) is active.
 * The defaults below run when a (model, key) has no active row, or before the table exists.
 * Manage them at /admin/prompts.
 */
import type {Sql} from 'postgres';
import {DEFAULT_MODEL,modelDef} from './models.ts';

export type PromptKind='text'|'number';
export type PromptDef={key:string;label:string;kind:PromptKind;help:string;default:string};

export const PROMPT_DEFS=[
 {key:'analysis_system',label:'Interview analysis',kind:'text',
  help:'System prompt for the transcript analysis: summary, statements with cited segments and highlight passages. Themes are NOT extracted here; they are derived across all interviews by the "Shared themes" prompt. Must keep asking for the JSON shape below, or ingestion rejects the answer.',
  default:`You are an evidence-first qualitative interview analyst. Produce valid JSON only:
{"title":"...","summary":"...","statements":[{"text":"faithful concise paraphrase","segment_indexes":[0]}],"highlights":[{"start_segment":0,"end_segment":2,"title":"...","reason":"..."}]}.
Every claim MUST be directly supported by the cited numbered transcript segments. Do not invent a quotation, person, implication, agreement or disagreement. Preserve negations and uncertainty. 3-12 meaningful statements, not trivia. Each statement must stand on its own: name the concern or idea explicitly rather than relying on "this" or "that". Choose up to 3 compelling 8-45-second contiguous video passages, with authentic speech and strong narrative potential. The title is 3-8 words naming what this recording is about, in the language of the transcript, neutral, without the speaker's name. Do not infer demographics or sensitive traits. If a SPEAKER NAME is given, refer to the speaker by that name in the summary and statements instead of "the speaker"; otherwise use neutral wording. Use the name only as a label, never infer anything from it.`},
 {key:'themes_system',label:'Shared themes',kind:'text',
  help:'System prompt for the project-wide theme pass, which runs after every finished interview over ALL statements and re-derives the themes. The sample tester does not exercise this prompt. Must keep asking for the JSON shape below.',
  default:`You find the themes shared ACROSS a set of interviews. Input: numbered statements, each tagged with the interview it came from (I1, I2, ...). Produce valid JSON only:
{"themes":[{"name":"2-6 word label","description":"one neutral sentence describing the thread","statement_ids":[0,4,7]}]}.
Rules:
- A theme is a concern, argument or experience that at least TWO different interviews touch on, even when their surface topics differ. Look for the underlying thread, not shared keywords: an interview about children being shown AI nature images that may be hallucinated and another about a child's AI-generated colouring book share the thread "children absorbing unreliable AI content".
- Every substantive idea gets surfaced. If a thread appears in only one interview, it still becomes its own theme; do not drop it or force it into an unrelated shared theme. Only small talk and check-ins belong to no theme.
- Shared threads come first: before creating a one-interview theme, check whether it is really the same thread as another interview's and merge them. Themes are ranked by how many interviews raise them, so the grouping must be honest.
- A statement may belong to several themes.
- Names are specific and informative ("Artists not compensated", "Nuance flattened by AI"), never generic ("AI ethics", "Risks", "Concerns"). Write them in the language of the statements.
- Each theme is ONE thread. If its description needs "and" to join two different concerns, split it (e.g. children being misled by hallucinated content is a different thread from young people's self-image and unattainable standards, even though both involve children).
- Aim for roughly one theme per 2-4 statements. Merge themes that only differ in wording.
- Do not infer agreement. Interviews on one theme may disagree; the description names the thread, not a conclusion.
- If PREVIOUS THEMES are listed, keep a name exactly when its thread still holds, adding or dropping statements as the evidence changes, so labels stay stable as interviews arrive. Rename, merge or split only when the evidence demands it.`},
 {key:'reel_rate_system',label:'Reel: rate snippets',kind:'text',
  help:'System prompt for the theme-reel composer. For ONE theme it receives candidate snippets (verbatim transcript) and rates each. The code computes the final score from the criteria with its own weights and chooses; the model only rates. Must keep asking for the JSON shape below.',
  default:`You are an editor choosing spoken excerpts for a short social video that makes one theme felt. Input: a THEME (name and description) and numbered candidate SNIPPETS, each a verbatim transcript of one person speaking. Produce valid JSON only:
{"ratings":[{"snippet":0,"relevance":1-5,"standalone":1-5,"insight":1-5,"vividness":1-5,"rationale":"one sentence"}]}.
Criteria, each an integer 1-5:
- relevance: how directly the snippet speaks to THIS theme (5 = it is the theme, 1 = tangential).
- standalone: understood by a stranger with no other context; no dangling "this" or "that", does not start or stop mid-thought (5 = complete thought).
- insight: says something specific, surprising or considered, not a platitude or filler.
- vividness: concrete detail, an example, feeling or a memorable turn of phrase; sounds like a person, not a press release.
Rate every snippet. Be discriminating: use the full range and do not give everything a 4. Judge only the text given. Do not infer anything about the speaker, and do not reward agreement with any position. The rationale names what makes it work or fail.`},
 {key:'reel_arrange_system',label:'Reel: arrange',kind:'text',
  help:'System prompt for the theme-reel composer. It receives the chosen snippets (each tagged with its theme) and decides the running order and the reel title. The code validates the order. Must keep asking for the JSON shape below.',
  default:`You edit a short social video from the selected excerpts of several interviews. Input: numbered CLIPS, each with a theme and verbatim text. Produce valid JSON only:
{"title":"3-8 word title","summary":"two sentences on the arc of the reel","order":[2,0,1]}.
"order" lists EVERY clip number exactly once. Open with the clip that hooks hardest, build so that each clip adds to or turns the one before it (keep clips of one theme together unless contrast works better), and end on the clip that lands best. The title and summary describe what the people said, neutrally: no claim of agreement or consensus, no conclusion beyond the clips. Write them in the language of the clips.`},
 {key:'analysis_temperature',label:'Analysis temperature',kind:'number',
  help:'Sampling temperature for the analysis and the theme pass, 0 to 2. Lower is more literal.',default:'0.15'}
] as const satisfies readonly PromptDef[];
export type PromptKey=(typeof PROMPT_DEFS)[number]['key'];
export const promptDef=(key:string):PromptDef|undefined=>PROMPT_DEFS.find(d=>d.key===key);

/** The active text of every prompt for one model, with the version each came from (0 = built-in default). */
export class Prompts{
 constructor(private readonly bodies:Record<string,string>,readonly versions:Record<string,number>){}
 text(key:PromptKey):string{return this.bodies[key]??promptDef(key)!.default}
 number(key:PromptKey):number{const n=Number(this.text(key));return Number.isFinite(n)?n:Number(promptDef(key)!.default)}
 /** The same prompts with one key replaced: a draft being tried. Its version shows as -1. */
 with(key:PromptKey,body:string):Prompts{return new Prompts({...this.bodies,[key]:body},{...this.versions,[key]:-1})}
}
export const DEFAULT_PROMPTS=new Prompts({},{});

const isMissingTable=(e:unknown)=>(e as {code?:string})?.code==='42P01';

export async function loadPrompts(sql:Sql,model:string):Promise<Prompts>{
 try{
  const rows=await sql<{key:string;version:number;body:string}[]>`select key,version,body from prompts where model=${model} and active`;
  return new Prompts(Object.fromEntries(rows.map(r=>[r.key,r.body])),Object.fromEntries(rows.map(r=>[r.key,r.version])));
 }catch(e){if(isMissingTable(e))return DEFAULT_PROMPTS;throw e}
}
export type PromptVersion={id:string;key:string;version:number;body:string;notes:string|null;active:boolean;created_by:string|null;created_at:string};
export async function listVersions(sql:Sql,model:string,key:string):Promise<PromptVersion[]>{
 try{return await sql<PromptVersion[]>`select id,key,version,body,notes,active,created_by,created_at::text as created_at from prompts where model=${model} and key=${key} order by version desc`}
 catch(e){if(isMissingTable(e))return [];throw e}
}
export async function tablesExist(sql:Sql):Promise<boolean>{
 const [r]=await sql<{p:string|null;s:string|null}[]>`select to_regclass('public.prompts')::text as p,to_regclass('public.app_settings')::text as s`;
 return !!r?.p&&!!r?.s;
}
/** Saves `body` as the next version of (model, key), optionally making it the active one. */
export async function saveVersion(sql:Sql,i:{model:string;key:string;body:string;notes?:string;activate:boolean;by?:string}):Promise<number>{
 return sql.begin(async tx=>{
  await tx`select pg_advisory_xact_lock(hashtext(${i.model+':'+i.key}))`;
  const [{next}]=await tx<{next:number}[]>`select coalesce(max(version),0)+1 as next from prompts where model=${i.model} and key=${i.key}`;
  if(i.activate)await tx`update prompts set active=false where model=${i.model} and key=${i.key} and active`;
  await tx`insert into prompts(model,key,version,body,notes,active,created_by) values(${i.model},${i.key},${next},${i.body},${i.notes||null},${i.activate},${i.by??null})`;
  return next;
 }) as Promise<number>;
}
export async function activateVersion(sql:Sql,model:string,key:string,version:number):Promise<void>{
 await sql.begin(async tx=>{
  const [v]=await tx`select 1 from prompts where model=${model} and key=${key} and version=${version}`;
  if(!v)throw new Error(`no version ${version} of ${key} for ${model}`);
  await tx`update prompts set active=false where model=${model} and key=${key} and active`;
  await tx`update prompts set active=true where model=${model} and key=${key} and version=${version}`;
 });
}
/** No version active: the built-in default runs. */
export async function clearActive(sql:Sql,model:string,key:string):Promise<void>{
 await sql`update prompts set active=false where model=${model} and key=${key} and active`;
}

/** The model the ingest pipeline runs on; falls back to the default if unset, unknown or the table is missing. */
export async function getActiveModel(sql:Sql):Promise<string>{
 try{
  const [r]=await sql<{value:string}[]>`select value from app_settings where key='active_model'`;
  return r&&modelDef(r.value)?r.value:DEFAULT_MODEL;
 }catch(e){if(isMissingTable(e))return DEFAULT_MODEL;throw e}
}
export async function setActiveModel(sql:Sql,model:string):Promise<void>{
 if(!modelDef(model))throw new Error(`unknown model ${model}`);
 await sql`insert into app_settings(key,value) values('active_model',${model}) on conflict(key) do update set value=excluded.value,updated_at=now()`;
}
