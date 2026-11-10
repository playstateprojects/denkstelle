import {error,type RequestHandler} from '@sveltejs/kit';
import {connect} from '$lib/server/db';
import {requireAdmin} from '$lib/server/access';
import {mediaBucket} from '$lib/server/media';
export const GET:RequestHandler=async({params,locals,url,platform,request})=>{
  const u=requireAdmin(locals,url,platform);const sql=connect(platform);
  try{
    const rows=await sql<{media_key:string;mime_type:string;size_bytes:number}[]>`
      select s.media_key,s.mime_type,s.size_bytes from sources s join projects p on p.id=s.project_id join organization_members m on m.organization_id=p.organization_id
      where s.id=${params.id} and m.user_id=${u.id} and s.media_key is not null limit 1`;
    if(!rows.length)error(404,'Recording not found');
    const r=rows[0];const bucket=mediaBucket(platform);
    const range=request.headers.get('range');let offset=0;let length:number|undefined;
    if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m)error(416,'Invalid range');offset=Number(m[1]);if(offset>=r.size_bytes)error(416,'Range out of bounds');length=m[2]?Math.min(Number(m[2])-offset+1,r.size_bytes-offset):r.size_bytes-offset;}
    const obj=await bucket.get(r.media_key,range?{range:{offset,length}}:undefined);
    if(!obj)error(404,'Recording missing from storage');
    const headers:Record<string,string>={'Content-Type':r.mime_type,'Accept-Ranges':'bytes','Cache-Control':'private, no-store','Content-Disposition':'inline'};
    if(range){headers['Content-Range']=`bytes ${offset}-${offset+(length??0)-1}/${r.size_bytes}`;headers['Content-Length']=String(length);}else headers['Content-Length']=String(obj.size);
    return new Response(obj.body,{status:range?206:200,headers});
  }finally{await sql.end({timeout:1});}
};
