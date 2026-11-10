/** Flag a user as an admin (or remove the flag): `npm run admin:grant -- you@example.com [--revoke]`.
 * The user must have signed in once, so their row exists. Admins can open /admin.
 */
import pg from 'pg';

const email=process.argv.slice(2).find(a=>!a.startsWith('--'));
const revoke=process.argv.includes('--revoke');
if(!email)throw new Error('Usage: npm run admin:grant -- you@example.com [--revoke]');
const url=process.env.DATABASE_URL;if(!url)throw new Error('DATABASE_URL missing');
const db=new pg.Client({connectionString:url});
await db.connect();
try{
  const r=await db.query('update "user" set is_admin=$2 where lower(email)=lower($1) returning email',[email,!revoke]);
  console.log(r.rowCount?`${r.rows[0].email} is ${revoke?'no longer':'now'} an admin`:`No user with email ${email}. Sign in once first so the account exists, then run this again.`);
  if(!r.rowCount)process.exitCode=1;
}finally{await db.end();}
