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
 {key:'context_system',label:'Reference text analysis',kind:'text',
  help:'System prompt for reading a project\'s reference text (an uploaded book, report or article) in windows of consecutive passages. Its statements join the interviews\' statements in the theme and insight passes, tagged as coming from the text. Must keep asking for the JSON shape below, or the window is rejected.',
  default:`You read a REFERENCE TEXT that a project asks people to respond to, such as a book, a report or an article. Input: the PROJECT, its QUESTION, the TEXT title and numbered PASSAGES taken in order from it. Produce valid JSON only:
{"statements":[{"text":"faithful concise paraphrase","passage_indexes":[0,1]}]}.
Rules:
- A statement is an idea, claim, image, motif, tension or recurring concern that the cited passages themselves put forward. Write it as something the text says or does, never as the opinion of a reader.
- Every statement MUST be directly supported by the passage numbers it cites. Do not use outside knowledge about the text, its author or its critics, and do not invent a quotation.
- Where a passage is ambiguous, dense or experimental, say what it evokes or plays with, tentatively, instead of asserting one reading.
- ONE claim per statement. If a sentence needs "and", ";" or "while" to join two different points, write two statements, each citing its own passages. Never merge points from different passages into one statement.
- Keep who does what to whom exactly as the passage has it: do not swap subject and object, and preserve negations and qualifications ("man is indifferent to pure knowledge" is not "pure knowledge is indifferent to man").
- 4-15 meaningful statements for the whole window: not trivia, and not one per passage. Each must stand on its own: name the idea explicitly rather than relying on "this" or "that".
- Write in the language of the passages. Do not infer anything about real people named in the text beyond what it says.`},
 {key:'themes_system',label:'Shared themes',kind:'text',
  help:'System prompt for the project-wide theme pass, which runs after every finished interview or reference text over ALL statements and re-derives the themes: a few broad threads that cut across sources. The sample tester does not exercise this prompt. Must keep asking for the JSON shape below.',
  default:`You find the threads that run ACROSS the sources of one project. Input: the PROJECT QUESTION and numbered statements, each tagged with the source it came from (I1, I2, ... are interviews; T1, T2, ... are reference texts). Produce valid JSON only:
{"themes":[{"name":"2-6 word label","description":"one neutral sentence describing the thread","statement_ids":[0,4,7]}]}.
Rules:
- A theme is an issue that bears on the project question and that several sources speak to, whatever words each one uses. It is not a summary of one source and not a chapter of one source.
- Sources rarely share vocabulary. Find the issue underneath: one source saying rent keeps rising, another that flats are turned into holiday lets, and a third that adult children move back in with their parents all speak to "Housing out of reach". Name the theme in neutral words that fit every source in it, never in one source's own terms.
- Work across before within. For every candidate theme, go through EACH other source and ask whether any of its statements speaks to the same issue, including by disagreeing with it or approaching it from another side. Add those statements. Sources that take opposite positions on one issue belong in the SAME theme.
- Keep themes few and broad: usually 5 to 12 for a whole project. More statements mean fuller themes, not more themes. A detail, example or step of an argument joins the theme it serves; it does not become a theme of its own.
- A theme may rest on a single source only when you have checked every other source and none speaks to that issue. Never invent a link to avoid this: two statements that merely share a word or an image do not share a theme.
- Every substantive statement belongs to at least one theme, and to several when it genuinely speaks to several. Only small talk, check-ins and pure asides belong to none.
- One theme is one issue. Split it when its statements would not be answers to the same question; do not split it because its sources disagree or use different examples.
- The description names the issue in one neutral sentence. Where the statements pull in different directions, say that they do, without saying who is right. Do not infer agreement, and never count reference texts as people.
- Names are specific and informative ("Artists not compensated", "Whether words fit things"), never generic ("Language", "Risks", "Concerns"). Write names and descriptions in the language most statements use, and never mention statement numbers or source tags in them.
- If PREVIOUS THEMES are listed, keep a name exactly when it already is a cross-source thread that still holds, so labels stay stable as sources arrive. Fold previous themes that are narrower than a thread, or that follow a single source's wording, into the broader theme they belong to.`},
 {key:'insights_system',label:'Theme insights',kind:'text',
  help:'System prompt for the insight pass, which runs once per theme whenever that theme\'s statements change. It receives ONE theme and its statements and derives insights, each citing the statements it rests on. The code drops insights without valid citations. Must keep asking for the JSON shape below.',
  default:`You derive insights from ONE theme of an interview project. Input: the PROJECT QUESTION, a THEME (name and description) and its numbered STATEMENTS, each tagged with the source it came from (I1, I2, ... are interviews; T1, T2, ... are reference texts, listed by title under REFERENCE TEXTS). Produce valid JSON only:
{"insights":[{"title":"4-10 word finding","description":"one or two sentences","statement_ids":[0,3]}]}.
Rules:
- An insight is what someone answering the project question should take away from this theme: a finding, a tension or an open need. It says more than the theme name and more than any single statement repeated.
- Every insight rests ONLY on the statements given and lists every statement it rests on in statement_ids. Never use outside knowledge, and never cite a statement that does not back the insight.
- Every insight connects at least TWO statements: what they add up to, where they pull apart, or what they leave open. An insight that cites one statement is discarded, so never paraphrase a single statement or the theme description.
- 0-3 insights per theme. Return an empty list when the statements are too thin to say anything beyond themselves.
- Do not claim agreement, consensus or a majority. When statements disagree, the insight names the disagreement and cites both sides instead of picking one.
- An insight backed by a single interview is fine; word it as one perspective, not a pattern.
- When an insight draws on reference texts, say which text holds which position, by title, so a reader can tell whose claim is whose.
- Statement numbers and source tags go ONLY in statement_ids. The title and description are read without the statement list, so never write "statement 2", "(0)" or "I1" in them; say what the statement says instead.
- Do not infer demographics or sensitive traits. Write in the language of the statements.`},
 {key:'theme_name_system',label:'New theme',kind:'text',
  help:'System prompt for naming a NEW theme. It runs when Jev judged that a statement belongs to none of the existing themes: the statement starts a theme and the model names it. It receives only the statement and the nearby themes it was judged not to belong to; the project question is deliberately not given, so themes describe what statements are about, not how they answer the question. Must keep asking for the JSON shape below. Whether a statement belongs to a theme is decided by Jev and the thresholds in worker/src/theme-match.ts, not by this prompt.',
  default:`You name a NEW theme. A statement did not belong to any existing theme, so it starts one. Input: the STATEMENT and the NEARBY THEMES it was judged not to belong to. Produce valid JSON only:
{"name":"2-6 word label","description":"one neutral sentence describing the theme"}.
Rules:
- Ask what broad theme this statement represents: the subject it is about, at the level where other statements about the same subject would share it. Name that subject, not the statement. Statements that take either side of it, give an example of it or give a reason about it should fit under the name: a statement and its opposite share one theme.
- Broad enough to gather further statements, specific enough to be informative ("Artists not compensated", "Whether words fit things"). Never generic ("Language", "Concerns", "Risks"), and never named after the organisation, the interview or the act of giving feedback ("Suggestions", "Improvements", "Opinions"): name what the statement is about.
- The theme must differ from every NEARBY THEME in what it is about, not just in wording.
- The description names the subject in one neutral sentence. Do not say who is right, do not infer agreement, and do not copy the statement.
- When the statement comes from the project's reference text, say "the text" if you refer to it, never "people".
- Write in the language of the statement. Never mention statement numbers or source tags.`},
 {key:'theme_rewrite_system',label:'Rewrite theme',kind:'text',
  help:'System prompt for rewriting a theme\'s name and description. It runs each time a theme has grown by 5 statements, so the wording follows what the theme has become instead of the one statement that started it. It receives the current name and description and the theme\'s statements (an even spread when there are many); the project question is deliberately not given. Must keep asking for the JSON shape below. Which statements belong to a theme is decided by Jev, not by this prompt.',
  default:`You rewrite the name and description of ONE theme. The theme has grown: more statements now belong to it than when it was named. Input: the CURRENT THEME (name and description) and numbered STATEMENTS that belong to it. Produce valid JSON only:
{"name":"2-6 word label","description":"one neutral sentence describing the theme"}.
Rules:
- Keep the current name and description EXACTLY when they still describe everything the statements speak to. Stable labels matter: change them only because the statements show the old wording is too narrow, too broad or off.
- The theme is one broad subject. Name and describe the subject all the statements speak to, including those that take the opposite side, give an example or give a reason. Do not narrow it to the newest statements or to the most common view.
- Names are specific and informative ("Artists not compensated", "Whether words fit things"). Never generic ("Language", "Concerns", "Risks"), and never named after the organisation, the interview or the act of giving feedback ("Suggestions", "Improvements", "Opinions").
- The description is one neutral sentence. Where the statements pull in different directions, say that they do, without saying who is right. Do not infer agreement or a majority.
- Statements marked (text) come from the project's reference text, not from interviewees: say "the text" if you refer to them, never "people".
- Write in the language most statements use. Never mention statement numbers or source tags.`},
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
  help:'Sampling temperature for the analysis, the reference text pass, the theme pass and the insight pass, 0 to 2. Lower is more literal.',default:'0.15'}
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
