import {json,type RequestHandler} from '@sveltejs/kit';
import {z} from 'zod';
import {connect} from '$lib/server/db';
import {sha256,constantTimeEqual} from '$lib/server/receipt';
import {mediaBucket} from '$lib/server/media';
const reqSchema=z.object({id:z.uuid(),code:z.string().length(64)});
export const POST:RequestHandler=async({request,platform})=>{
  const parsed=reqSchema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return json({error:'Invalid request'},{status:400});
  const {id,code}=parsed.data;const sql=connect(platform);
  try{
    const rows=await sql<{receipt_token_hash:string;media_key:string|null;project_id:string}[]>`select receipt_token_hash,media_key,project_id from sources where id=${id} limit 1`;
    const s=rows[0];if(!s||!constantTimeEqual(s.receipt_token_hash,await sha256(code)))return json({error:'Invalid recording ID or code'},{status:403});
    // Revoke publication permissions before removing controlled assets.
    await sql`update source_permissions set allowed=false,withdrawn_at=now() where source_id=${id}`;
    const clips=await sql<{media_key:string|null}[]>`select media_key from highlights where source_id=${id}`;
    const bucket=mediaBucket(platform);
    const keys=[s.media_key,...clips.map(c=>c.media_key)].filter((x):x is string=>!!x);
    for(const k of keys)await bucket.delete(k);
    // Theme reels that include this person: remove the rendered file (it contains their footage) and send the reel
    // back to the draft state. Their clips cascade away with the source, so a re-render cannot reuse them.
    const reels=await sql<{id:string;media_key:string|null}[]>`select distinct r.id,r.media_key from reels r join reel_clips c on c.reel_id=r.id where c.source_id=${id}`;
    for(const r of reels)if(r.media_key)await bucket.delete(r.media_key);
    if(reels.length)await sql`update reels set media_key=null,status=case when status in ('rendered','rendering') then 'composed' else status end where id in ${sql(reels.map(r=>r.id))}`;
    await sql`delete from sources where id=${id}`;
    // Remove derived project reports and themes with no surviving source evidence.
    await sql`delete from project_reports where project_id=${s.project_id}`;
    await sql`delete from themes t where t.project_id=${s.project_id} and not exists (select 1 from statement_themes st where st.theme_id=t.id)`;
    return json({ok:true});
  } catch(e){console.error('[delete]',e);return json({error:'Deletion could not complete; contact the project administrator'},{status:500});}
  finally{await sql.end({timeout:1});}
};
