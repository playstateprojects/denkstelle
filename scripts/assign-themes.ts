/** Place a project's statements in themes with Jev, one at a time (worker/src/theme-match.ts).
 *   npm run themes:assign -- <projectId>             place statements that have no theme yet, and retry pending ones
 *   npm run themes:assign -- <projectId> --reset     FIRST save the current themes, memberships and insights to eval/results/,
 *                                                    then delete them and place every statement again, in arrival order
 *   add --insights to derive insights for the themes afterwards
 * Pass 1 places statements in arrival order (lines start with two spaces); pass 2, marked "2", asks again about those left pending.
 * Needs TYPESAFE_API_KEY (Jev), a chat model key (new theme names) and WORKERS_AI_API_TOKEN (theme embeddings).
 */
import {mkdir,writeFile} from 'node:fs/promises';
import {database} from '../worker/src/utils.ts';
import {getActiveModel,loadPrompts} from '../worker/src/prompts.ts';
import {assignThemes,THEME_JEV_VERSION,THRESHOLDS} from '../worker/src/theme-match.ts';
import {rebuildInsights} from '../worker/src/insights.ts';

const args=process.argv.slice(2),reset=args.includes('--reset'),insights=args.includes('--insights'),projectId=args.find(a=>!a.startsWith('--'));
if(!projectId){console.error('Usage: npm run themes:assign -- <projectId> [--reset] [--insights]');process.exit(1)}
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

 console.log(`\n=== ${project.title} (${projectId}) · ${modelId} · Jev ${THEME_JEV_VERSION} · yes>=${THRESHOLDS.member} (pass 2: ${THRESHOLDS.settle}) no<=${THRESHOLDS.notMember}`);
 const r=await assignThemes(sql,process.env,modelId,prompts,projectId,{onPlaced:(st,p,pass)=>{
  const tag=p.placement.kind==='assign'?`-> ${p.placement.links.map(l=>`${l.themeId.slice(0,6)}@${l.p.toFixed(2)}`).join(' ')}`:p.placement.kind==='create'?'-> NEW THEME':'-> pending';
  console.log(`${(pass===2?'2 ':'  ')+tag.padEnd(34)} ${st.text.slice(0,90)}`);
  for(const r of p.renamed)console.log(`    ~ theme rewritten: "${r.from}" -> "${r.to}"`);
 }});
 console.log(`\n${r.considered} considered · ${r.assigned} joined a theme · ${r.created} started one · ${r.pending} pending (${r.settled} of the first pass's pending settled in pass 2) · ${r.renamed} rewritten · ${r.failed.length} failed${r.aborted?' · STOPPED after repeated failures':''}`);
 for(const f of r.failed)console.error(`  ${f.statement}: ${f.error}`);
 const themes=await sql<{name:string;n:number}[]>`select t.name,count(x.statement_id)::int as n from themes t left join statement_themes x on x.theme_id=t.id where t.project_id=${projectId} group by t.id order by n desc`;
 console.log(`\n${themes.length} themes (${themes.filter(t=>t.n===1).length} with a single statement):`);
 for(const t of themes)console.log(`  ${String(t.n).padStart(3)}  ${t.name}`);
 if(insights){
  const i=await rebuildInsights(sql,process.env,modelId,prompts,projectId);
  console.log(`\nInsights: ${i.insights} derived for ${i.rebuilt} of ${i.themes} themes`);
  for(const f of i.failed)console.error(`  FAILED "${f.theme}": ${f.error}`);
 }
 if(r.aborted||r.failed.length)process.exitCode=1;
}finally{await sql.end()}
