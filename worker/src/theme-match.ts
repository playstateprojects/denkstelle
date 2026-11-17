/** Themes, one statement at a time.
 *
 * For each new statement: find the themes of its nearest statements (embeddings), ask Jev whether the statement belongs to
 * each of those themes, and let `decide` turn the probabilities into one of three outcomes. Jev supplies judgements, code
 * owns the decision. Naming a new theme is generation, so that is an ordinary chat-model call (prompt `theme_name_system`).
 *
 *   at least one candidate is a clear yes                        -> join those themes (up to MAX_THEMES_PER_STATEMENT)
 *   every candidate is a clear no (or there are no candidates)  -> create a theme from the statement
 *   otherwise (some candidate is neither yes nor no)             -> pending for now
 *
 * A run places statements in arrival order, then makes a second, SETTLING pass over those left pending: by then the themes have
 * grown and been rewritten, so a statement is asked again; if it still has no clear yes it starts its own theme. Nothing stays
 * pending. A false "no" costs an extra theme that a merge can fix; a false "yes" pollutes a theme, so the yes threshold is not low.
 *
 * Themes are a neutral map of what statements are about. The project question is not used here at all: not in Jev's state, not
 * in naming or rewriting. (It is still used for insights.)
 *
 * All question wording and thresholds are in this file. Bump THEME_JEV_VERSION when either changes.
 * Insights are not touched here: a theme whose statement set changed is re-derived by insights.ts as before.
 */
import {z} from 'zod';
import type {Sql} from 'postgres';
import {modelDef,llmComplete,parseJson,LlmError,type Env} from './models.ts';
import {askNouls,type Noul} from './jev.ts';
import {embeddings,vector} from './utils.ts';
import {canonical} from './themes.ts';
import type {Prompts} from './prompts.ts';

export const THEME_JEV_VERSION='theme-3';
/** Noul starting points from TypeSafe's guidance: >= member reads as yes, <= notMember as no, the band between is unsettled. */
/** member: a yes in the first pass. notMember: a clear no. settle: a yes in the settling pass, where "more likely than not" will do
 * because the alternative is a theme of one that duplicates its nearest neighbour (eval, theme-2 runs: singletons made by the
 * settling pass were mostly statements at p 0.5 to 0.6 against an existing theme). */
export type Thresholds={member:number;notMember:number;settle:number};
export const THRESHOLDS:Thresholds={member:.6,notMember:.3,settle:.5};
/** Themes put to Jev per statement, taken from the themes of its nearest statements. */
export const MAX_CANDIDATES=4;
/** How many nearest statements are looked at to find those themes. */
export const NEAREST_STATEMENTS=12;
export const MAX_THEMES_PER_STATEMENT=3;
/** Statements already in a theme that are shown to Jev with it, nearest to the new statement first. */
export const EXAMPLES_PER_THEME=3;
const EXAMPLE_CHARS=200;
const MAX_CONSECUTIVE_FAILURES=3;
/** A theme's name and description are rewritten each time it has grown by this many statements since they were last written. */
export const REWRITE_EVERY=5;
/** Statements shown to the rewriter: all of them, or an even spread across the theme's arrival order. */
export const MAX_REWRITE_STATEMENTS=40;
const REWRITE_CHARS=300;

export type Candidate={id:string;name:string;description:string|null;examples:string[]};
export type Judgement={themeId:string;p:number};
export type Placement={kind:'assign';links:Judgement[]}|{kind:'pending'}|{kind:'create'};
export type LinkMethod='jev'|'seed'|'name_match';

/** The truth table. Judgements in, outcome out; nothing else decides where a statement goes.
 * A "member" is at or above t.member, a clear "no" is at or below t.notMember. With `settle` (the second pass, nothing left to
 * wait for) a candidate at or above t.settle is a member, and a statement with none starts a theme even when one is unsettled. */
export function decide(js:Judgement[],t:Thresholds=THRESHOLDS,max=MAX_THEMES_PER_STATEMENT,settle=false):Placement{
 const cut=settle?t.settle:t.member;
 const members=js.filter(j=>j.p>=cut).sort((a,b)=>b.p-a.p).slice(0,max);
 if(members.length)return {kind:'assign',links:members};
 if(!settle&&js.some(j=>j.p>t.notMember))return {kind:'pending'};
 return {kind:'create'};
}

/** One request per statement: the statement is the shared state, each candidate theme is its own yes/no question.
 * A Noul per theme (not one Choice) because a statement may speak to several themes at once.
 * The project question is deliberately NOT in the state. Whether a statement speaks to an issue does not depend on it, and with it
 * every statement "answers the question": in the eval a theme about improvements for the project then absorbed 50+ of 92
 * statements in 2 of 3 orders, and none without it (eval/results, theme-1 runs). */
export function buildQuestions(statement:string,candidates:Candidate[]):{state:Record<string,string>;questions:Record<string,Noul>}{
 const questions:Record<string,Noul>={};
 candidates.forEach((c,i)=>{
  const examples=c.examples.length?` Statements already filed under it: ${c.examples.map(e=>`"${e}"`).join('; ')}.`:'';
  questions[`theme_${i}`]={type:'noul',
   instructions:`Does \`statement\` speak to this issue: "${c.name}"${c.description?` (${c.description})`:''}?${examples}`,
   criteria:{
    true:'The statement takes a side on this issue, or gives an example of it or a reason about it, whichever side it takes.',
    false:'The statement is about a different issue, even if it uses similar words or belongs to the same general subject.'}};
 });
 return {state:{statement},questions};
}

export type Judge=(i:{statement:string;candidates:Candidate[]})=>Promise<number[]>;
/** The live judge: one Jev request, probabilities returned in candidate order. */
export const jevJudge=(env:{TYPESAFE_API_KEY?:string}):Judge=>async({statement,candidates})=>{
 if(!candidates.length)return [];
 const {state,questions}=buildQuestions(statement,candidates);
 const {answers}=await askNouls(env,state,questions);
 return candidates.map((_,i)=>answers[`theme_${i}`]);
};

export class ThemeNameError extends LlmError{}
const Named=z.object({name:z.string().min(2),description:z.string().default('')});
export type NewTheme={name:string;description:string};
export type NameInput={statement:{text:string;fromText?:boolean};nearby:Candidate[]};
export type Namer=(i:NameInput)=>Promise<NewTheme>;

export function namingUser(i:NameInput):string{
 return [
  ...(i.statement.fromText?["NOTE: this statement comes from the project's reference text, not from an interviewee."]:[]),
  `STATEMENT: ${i.statement.text}`,
  `NEARBY THEMES (this statement does not belong to them):\n${i.nearby.length?i.nearby.map(t=>`- ${t.name}${t.description?`: ${t.description}`:''}`).join('\n'):'(none)'}`,
  'Return JSON.'
 ].join('\n\n');
}
/** The live namer: the model proposes, code trims. An unusable answer is an error, not a theme. */
export const modelNamer=(env:Env,modelId:string,prompts:Prompts):Namer=>async i=>{
 const def=modelDef(modelId);if(!def)throw new ThemeNameError(`Unknown model "${modelId}"`);
 const out=await llmComplete(def,env,{system:prompts.text('theme_name_system'),user:namingUser(i),temperature:prompts.number('analysis_temperature')});
 let json:unknown;
 try{json=parseJson(out.raw)}catch{throw new ThemeNameError(`${def.label} did not return valid JSON`,out.raw,out.ms)}
 const parsed=Named.safeParse(json);
 if(!parsed.success)throw new ThemeNameError(`${def.label} theme name JSON does not match the expected shape: ${parsed.error.issues.slice(0,3).map(x=>`${x.path.join('.')||'(root)'}: ${x.message}`).join('; ')}`,out.raw,out.ms);
 const name=parsed.data.name.trim().slice(0,80);
 if(!canonical(name))throw new ThemeNameError(`${def.label} returned an empty theme name`,out.raw,out.ms);
 return {name,description:parsed.data.description.trim().slice(0,300)};
};

/** The rewrite policy in one place: due once the theme has grown by REWRITE_EVERY since its wording was written. */
export const rewriteDue=(size:number,namedAt:number)=>size-namedAt>=REWRITE_EVERY;

/** At most `limit` items, evenly spread across the list and keeping its order (first and last included). */
export function spread<T>(items:T[],limit:number):T[]{
 if(items.length<=limit)return items;
 if(limit<=1)return items.slice(0,limit);
 return Array.from({length:limit},(_,i)=>items[Math.round(i*(items.length-1)/(limit-1))]);
}

export type RewriteInput={theme:{name:string;description:string|null};statements:{text:string;fromText:boolean}[];size:number};
export type Rewriter=(i:RewriteInput)=>Promise<NewTheme>;
export function rewritingUser(i:RewriteInput):string{
 return [
  `CURRENT THEME: ${i.theme.name}${i.theme.description?`: ${i.theme.description}`:''}`,
  `STATEMENTS${i.statements.length<i.size?` (${i.statements.length} of ${i.size}, evenly spread)`:''}:\n${i.statements.map((s,n)=>`[${n}]${s.fromText?' (text)':''} ${s.text.slice(0,REWRITE_CHARS)}`).join('\n')}`,
  'Return JSON.'
 ].join('\n\n');
}
/** The live rewriter: the model proposes, code trims. An unusable answer is an error, so the old wording stays. */
export const modelRewriter=(env:Env,modelId:string,prompts:Prompts):Rewriter=>async i=>{
 const def=modelDef(modelId);if(!def)throw new ThemeNameError(`Unknown model "${modelId}"`);
 const out=await llmComplete(def,env,{system:prompts.text('theme_rewrite_system'),user:rewritingUser(i),temperature:prompts.number('analysis_temperature')});
 let json:unknown;
 try{json=parseJson(out.raw)}catch{throw new ThemeNameError(`${def.label} did not return valid JSON`,out.raw,out.ms)}
 const parsed=Named.safeParse(json);
 if(!parsed.success)throw new ThemeNameError(`${def.label} theme rewrite JSON does not match the expected shape: ${parsed.error.issues.slice(0,3).map(x=>`${x.path.join('.')||'(root)'}: ${x.message}`).join('; ')}`,out.raw,out.ms);
 const name=parsed.data.name.trim().slice(0,80);
 if(!canonical(name))throw new ThemeNameError(`${def.label} returned an empty theme name`,out.raw,out.ms);
 return {name,description:parsed.data.description.trim().slice(0,300)};
};

/** Where themes and assignments live: Postgres in the pipeline, memory in tests and the eval script. */
export interface ThemeStore{
 /** Themes of the statement's nearest already-themed statements, nearest first, each with example statements. */
 candidates(statementId:string,limit:number):Promise<Candidate[]>;
 /** Every judgement Jev made, yes and no. */
 judged(statementId:string,js:Judgement[],by:string):Promise<void>;
 /** Puts the statement in these themes and marks it assigned. */
 link(statementId:string,links:{themeId:string;p:number|null;method:LinkMethod}[],by:string):Promise<void>;
 /** Marks the statement pending. */
 park(statementId:string):Promise<void>;
 /** A theme with this name, created unless one with the same canonical name exists. A new theme counts as written at size 1. */
 createTheme(t:NewTheme):Promise<{id:string;existed:boolean}>;
 /** The theme's wording, its size now, and its size when the wording was last written. */
 growth(themeId:string):Promise<{name:string;description:string|null;size:number;namedAt:number}>;
 /** The theme's statements in arrival order, evenly spread when there are more than `limit`. */
 sample(themeId:string,limit:number):Promise<{text:string;fromText:boolean}[]>;
 /** Records that the wording was reviewed at `size` and applies `next` when it differs. The old wording stays when
  * another theme already has the new name: two themes with one name are a merge signal, not a rename. */
 rename(themeId:string,next:NewTheme,size:number,by:string):Promise<{renamed:boolean;why?:'unchanged'|'name_taken'}>;
}

export type Renamed={themeId:string;from:string;to:string};
export type Placed={placement:Placement;judged:Judgement[];themeId?:string;renamed:Renamed[]};

/** Rewrites one theme's name and description if it has grown by REWRITE_EVERY since they were last written. */
export async function refreshTheme(d:{store:ThemeStore;rewrite:Rewriter},themeId:string):Promise<Renamed|null>{
 const g=await d.store.growth(themeId);
 if(!rewriteDue(g.size,g.namedAt))return null;
 const statements=await d.store.sample(themeId,MAX_REWRITE_STATEMENTS);
 const next=await d.rewrite({theme:{name:g.name,description:g.description},statements,size:g.size});
 const r=await d.store.rename(themeId,next,g.size,THEME_JEV_VERSION);
 return r.renamed?{themeId,from:g.name,to:next.name}:null;
}

export type PlaceDeps={store:ThemeStore;judge:Judge;name:Namer;rewrite?:Rewriter;thresholds?:Thresholds};
export type Statement={id:string;text:string;fromText?:boolean};

/** Places one statement. Any failure (Jev, naming, store) throws before the statement is marked, so it is simply retried later.
 * With `rewrite`, every theme the statement joined is then checked for growth. That runs after the statement is placed, so a
 * failed rewrite never undoes the placement: it is logged and tried again when the theme next grows a statement.
 * `settle` is the second pass: an unsettled statement starts a theme instead of waiting. */
export async function placeStatement(d:PlaceDeps,st:Statement,o:{settle?:boolean}={}):Promise<Placed>{
 const placed=await place(d,st,o.settle??false);
 const themeIds=placed.placement.kind==='assign'?placed.placement.links.map(l=>l.themeId):placed.themeId?[placed.themeId]:[];
 if(d.rewrite)for(const id of themeIds){
  try{const r=await refreshTheme({store:d.store,rewrite:d.rewrite},id);if(r)placed.renamed.push(r)}
  catch(e){console.error(`Theme ${id} not rewritten, the old wording stays:`,e instanceof Error?e.message:e)}
 }
 return placed;
}

async function place(d:PlaceDeps,st:Statement,settle:boolean):Promise<Placed>{
 const candidates=await d.store.candidates(st.id,MAX_CANDIDATES);
 const ps=candidates.length?await d.judge({statement:st.text,candidates}):[];
 if(ps.length!==candidates.length||ps.some(p=>typeof p!=='number'||!(p>=0&&p<=1)))throw new Error(`Expected ${candidates.length} probabilities between 0 and 1, got ${JSON.stringify(ps)}`);
 const judged=candidates.map((c,i)=>({themeId:c.id,p:ps[i]}));
 if(judged.length)await d.store.judged(st.id,judged,THEME_JEV_VERSION);
 const placement=decide(judged,d.thresholds??THRESHOLDS,MAX_THEMES_PER_STATEMENT,settle);
 if(placement.kind==='assign'){
  await d.store.link(st.id,placement.links.map(l=>({themeId:l.themeId,p:l.p,method:'jev'})),THEME_JEV_VERSION);
  return {placement,judged,renamed:[]};
 }
 if(placement.kind==='pending'){await d.store.park(st.id);return {placement,judged,renamed:[]}}
 const named=await d.name({statement:st,nearby:candidates});
 const theme=await d.store.createTheme(named);
 // If the model names it exactly like an existing theme, that is evidence it belongs there.
 await d.store.link(st.id,[{themeId:theme.id,p:null,method:theme.existed?'name_match':'seed'}],THEME_JEV_VERSION);
 return {placement,judged,themeId:theme.id,renamed:[]};
}

export type PlaceAll={final:Map<string,Placed>;/** statements left pending by the first pass and placed by the second */settled:string[];failed:{statement:string;error:string}[];aborted:boolean};

/** The whole run over a list of statements: a first pass in the given order, then the settling pass over what it left pending.
 * One statement failing leaves it unplaced for the next run; three failures in a row stop the run, since the service is probably down. */
export async function placeAll(d:PlaceDeps,sts:Statement[],o:{onPlaced?:(st:Statement,p:Placed,pass:1|2)=>void;/** false skips the settling pass (the eval compares with and without it) */settle?:boolean}={}):Promise<PlaceAll>{
 const out:PlaceAll={final:new Map(),settled:[],failed:[],aborted:false};
 let streak=0;
 const pass=async(list:Statement[],n:1|2)=>{
  const left:Statement[]=[];
  for(const st of list){
   try{
    const placed=await placeStatement(d,st,{settle:n===2});
    streak=0;out.final.set(st.id,placed);
    if(n===2)out.settled.push(st.id);
    if(placed.placement.kind==='pending')left.push(st);
    o.onPlaced?.(st,placed,n);
   }catch(e){
    out.failed.push({statement:st.id,error:e instanceof Error?e.message:String(e)});
    if(++streak>=MAX_CONSECUTIVE_FAILURES){out.aborted=true;break}
   }
  }
  return left;
 };
 const left=await pass(sts,1);
 if(left.length&&!out.aborted&&o.settle!==false)await pass(left,2);
 return out;
}

export type AssignResult={considered:number;assigned:number;created:number;pending:number;/** of those, placed by the settling pass */settled:number;renamed:number;failed:{statement:string;error:string}[];aborted:boolean};

/** Postgres store for one project. Relies on the caller holding the project's theme lock (see assignThemes). */
export function pgStore(sql:Sql,projectId:string):ThemeStore{
 return {
  async candidates(statementId,limit){
   const themes=await sql<{id:string;name:string;description:string|null}[]>`
    select t.id,t.name,t.description from (
     select x.theme_id,min(n.dist) as dist from (
      select s.id,(s.embedding <=> me.embedding)::float8 as dist
      from statements s,(select embedding from statements where id=${statementId}) me
      where s.project_id=${projectId} and s.id<>${statementId} and s.embedding is not null and me.embedding is not null
       and exists (select 1 from statement_themes q where q.statement_id=s.id)
      order by s.embedding <=> me.embedding limit ${NEAREST_STATEMENTS}
     ) n join statement_themes x on x.statement_id=n.id group by x.theme_id
    ) n join themes t on t.id=n.theme_id order by n.dist limit ${limit}`;
   if(!themes.length)return [];
   const ex=await sql<{theme_id:string;text:string}[]>`
    select theme_id,text from (
     select x.theme_id,s.text,row_number() over (partition by x.theme_id order by s.embedding <=> me.embedding) as rn
     from statement_themes x join statements s on s.id=x.statement_id
     cross join (select embedding from statements where id=${statementId}) me
     where x.theme_id in ${sql(themes.map(t=>t.id))} and s.id<>${statementId}
    ) q where rn<=${EXAMPLES_PER_THEME}`;
   return themes.map(t=>({...t,examples:ex.filter(e=>e.theme_id===t.id).map(e=>e.text.slice(0,EXAMPLE_CHARS))}));
  },
  async judged(statementId,js,by){
   for(const j of js)await sql`insert into theme_judgements(statement_id,theme_id,probability,judged_by) values(${statementId},${j.themeId},${j.p},${by})
    on conflict(statement_id,theme_id) do update set probability=excluded.probability,judged_by=excluded.judged_by,judged_at=now()`;
  },
  async link(statementId,links,by){
   await sql.begin(async tx=>{
    for(const l of links)await tx`insert into statement_themes(statement_id,theme_id,probability,method,judged_by) values(${statementId},${l.themeId},${l.p},${l.method},${by})
     on conflict(statement_id,theme_id) do update set probability=excluded.probability,method=excluded.method,judged_by=excluded.judged_by`;
    await tx`update statements set theme_status='assigned' where id=${statementId}`;
   });
  },
  async park(statementId){await sql`update statements set theme_status='pending' where id=${statementId}`},
  async createTheme(t){
   const [have]=await sql<{id:string}[]>`select id from themes where project_id=${projectId} and canonical=${canonical(t.name)}`;
   if(have)return {id:have.id,existed:true};
   const [v]=await embeddings([t.description?`${t.name}: ${t.description}`:t.name]);
   const [row]=await sql<{id:string}[]>`insert into themes(project_id,canonical,name,description,embedding,named_size)
    values(${projectId},${canonical(t.name)},${t.name},${t.description||null},${vector(v)}::vector,1) returning id`;
   return {id:row.id,existed:false};
  },
  async growth(themeId){
   const [t]=await sql<{name:string;description:string|null;named_size:number|null;size:number}[]>`
    select t.name,t.description,t.named_size,(select count(*)::int from statement_themes x where x.theme_id=t.id) as size from themes t where t.id=${themeId}`;
   if(!t)throw new Error(`No theme ${themeId}`);
   // A theme from before db/014 or from the legacy rebuild has no mark yet: its wording is taken as current, and counted from here.
   if(t.named_size==null)await sql`update themes set named_size=${t.size} where id=${themeId}`;
   return {name:t.name,description:t.description,size:t.size,namedAt:t.named_size??t.size};
  },
  async sample(themeId,limit){
   const rows=await sql<{text:string;from_text:boolean}[]>`
    select s.text,so.role='context' as from_text from statement_themes x join statements s on s.id=x.statement_id join sources so on so.id=s.source_id
    where x.theme_id=${themeId} order by so.created_at,s.created_at,s.id`;
   return spread(rows,limit).map(r=>({text:r.text,fromText:r.from_text}));
  },
  async rename(themeId,next,size,by){
   const [cur]=await sql<{name:string;description:string|null}[]>`select name,description from themes where id=${themeId}`;
   if(!cur)throw new Error(`No theme ${themeId}`);
   const advance=()=>sql`update themes set named_size=${size} where id=${themeId}`;
   const [clash]=await sql<{one:number}[]>`select 1 as one from themes where project_id=${projectId} and canonical=${canonical(next.name)} and id<>${themeId}`;
   if(clash){await advance();return {renamed:false,why:'name_taken' as const}}
   if(cur.name===next.name&&(cur.description??'')===next.description){await advance();return {renamed:false,why:'unchanged' as const}}
   const [v]=await embeddings([next.description?`${next.name}: ${next.description}`:next.name]);
   await sql.begin(async tx=>{
    await tx`insert into theme_renames(theme_id,old_name,old_description,new_name,new_description,size,judged_by) values(${themeId},${cur.name},${cur.description},${next.name},${next.description||null},${size},${by})`;
    await tx`update themes set canonical=${canonical(next.name)},name=${next.name},description=${next.description||null},embedding=${vector(v)}::vector,named_size=${size} where id=${themeId}`;
   });
   return {renamed:true};
  }
 };
}

/** Places every statement of the project's ready sources that has no theme yet, plus the pending ones, in the order they arrived.
 * One run per project at a time (advisory lock, shared with the legacy rebuild): a second caller waits, then sees the first one's work.
 * One statement failing leaves it unplaced for the next run; three in a row stop the run, since the service is probably down. */
export async function assignThemes(sql:Sql,env:Env,modelId:string,prompts:Prompts,projectId:string,
 opts:{judge?:Judge;name?:Namer;rewrite?:Rewriter;thresholds?:Thresholds;onPlaced?:(st:Statement,p:Placed,pass:1|2)=>void}={}):Promise<AssignResult>{
 const [project]=await sql<{id:string}[]>`select id from projects where id=${projectId}`;
 if(!project)throw new Error(`No project ${projectId}`);
 const judge=opts.judge??jevJudge(env),name=opts.name??modelNamer(env,modelId,prompts),rewrite=opts.rewrite??modelRewriter(env,modelId,prompts);
 const result:AssignResult={considered:0,assigned:0,created:0,pending:0,settled:0,renamed:0,failed:[],aborted:false};
 const key=`themes:${projectId}`;
 const conn=await sql.reserve();
 try{
  await conn`select pg_advisory_lock(hashtext(${key}))`;
  // A document still being read ('processing') is left out until it is ready, as in the legacy pass.
  const todo=await sql<{id:string;text:string;from_text:boolean}[]>`
   select st.id,st.text,s.role='context' as from_text from statements st join sources s on s.id=st.source_id
   where st.project_id=${projectId} and s.status='ready' and (st.theme_status is null or st.theme_status='pending')
   order by s.created_at,st.created_at,st.id`;
  const run=await placeAll({store:pgStore(sql,projectId),judge,name,rewrite,thresholds:opts.thresholds},todo.map(t=>({id:t.id,text:t.text,fromText:t.from_text})),{onPlaced:opts.onPlaced});
  result.considered=todo.length;result.failed=run.failed;result.aborted=run.aborted;result.settled=run.settled.length;
  for(const p of run.final.values()){
   if(p.placement.kind==='assign')result.assigned++;else if(p.placement.kind==='create')result.created++;else result.pending++;
   result.renamed+=p.renamed.length;
  }
  // Themes whose statements were deleted (a re-run or removed source) have nothing left to stand on.
  await sql`delete from themes t where t.project_id=${projectId} and not exists (select 1 from statement_themes x where x.theme_id=t.id)`;
 }finally{
  await conn`select pg_advisory_unlock(hashtext(${key}))`.catch(()=>{});
  conn.release();
 }
 return result;
}
