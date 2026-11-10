import {json,type RequestHandler} from '@sveltejs/kit';
import {z} from 'zod';
import {connect} from '$lib/server/db';
import {authenticate,credentials} from '$lib/server/manage';
import {mediaBucket} from '$lib/server/media';
const reqSchema=credentials.extend({highlightId:z.uuid()});
// POST rather than GET so the private code never appears in a URL or access log.
export const POST:RequestHandler=async({request,platform})=>{
  const parsed=reqSchema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return json({error:'Invalid request'},{status:400});
  const {id,code,highlightId}=parsed.data;const sql=connect(platform);
  try{
    const s=await authenticate(sql,id,code);
    if(!s)return json({error:'Invalid recording ID or code'},{status:403});
    const rows=await sql<{media_key:string}[]>`select media_key from highlights where id=${highlightId} and source_id=${s.id} and status='rendered' and media_key is not null`;
    if(!rows.length)return json({error:'Clip not rendered yet'},{status:404});
    const obj=await mediaBucket(platform).get(rows[0].media_key);
    if(!obj)return json({error:'Clip unavailable'},{status:404});
    return new Response(obj.body,{headers:{'Content-Type':'video/mp4','Cache-Control':'private, no-store'}});
  } catch(e){console.error('[manage preview]',e);return json({error:'Could not load preview'},{status:500});}
  finally{await sql.end({timeout:1});}
};
