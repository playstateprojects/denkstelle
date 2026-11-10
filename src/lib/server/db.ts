import { env } from '$env/dynamic/private';
import postgres from 'postgres';

export function config(platform?: Readonly<App.Platform>) {
  const p=platform?.env;
  return {
    url:p?.HYPERDRIVE?.connectionString ?? p?.DATABASE_URL ?? env.DATABASE_URL,
    adminEmails:p?.ADMIN_EMAILS ?? env.ADMIN_EMAILS ?? '',
    authSecret:p?.BETTER_AUTH_SECRET ?? env.BETTER_AUTH_SECRET,
    authUrl:p?.BETTER_AUTH_URL ?? env.BETTER_AUTH_URL,
    resendKey:p?.RESEND_API_KEY ?? env.RESEND_API_KEY,
    emailFrom:p?.EMAIL_FROM ?? env.EMAIL_FROM,
    publicOrigin:p?.PUBLIC_ORIGIN ?? env.PUBLIC_ORIGIN
  };
}
export function connect(platform?: Readonly<App.Platform>) {
  const url=config(platform).url;
  if(!url) throw new Error('DATABASE_URL or HYPERDRIVE binding is missing');
  return postgres(url,{max:4,fetch_types:false});
}
export function approvedAdmin(email:string,platform?:Readonly<App.Platform>) {
  return config(platform).adminEmails.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean).includes(email.toLowerCase());
}
