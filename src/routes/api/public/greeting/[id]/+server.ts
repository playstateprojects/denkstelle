import {error,type RequestHandler} from '@sveltejs/kit';
import {connect} from '$lib/server/db';
import {mediaBucket} from '$lib/server/media';
/** The project's greeting audio, streamed from private R2. Public on purpose: it is the question a phone asks, which
 * the public recording page shows anyway, and handsets and <audio> elements cannot attach credentials. Nothing else
 * in the bucket is reachable from here. Supports Range because Safari refuses to play audio without it. */
export const GET:RequestHandler=async({params,platform,request})=>{
  if(!/^[0-9a-f-]{36}$/i.test(params.id??''))error(404,'No greeting');
  const sql=connect(platform);
  let row:{phone_greeting_key:string|null;phone_greeting_mime:string|null}|undefined;
  try{
    [row]=await sql<{phone_greeting_key:string|null;phone_greeting_mime:string|null}[]>`select phone_greeting_key,phone_greeting_mime from projects where id=${params.id} and status='open' limit 1`;
  }finally{await sql.end({timeout:1})}
  if(!row?.phone_greeting_key)error(404,'No greeting');
  const bucket=mediaBucket(platform);
  const head=await bucket.head(row.phone_greeting_key);
  if(!head)error(404,'Greeting missing from storage');
  const size=head.size;let offset=0;let length=size;let partial=false;
  const range=request.headers.get('range');
  if(range){
    const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||(!m[1]&&!m[2]))error(416,'Invalid range');
    if(!m[1]){offset=Math.max(0,size-Number(m[2]));length=size-offset}
    else{offset=Number(m[1]);if(offset>=size)error(416,'Range out of bounds');length=m[2]?Math.min(Number(m[2])-offset+1,size-offset):size-offset}
    partial=true;
  }
  const obj=await bucket.get(row.phone_greeting_key,partial?{range:{offset,length}}:undefined);
  if(!obj)error(404,'Greeting missing from storage');
  const headers:Record<string,string>={'Content-Type':row.phone_greeting_mime??'audio/mpeg','Accept-Ranges':'bytes','Content-Length':String(length),
    // The key changes on every upload, and the config URL carries ?v=, so a day of caching is safe.
    'Cache-Control':'public, max-age=86400'};
  if(partial)headers['Content-Range']=`bytes ${offset}-${offset+length-1}/${size}`;
  return new Response(obj.body,{status:partial?206:200,headers});
};
