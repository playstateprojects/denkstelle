import {translate} from '$lib/i18n';
import { fail, type Actions, type PageServerLoad } from '@sveltejs/kit';
import { connect } from '$lib/server/db';
import { requireAdmin } from '$lib/server/access';
import { isCaptureMode } from '$lib/server/media';

export const load:PageServerLoad=async({locals,url,platform})=>{
  const u=requireAdmin(locals,url,platform);const sql=connect(platform);
  try{
    const projects=await sql<{id:string;slug:string;title:string;question:string;status:string;capture_mode:string;recordings:number}[]>`
      select p.id,p.slug,p.title,p.question,p.status,p.capture_mode,
      (select count(*)::int from sources s where s.project_id=p.id and s.kind in ('interview_video','audio')) as recordings
      from projects p join organization_members m on m.organization_id=p.organization_id
      where m.user_id=${u.id} order by p.created_at desc`;
    return {projects,email:u.email};
  } finally {await sql.end({timeout:1});}
};
export const actions:Actions={
  create:async({request,locals,url,platform})=>{
    const u=requireAdmin(locals,url,platform);const form=await request.formData();
    const title=String(form.get('title')??'').trim().slice(0,160);
    const question=String(form.get('question')??'').trim().slice(0,500);
    const modeRaw=String(form.get('capture_mode')??'video');
    const mode=isCaptureMode(modeRaw)?modeRaw:'video';
    if(!title||!question)return fail(400,{message:translate(locals.locale,'dash.missing')});
    const sql=connect(platform);
    try{
      const rows=await sql<{id:string}[]>`select organization_id as id from organization_members where user_id=${u.id} limit 1`;
      let org=rows[0]?.id;
      if(!org){
        const newOrg=await sql<{id:string}[]>`insert into organizations(name) values (${u.name||u.email}) returning id`;
        org=newOrg[0].id;
        await sql`insert into organization_members(organization_id,user_id,role) values (${org},${u.id},'owner')`;
      }
      const slug=`${title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'projekt'}-${crypto.randomUUID().slice(0,6)}`;
      const p=await sql<{id:string}[]>`insert into projects(organization_id,slug,title,question,status,capture_mode) values (${org},${slug},${title},${question},'open',${mode}) returning id`;
      return {created:p[0].id};
    }finally{await sql.end({timeout:1});}
  }
};
