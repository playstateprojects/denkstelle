import {json,type RequestHandler} from '@sveltejs/kit';
import {z} from 'zod';
import {connect} from '$lib/server/db';
import {generateReceiptCode,sha256} from '$lib/server/receipt';
const input=z.object({mode:z.enum(['video','audio']).default('video'),slug:z.string().min(3).max(90),contributorLabel:z.string().max(100).optional(),email:z.email().optional(),
  consents:z.object({capture_analysis:z.literal(true),public_excerpt:z.boolean(),social_media:z.boolean(),email_receipt:z.boolean()})});
const POLICY='draft-2026-11-05';
export const POST:RequestHandler=async({request,platform})=>{
  const parsed=input.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return json({error:'Invalid consent form'},{status:400});
  const v=parsed.data;
  if(v.consents.social_media&&!v.consents.public_excerpt)return json({error:'Social permission requires public excerpt permission'},{status:400});
  if(v.consents.email_receipt&&!v.email)return json({error:'Email required for email receipt'},{status:400});
  if(!v.consents.email_receipt&&v.email)return json({error:'Email requires optional permission'},{status:400});
  const sql=connect(platform);
  try{
    const projects=await sql<{id:string;capture_mode:string}[]>`select id,capture_mode from projects where slug=${v.slug} and status='open' limit 1`;
    if(!projects.length)return json({error:'Project is closed'},{status:404});
    const allowed=projects[0].capture_mode;
    if(allowed!=='either'&&allowed!==v.mode)return json({error:`This project only accepts ${allowed} recordings`},{status:400});
    const kind=v.mode==='audio'?'audio':'interview_video';
    const code=generateReceiptCode();const digest=await sha256(code);
    const sources=await sql<{id:string}[]>`
      insert into sources(project_id,kind,role,title,contributor_label,receipt_email,receipt_token_hash)
      values(${projects[0].id},${kind},'contribution','Denkstelle Interview',${v.contributorLabel??null},${v.email??null},${digest}) returning id`;
    const sourceId=sources[0].id;
    for(const [purpose,allowed] of Object.entries(v.consents))
      await sql`insert into source_permissions(source_id,purpose,allowed,policy_version) values(${sourceId},${purpose},${allowed},${POLICY})`;
    return json({sourceId,receiptCode:code});
  } finally {await sql.end({timeout:1});}
};
