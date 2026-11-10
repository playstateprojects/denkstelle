import {type PageServerLoad} from '@sveltejs/kit';
import {requireAdmin,requireProjectAccess} from '$lib/server/access';
import {connect} from '$lib/server/db';
export const load:PageServerLoad=async({params,locals,url,platform})=>{
  const u=requireAdmin(locals,url,platform);const sql=connect(platform);
  try{
    const project=await requireProjectAccess(sql,params.id,u.id);
    const nodes=await sql<{id:string;name:string;count:number}[]>`select t.id,t.name,count(distinct s.source_id)::int as count from themes t left join statement_themes st on st.theme_id=t.id left join statements s on s.id=st.statement_id where t.project_id=${params.id} group by t.id`;
    const links=await sql<{a:string;b:string;shared:number}[]>`
      select x.theme_id as a,y.theme_id as b,count(distinct sx.source_id)::int as shared
      from statement_themes x join statements sx on sx.id=x.statement_id
      join statement_themes y on y.theme_id>x.theme_id
      join statements sy on sy.id=y.statement_id and sy.source_id=sx.source_id
      where sx.project_id=${params.id} group by x.theme_id,y.theme_id`;
    // Nearest neighbours by embedding cosine similarity, independent of which interview a theme came from.
    const similar=await sql<{a:string;b:string;sim:number}[]>`
      select a.id as a,n.id as b,n.sim from themes a cross join lateral (
        select b.id,(1-(a.embedding<=>b.embedding))::float8 as sim from themes b
        where b.project_id=a.project_id and b.id<>a.id and b.embedding is not null
        order by a.embedding<=>b.embedding limit 4) n
      where a.project_id=${params.id} and a.embedding is not null`;
    return {project,nodes,links,similar};
  }finally{await sql.end({timeout:1});}
};
