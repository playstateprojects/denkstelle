import {json,type RequestHandler} from '@sveltejs/kit';
import {connect} from '$lib/server/db';
import {constantTimeEqual,sha256} from '$lib/server/receipt';
import {maxVideoBytes,mediaBucket,validVideoMime,validAudioMime,mediaExtension} from '$lib/server/media';
import {notifyJobs} from '$lib/server/jobs';
export const PUT:RequestHandler=async({request,params,platform})=>{
  const code=request.headers.get('X-Receipt-Code');if(!code||code.length!==64)return json({error:'Unauthorized'},{status:401});
  const mime=(request.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
  if(!validVideoMime(mime)&&!validAudioMime(mime))return json({error:'Unsupported media type'},{status:415});
  const len=Number(request.headers.get('content-length')??'0');
  if(len&&len>maxVideoBytes)return json({error:'Video too large (60 MB maximum)'},{status:413});
  if(!request.body)return json({error:'Empty upload'},{status:400});
  const sql=connect(platform);
  try {
    const rows=await sql<{id:string;project_id:string;receipt_token_hash:string;status:string;kind:string}[]>`select id,project_id,receipt_token_hash,status,kind from sources where id=${params.id} and kind in ('interview_video','audio') limit 1`;
    const s=rows[0];if(!s||!constantTimeEqual(s.receipt_token_hash,await sha256(code)))return json({error:'Unauthorized'},{status:401});
    if(s.status!=='awaiting_upload')return json({error:'Already uploaded'},{status:409});
    // The recording kind was fixed (and checked against the project's capture mode) in /api/public/start.
    if(s.kind==='audio'?!validAudioMime(mime):!validVideoMime(mime))return json({error:'Media type does not match this recording'},{status:415});
    // Keep media private: never a public R2 URL. This streaming upload is intentionally
    // capped at 60 MB, and the first pilot also caps recording time at 3 minutes.
    const ext=mediaExtension(mime);
    const key=`projects/${s.project_id}/sources/${s.id}/original.${ext}`;
    const bucket=mediaBucket(platform);
    // R2 needs a known-length body; buffer it (bounded by the 60 MB cap).
    const body=await request.arrayBuffer();
    if(body.byteLength>maxVideoBytes)return json({error:'Video too large (60 MB maximum)'},{status:413});
    await bucket.put(key,body,{httpMetadata:{contentType:mime},customMetadata:{sourceId:s.id}});
    const obj=await bucket.head(key);
    if(!obj||obj.size>maxVideoBytes){await bucket.delete(key);return json({error:'Video exceeded 60 MB'},{status:413});}
    const duration=Math.min(180000,Math.max(0,Number(request.headers.get('X-Duration-Ms')??'0')||0));
    await sql`update sources set media_key=${key},mime_type=${mime},size_bytes=${obj.size},duration_ms=${duration},status='uploaded',updated_at=now() where id=${s.id}`;
    await sql`insert into processing_jobs(source_id,kind,status) values(${s.id},'transcribe_and_ingest','queued')`;
    await notifyJobs(platform,'upload');
    return json({ok:true,sourceId:s.id,status:'queued'});
  }catch(e){console.error('[video upload]',e);return json({error:'Upload failed'},{status:500});}
  finally{await sql.end({timeout:1});}
};
