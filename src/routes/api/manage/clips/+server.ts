import {json,type RequestHandler} from '@sveltejs/kit';
import {connect} from '$lib/server/db';
import {authenticate,credentials} from '$lib/server/manage';
type Row={id:string;title:string;reason:string|null;start_ms:number;end_ms:number;status:string;rendered:boolean;
  public_excerpt:boolean;public_explicit:boolean;social_media:boolean;social_explicit:boolean};
export const POST:RequestHandler=async({request,platform})=>{
  const parsed=credentials.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return json({error:'Invalid request'},{status:400});
  const sql=connect(platform);
  try{
    const s=await authenticate(sql,parsed.data.id,parsed.data.code);
    if(!s)return json({error:'Invalid recording ID or code'},{status:403});
    // Effective permission = explicit clip decision if present, else the recording-level permission.
    const clips=await sql<Row[]>`
      select h.id,h.title,h.reason,h.start_ms,h.end_ms,h.status,(h.status='rendered' and h.media_key is not null) as rendered,
        coalesce(pe.allowed,sp_pub.allowed,false) as public_excerpt,pe.allowed is not null as public_explicit,
        coalesce(pos.allowed,sp_soc.allowed,false) as social_media,pos.allowed is not null as social_explicit
      from highlights h
      left join highlight_permissions pe on pe.highlight_id=h.id and pe.purpose='public_excerpt'
      left join highlight_permissions pos on pos.highlight_id=h.id and pos.purpose='social_media'
      left join source_permissions sp_pub on sp_pub.source_id=h.source_id and sp_pub.purpose='public_excerpt'
      left join source_permissions sp_soc on sp_soc.source_id=h.source_id and sp_soc.purpose='social_media'
      where h.source_id=${s.id} and h.status in ('suggested','approved','rendered')
      order by h.start_ms`;
    return json({clips});
  } catch(e){console.error('[manage clips]',e);return json({error:'Could not load clips'},{status:500});}
  finally{await sql.end({timeout:1});}
};
