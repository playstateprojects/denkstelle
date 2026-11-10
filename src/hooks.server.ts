import { building } from '$app/environment';
import { createAuth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import type { Handle } from '@sveltejs/kit';
import { detectLocale } from '$lib/i18n';
import { connect } from '$lib/server/db';

const isAdminPath=(p:string)=>p==='/admin'||p.startsWith('/admin/')||p.startsWith('/api/admin/');
// Admins are flagged in the database, not by the ADMIN_EMAILS login allowlist.
async function dbAdmin(userId:string,platform:App.Platform|undefined){
  const sql=connect(platform);
  try{const rows=await sql<{is_admin:boolean}[]>`select is_admin from "user" where id=${userId}`;return rows[0]?.is_admin===true;}
  catch(e){console.error('[admin check failed]',e);return false;}
  finally{await sql.end({timeout:1}).catch(()=>{});}
}

export const handle:Handle=async({event,resolve})=>{
  event.locals.user=null; event.locals.session=null; event.locals.isAdmin=false;
  const locale=detectLocale(event.cookies.get('lang'),event.request.headers.get('accept-language'));
  event.locals.locale=locale;
  const resolveLocalized:typeof resolve=(e,o)=>resolve(e,{...o,transformPageChunk:({html})=>html.replace('<html lang="de">',`<html lang="${locale}">`)});
  if(building) return resolveLocalized(event);
  let close:(()=>Promise<void>)|undefined;
  try {
    const instance=await createAuth(event.platform);
    close=instance.close;
    const session=await instance.auth.api.getSession({headers:event.request.headers});
    event.locals.user=session?.user ? {id:session.user.id,email:session.user.email,name:session.user.name}:null;
    event.locals.session=session?.session?{id:session.session.id,userId:session.session.userId}:null;
    if(isAdminPath(event.url.pathname)){
      // One gate for every admin page, form action and API route; handlers re-check via requireDbAdmin.
      if(!event.locals.user){
        if(event.url.pathname.startsWith('/api/')) return new Response('Not signed in',{status:401});
        return new Response(null,{status:303,headers:{location:`/login?next=${encodeURIComponent(event.url.pathname+event.url.search)}`}});
      }
      event.locals.isAdmin=await dbAdmin(event.locals.user.id,event.platform);
      if(!event.locals.isAdmin) return new Response('Admins only',{status:403});
    }
    return await svelteKitHandler({auth:instance.auth,event,resolve:resolveLocalized,building});
  } catch(e) {
    if(e instanceof Error && e.message==='Auth is not configured') {
      if(event.url.pathname.startsWith('/api/auth/')) return new Response('Authentication is not configured',{status:503});
      return resolveLocalized(event);
    }
    throw e;
  } finally {await close?.().catch(()=>{});}
};
