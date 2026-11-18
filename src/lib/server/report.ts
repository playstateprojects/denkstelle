import type postgres from 'postgres';
import {TOP_THEMES,INSIGHT_THEMES,type ReportData,type ReportInsight} from '../project-report';

/** Everything the emailed report shows. Only finished sources count, and a theme's sources are every source one of its
 * statements came from, recordings and reference texts alike. Themes are ranked by linked sources, then statements;
 * insights by how many sources, then statements, they rest on. */
export async function loadReport(sql:postgres.Sql,project:{id:string;title:string;question:string},url:string):Promise<ReportData>{
  const [stats]=await sql<ReportData['stats'][]>`select
    (select count(*)::int from sources where project_id=${project.id} and role='contribution' and status='ready') as recordings,
    (select count(*)::int from sources where project_id=${project.id} and role='context' and status='ready') as texts,
    (select count(*)::int from statements st join sources s on s.id=st.source_id where st.project_id=${project.id} and s.status='ready') as statements,
    (select count(*)::int from themes where project_id=${project.id}) as themes,
    (select count(*)::int from insights where project_id=${project.id}) as insights`;
  const themes=await sql<{id:string;name:string;description:string|null;sources:number;statements:number}[]>`
    select t.id,t.name,t.description,count(distinct st.source_id)::int as sources,count(distinct st.id)::int as statements
    from themes t join statement_themes x on x.theme_id=t.id join statements st on st.id=x.statement_id
    join sources s on s.id=st.source_id and s.status='ready'
    where t.project_id=${project.id} group by t.id order by sources desc,statements desc,t.name limit ${TOP_THEMES}`;
  const split=themes.length?await sql<{theme_id:string;title:string;statements:number}[]>`
    select x.theme_id,s.title,count(distinct st.id)::int as statements
    from statement_themes x join statements st on st.id=x.statement_id join sources s on s.id=st.source_id and s.status='ready'
    where x.theme_id in ${sql(themes.map(t=>t.id))} group by x.theme_id,s.id order by statements desc,s.created_at`:[];
  const leading=themes.slice(0,INSIGHT_THEMES).map(t=>t.id);
  const insights=leading.length?await sql<(ReportInsight&{theme_id:string})[]>`
    select i.theme_id,i.title,i.description,count(distinct st.id)::int as statements,count(distinct st.source_id)::int as sources
    from insights i join insight_evidence e on e.insight_id=i.id join statements st on st.id=e.statement_id
    where i.theme_id in ${sql(leading)} group by i.id order by sources desc,statements desc,i.created_at,i.id`:[];
  return {
    project:{title:project.title,question:project.question},stats,url,
    themes:themes.map(t=>({name:t.name,description:t.description,sources:t.sources,statements:t.statements,
      bySource:split.filter(b=>b.theme_id===t.id).map(({title,statements})=>({title,statements})),
      insights:insights.filter(i=>i.theme_id===t.id).map(({title,description,statements,sources})=>({title,description,statements,sources}))}))
  };
}
