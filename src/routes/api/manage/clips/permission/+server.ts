import {json,type RequestHandler} from '@sveltejs/kit';
import {z} from 'zod';
import {connect} from '$lib/server/db';
import {authenticate,credentials,clipPurposes,POLICY} from '$lib/server/manage';
// allowed: true/false = explicit decision; null = reset to the recording-level permission.
const reqSchema=credentials.extend({highlightId:z.uuid(),purpose:z.enum(clipPurposes),allowed:z.boolean().nullable()});
export const POST:RequestHandler=async({request,platform})=>{
  const parsed=reqSchema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return json({error:'Invalid request'},{status:400});
  const {id,code,highlightId,purpose,allowed}=parsed.data;const sql=connect(platform);
  try{
    const s=await authenticate(sql,id,code);
    if(!s)return json({error:'Invalid recording ID or code'},{status:403});
    const own=await sql`select 1 from highlights where id=${highlightId} and source_id=${s.id}`;
    if(!own.length)return json({error:'Clip not found'},{status:404});
    await sql.begin(async tx=>{
      const set=async(p:string,a:boolean|null)=>{
        if(a===null)await tx`delete from highlight_permissions where highlight_id=${highlightId} and purpose=${p}`;
        else await tx`insert into highlight_permissions(highlight_id,purpose,allowed,policy_version) values(${highlightId},${p},${a},${POLICY})
          on conflict(highlight_id,purpose) do update set allowed=excluded.allowed,policy_version=excluded.policy_version,decided_at=now()`;
      };
      await set(purpose,allowed);
      // Social sharing is only ever a subset of public sharing: keep the two consistent.
      const eff=await tx<{purpose:string;allowed:boolean}[]>`
        select p.purpose,coalesce(hp.allowed,sp.allowed,false) as allowed from (values ('public_excerpt'),('social_media')) p(purpose)
        left join highlight_permissions hp on hp.highlight_id=${highlightId} and hp.purpose=p.purpose
        left join source_permissions sp on sp.source_id=${s.id} and sp.purpose=p.purpose`;
      const pub=eff.find(e=>e.purpose==='public_excerpt')?.allowed;const soc=eff.find(e=>e.purpose==='social_media')?.allowed;
      if(soc&&!pub){
        if(purpose==='social_media')await set('public_excerpt',true);
        else await set('social_media',false);
      }
    });
    return json({ok:true});
  } catch(e){console.error('[manage permission]',e);return json({error:'Could not save'},{status:500});}
  finally{await sql.end({timeout:1});}
};
