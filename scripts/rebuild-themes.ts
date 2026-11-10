/** Re-derive the shared themes of a project (or every project) from its existing statements. No video is reprocessed.
 *   npm run themes:rebuild -- --dry            preview all projects, write nothing
 *   npm run themes:rebuild -- <projectId>      rebuild one project
 */
import {database} from '../worker/src/utils.ts';
import {getActiveModel,loadPrompts} from '../worker/src/prompts.ts';
import {rebuildThemes} from '../worker/src/themes.ts';

const args=process.argv.slice(2),dryRun=args.includes('--dry'),only=args.find(a=>!a.startsWith('--'));
const sql=database();
try{
  const modelId=await getActiveModel(sql),prompts=await loadPrompts(sql,modelId);
  const projects=await sql<{id:string;title:string}[]>`select id,title from projects ${only?sql`where id=${only}`:sql``} order by created_at`;
  for(const p of projects){
    const r=await rebuildThemes(sql,process.env,modelId,prompts,p.id,{dryRun});
    console.log(`\n=== ${p.title} (${p.id}) · ${modelId} · ${dryRun?'DRY RUN, nothing written':'written'}`);
    console.log(`${r.themes.length} shared themes · ${r.statements.length} statements · ${r.unthemed} not part of any shared theme`);
    for(const t of r.themes){
      console.log(`\n● ${t.name}  [${t.sourceCount} interviews, ${t.statementIds.length} statements]\n  ${t.description}`);
      for(const id of t.statementIds)console.log(`    - ${r.statements.find(s=>s.id===id)?.text.slice(0,140)}`);
    }
  }
}finally{await sql.end();}
