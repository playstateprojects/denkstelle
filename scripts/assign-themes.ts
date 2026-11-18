/** Place a project's statements in themes, one at a time. By default topic first (worker/src/topic-match.ts): each statement gets 1 to 3
 * topics, each matched to a theme by name or embedding with Jev scoring the match. `--classic` runs the older per-statement method
 * (worker/src/theme-match.ts: Jev asks "which existing theme is this?"), which also has the merge step below.
 *   npm run themes:assign -- <projectId>             place statements that have no theme yet, and retry pending ones
 *   npm run themes:assign -- <projectId> --reset     FIRST save the current themes, memberships and insights to eval/results/,
 *                                                    then delete them and place every statement again, in arrival order
 *   add --insights to derive insights for the themes afterwards
 *   add --classic to use the older method
 *   add --no-merge to skip the merge step (classic only) (themes that overlap heavily and that Jev calls the same topic become one; worker/src/theme-merge.ts)
 * With nothing left to place, the command still runs the merge step, so it can be used on its own.
 * Pass 1 places statements in arrival order (lines start with two spaces); pass 2, marked "2", asks again about those left pending.
 * Needs TYPESAFE_API_KEY (Jev), a chat model key (topics, or new theme names with --classic) and WORKERS_AI_API_TOKEN (embeddings).
 */
import {mkdir,writeFile} from 'node:fs/promises';
import {database} from '../worker/src/utils.ts';
import {getActiveModel,loadPrompts} from '../worker/src/prompts.ts';
import {assignThemes,THEME_JEV_VERSION,THRESHOLDS} from '../worker/src/theme-match.ts';
import {assignTopics,TOPIC_VERSION,LINK_MIN} from '../worker/src/topic-match.ts';
import {rebuildInsights} from '../worker/src/insights.ts';

const args=process.argv.slice(2),classic=args.includes('--classic'),reset=args.includes('--reset'),insights=args.includes('--insights'),merge=!args.includes('--no-merge'),projectId=args.find(a=>!a.startsWith('--'));
if(!projectId){console.error('Usage: npm run themes:assign -- <projectId> [--reset] [--insights] [--classic]');process.exit(1)}
const pct=(x:number)=>`${Math.round(x*100)}%`;
const sql=database();
try{
 const [project]=await sql<{title:string}[]>`select title from projects where id=${projectId}`;
 if(!project)throw new Error(`No project ${projectId}`);
 const modelId=await getActiveModel(sql),prompts=await loadPrompts(sql,modelId);

 if(reset){
  // The current output is the benchmark for the new method: keep it before anything is deleted.
  const snapshot={
   savedAt:new Date().toISOString(),project:{id:projectId,title:project.title},
   themes:await sql`select id,name,description from themes where project_id=${projectId} order by name`,
   statements:await sql`select st.id,st.text,st.source_id,s.role from statements st join sources s on s.id=st.source_id where st.project_id=${projectId} order by s.created_at,st.created_at,st.id`,
   statementThemes:await sql`select x.statement_id,x.theme_id,x.probability,x.method from statement_themes x join statements st on st.id=x.statement_id where st.project_id=${projectId}`,
   insights:await sql`select id,theme_id,title,description from insights where project_id=${projectId}`,
   insightEvidence:await sql`select e.insight_id,e.statement_id from insight_evidence e join insights i on i.id=e.insight_id where i.project_id=${projectId}`
  };
  await mkdir('eval/results',{recursive:true});
  const file=`eval/results/snapshot-${projectId.slice(0,8)}-${Date.now()}.json`;
  await writeFile(file,JSON.stringify(snapshot,null,1));
  console.log(`Saved ${snapshot.themes.length} themes, ${snapshot.insights.length} insights, ${snapshot.statements.length} statements to ${file}`);
  // Themes take their memberships, judgements and insights with them (on delete cascade).
  await sql`delete from themes where project_id=${projectId}`;
  await sql`update statements set theme_status=null where project_id=${projectId}`;
 }

 let bad=false;
 if(classic){
  console.log(`\n=== ${project.title} (${projectId}) · ${modelId} · Jev ${THEME_JEV_VERSION} · yes>=${THRESHOLDS.member} (pass 2: ${THRESHOLDS.settle}) no<=${THRESHOLDS.notMember}`);
  const r=await assignThemes(sql,process.env,modelId,prompts,projectId,{onPlaced:(st,p,pass)=>{
   const tag=p.placement.kind==='assign'?`-> ${p.placement.links.map(l=>`${l.themeId.slice(0,6)}@${l.p.toFixed(2)}`).join(' ')}`:p.placement.kind==='create'?'-> NEW THEME':'-> pending';
   console.log(`${(pass===2?'2 ':'  ')+tag.padEnd(34)} ${st.text.slice(0,90)}`);
   for(const r of p.renamed)console.log(`    ~ theme rewritten: "${r.from}" -> "${r.to}"`);
  },merge,
  onMerged:m=>console.log(`\n  MERGED "${m.absorbed}" into "${m.survivor}"  (${m.overlap} shared, ${pct(m.containment)} of the smaller, Jev ${m.p.toFixed(2)})${m.renamedTo?` -> now "${m.renamedTo}"`:''}`),
  onKept:k=>console.log(`\n  kept apart "${k.a}" / "${k.b}"  (${k.overlap} shared, ${pct(k.containment)} of the smaller, Jev ${k.p.toFixed(2)})`)});
  console.log(`\n${r.considered} considered · ${r.assigned} joined a theme · ${r.created} started one · ${r.pending} pending (${r.settled} of the first pass's pending settled in pass 2) · ${r.renamed} rewritten · ${r.merged} themes merged · ${r.failed.length} failed${r.aborted?' · STOPPED after repeated failures':''}`);
  for(const f of r.failed)console.error(`  ${f.statement}: ${f.error}`);
  bad=r.aborted||r.failed.length>0;
 }else{
  console.log(`\n=== ${project.title} (${projectId}) · ${modelId} · ${TOPIC_VERSION} · link>=${LINK_MIN}`);
  const r=await assignTopics(sql,process.env,modelId,prompts,projectId,{onPlaced:(st,p)=>{
   console.log(`  ${p.links.map(l=>`${l.theme}${l.p==null?' (new)':`@${l.p.toFixed(2)}`}`).join(', ').padEnd(64)} ${st.text.slice(0,80)}`);
  }});
  console.log(`\n${r.considered} considered · ${r.placed} placed · ${r.created} themes started · ${r.failed.length} failed${r.aborted?' · STOPPED after repeated failures':''}`);
  for(const f of r.failed)console.error(`  ${f.statement}: ${f.error}`);
  bad=r.aborted||r.failed.length>0;
 }
 const themes=await sql<{name:string;n:number}[]>`select t.name,count(x.statement_id)::int as n from themes t left join statement_themes x on x.theme_id=t.id where t.project_id=${projectId} group by t.id order by n desc`;
 console.log(`\n${themes.length} themes (${themes.filter(t=>t.n===1).length} with a single statement):`);
 for(const t of themes)console.log(`  ${String(t.n).padStart(3)}  ${t.name}`);
 if(insights){
  const i=await rebuildInsights(sql,process.env,modelId,prompts,projectId);
  console.log(`\nInsights: ${i.insights} derived for ${i.rebuilt} of ${i.themes} themes`);
  for(const f of i.failed)console.error(`  FAILED "${f.theme}": ${f.error}`);
 }
 if(bad)process.exitCode=1;
}finally{await sql.end()}
