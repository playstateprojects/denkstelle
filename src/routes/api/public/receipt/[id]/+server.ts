import {json,type RequestHandler} from '@sveltejs/kit';
import {Resend} from 'resend';
import {connect,config} from '$lib/server/db';
import {sha256,constantTimeEqual} from '$lib/server/receipt';
export const POST:RequestHandler=async({request,params,platform,url})=>{
  const code=request.headers.get('X-Receipt-Code');if(!code||code.length!==64)return json({error:'Unauthorized'},{status:401});
  const sql=connect(platform);
  try{
    const rows=await sql<{receipt_email:string|null;receipt_token_hash:string;status:string;allowed:boolean|null}[]>`
      select s.receipt_email,s.receipt_token_hash,s.status,p.allowed from sources s
      left join source_permissions p on p.source_id=s.id and p.purpose='email_receipt'
      where s.id=${params.id} limit 1`;
    const s=rows[0];if(!s||!constantTimeEqual(s.receipt_token_hash,await sha256(code)))return json({error:'Unauthorized'},{status:401});
    if(!s.allowed||!s.receipt_email||s.status==='awaiting_upload')return json({error:'Email receipt not enabled'},{status:400});
    const cfg=config(platform);if(!cfg.resendKey)return json({error:'Email is not configured'},{status:503});
    const {error}=await new Resend(cfg.resendKey).emails.send({from:cfg.emailFrom??'Denkstelle <onboarding@resend.dev>',to:s.receipt_email,
      subject:'Dein Denkstelle-Beleg',text:`Danke fürs Mitdenken.\n\nDeine Aufnahme-ID: ${params.id}\nDein geheimer Verwaltungscode: ${code}\n\nAufnahme verwalten oder löschen: ${cfg.publicOrigin??url.origin}/manage#id=${params.id}&code=${code}\n\nBitte den Code nicht weitergeben.`});
    if(error)return json({error:'Email could not be sent'},{status:502});
    return json({ok:true});
  } finally{await sql.end({timeout:1});}
};
