import {translate} from '$lib/i18n';
import {error,type PageServerLoad} from '@sveltejs/kit';
import {connect} from '$lib/server/db';
export const load:PageServerLoad=async({params,platform,locals})=>{
  const sql=connect(platform);
  try{
    const p=await sql<{id:string;slug:string;title:string;question:string;description:string|null;capture_mode:'video'|'audio'|'either'}[]>`select id,slug,title,question,description,capture_mode from projects where slug=${params.slug} and status='open' limit 1`;
    if(!p.length)error(404,translate(locals.locale,'rec.notOpen'));
    return {project:p[0]};
  }finally{await sql.end({timeout:1});}
};
