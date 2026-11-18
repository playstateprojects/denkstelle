import type {PageServerLoad} from './$types';
import {connect} from '$lib/server/db';
import {requireAdmin} from '$lib/server/access';
/** The simulator is for signed-in administrators: it records as a per-admin simulator device (no secret in the browser). */
export const load:PageServerLoad=async({locals,url,platform})=>{
  const u=requireAdmin(locals,url,platform);const sql=connect(platform);
  try{
    const projects=await sql<{id:string;title:string;question:string;capture_mode:string}[]>`
      select p.id,p.title,p.question,p.capture_mode from projects p join organization_members m on m.organization_id=p.organization_id
      where m.user_id=${u.id} and p.status='open' order by p.created_at desc`;
    return {projects};
  }finally{await sql.end({timeout:1})}
};
