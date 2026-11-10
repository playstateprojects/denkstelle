// Adapted from Space Between's Better Auth + Resend integration.
import { getRequestEvent } from '$app/server';
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import pg from 'pg';
import { Resend } from 'resend';
import { approvedAdmin,config } from './db';

export async function createAuth(platform?:Readonly<App.Platform>) {
  const cfg=config(platform);
  if(!cfg.url || !cfg.authSecret) throw new Error('Auth is not configured');
  const pool=new pg.Pool({connectionString:cfg.url,max:1});
  const auth=betterAuth({
    secret:cfg.authSecret,
    baseURL:cfg.authUrl,
    database:pool,
    rateLimit:{enabled:true,storage:'database'},
    plugins:[
      magicLink({expiresIn:600,sendMagicLink: async ({email,url})=>{
        // A public login request must not turn into an email relay.
        console.info(`[auth debug] sendMagicLink called for "${email}"; allowed=${approvedAdmin(email,platform)}; allowlist="${cfg.adminEmails}"; from="${cfg.emailFrom}"; hasKey=${!!cfg.resendKey}`);
        if(!approvedAdmin(email,platform)) return;
        if(!cfg.resendKey) { console.info(`[dev auth] magic link for ${email}: ${url}`); return; }
        const {error,data}=await new Resend(cfg.resendKey).emails.send({
          from:cfg.emailFrom ?? 'Denkstelle <onboarding@resend.dev>', to:email,
          subject:'Dein Schlüssel zur Denkstelle',text:`Dein Einmal-Link (10 Minuten): ${url}\n\nNicht angefordert? Einfach ignorieren.`
        });
        console.info('[auth debug] resend result', JSON.stringify({error,data}));
        if(error) throw new Error(error.message);
      }}),
      sveltekitCookies(getRequestEvent)
    ]
  });
  return {auth,close:()=>pool.end()};
}
