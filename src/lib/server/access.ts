import { error,redirect } from '@sveltejs/kit';
import { approvedAdmin } from './db';
import type postgres from 'postgres';

export function requireAdmin(locals:App.Locals,url:URL,platform?:Readonly<App.Platform>) {
  if(!locals.user) redirect(303,`/login?next=${encodeURIComponent(url.pathname)}`);
  if(!approvedAdmin(locals.user.email,platform)) error(403,'No access to this workspace');
  return locals.user;
}
/** Admins flagged in the database (hooks.server.ts sets locals.isAdmin for /admin routes). */
export function requireDbAdmin(locals:App.Locals) {
  if(!locals.user) error(401,'Not signed in');
  if(!locals.isAdmin) error(403,'Admins only');
  return locals.user;
}
export async function requireProjectAccess(sql:postgres.Sql,projectId:string,userId:string) {
  const rows=await sql<{id:string,title:string,slug:string,question:string,status:string,capture_mode:string}[]>`
    select p.id,p.title,p.slug,p.question,p.status,p.capture_mode from projects p
    join organization_members m on m.organization_id=p.organization_id
    where p.id=${projectId} and m.user_id=${userId} limit 1`;
  if(!rows.length) error(404,'Project not found');
  return rows[0];
}
