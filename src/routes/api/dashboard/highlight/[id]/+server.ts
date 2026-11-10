import {error,type RequestHandler} from '@sveltejs/kit';
import {connect} from '$lib/server/db';
import {requireAdmin} from '$lib/server/access';
import {mediaBucket} from '$lib/server/media';
export const GET:RequestHandler=async({params,locals,url,platform})=>{
  const u=requireAdmin(locals,url,platform);const sql=connect(platform);
  try{
    const rows=await sql<{media_key:string}[]>`select h.media_key from highlights h join sources s on s.id=h.source_id join projects p on p.id=s.project_id join organization_members m on m.organization_id=p.organization_id where h.id=${params.id} and m.user_id=${u.id} and h.status='rendered' limit 1`;
    if(!rows.length)error(404,'Not found');const obj=await mediaBucket(platform).get(rows[0].media_key);
    if(!obj)error(404,'Video unavailable');return new Response(obj.body,{headers:{'Content-Type':'video/mp4','Cache-Control':'private, no-store'}});
  }finally{await sql.end({timeout:1});}
};
