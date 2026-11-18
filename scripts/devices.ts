/** Manage telephone devices (Raspberry Pi handsets).
 *   npm run devices -- create <project-slug-or-id> "<device name>"   prints the credential ONCE
 *   npm run devices -- list [project-slug-or-id]
 *   npm run devices -- revoke <device-id>
 *   npm run devices -- configure <device-id> maxDurationSeconds=120   (JSON values; empty value removes the key)
 *   npm run devices -- greeting <project-slug-or-id> <https://…/greeting.wav | none>
 */
import pg from 'pg';
import {newDeviceToken,sha256Hex} from '../src/lib/device-token.ts';

const [cmd,...args]=process.argv.slice(2);
const url=process.env.DATABASE_URL;if(!url)throw new Error('DATABASE_URL missing');
const db=new pg.Client({connectionString:url});
await db.connect();
const usage=()=>{throw new Error('Usage: npm run devices -- create|list|revoke|configure|greeting … (see header of scripts/devices.ts)')};
async function project(ref:string|undefined){
  if(!ref)usage();
  const r=await db.query(`select id,slug,title from projects where slug=$1 or id::text=$1 limit 1`,[ref]);
  if(!r.rowCount)throw new Error(`No project "${ref}"`);
  return r.rows[0] as {id:string;slug:string;title:string};
}
try{
  if(cmd==='create'){
    const p=await project(args[0]);const name=args[1]?.trim();if(!name)usage();
    const token=newDeviceToken();
    const r=await db.query(`insert into devices(project_id,name,kind,token_hash) values($1,$2,'handset',$3) returning id`,[p.id,name,await sha256Hex(token)]);
    console.log(`Device ${r.rows[0].id} created for "${p.title}" (${p.slug}).\n\nCredential (shown once, store it on the device):\n  ${token}\n`);
  }else if(cmd==='list'){
    const p=args[0]?await project(args[0]):null;
    const r=await db.query(`select d.id,d.name,d.kind,p.slug,d.revoked_at,d.last_seen_at,d.config from devices d join projects p on p.id=d.project_id ${p?'where d.project_id=$1':''} order by d.created_at`,p?[p.id]:[]);
    for(const d of r.rows)console.log(`${d.id}  ${d.kind.padEnd(9)} ${d.slug}  ${d.name}  ${d.revoked_at?'REVOKED':'active'}  last seen ${d.last_seen_at?.toISOString()??'never'}  ${JSON.stringify(d.config)}`);
    if(!r.rowCount)console.log('No devices');
  }else if(cmd==='revoke'){
    if(!args[0])usage();
    const r=await db.query(`update devices set revoked_at=coalesce(revoked_at,now()) where id::text=$1 returning name`,[args[0]]);
    console.log(r.rowCount?`Revoked "${r.rows[0].name}". Its credential stops working immediately.`:'No such device');if(!r.rowCount)process.exitCode=1;
  }else if(cmd==='configure'){
    if(!args[0]||args.length<2)usage();
    const cur=await db.query(`select config from devices where id::text=$1`,[args[0]]);
    if(!cur.rowCount)throw new Error('No such device');
    const config=cur.rows[0].config as Record<string,unknown>;
    for(const kv of args.slice(1)){
      const i=kv.indexOf('=');if(i<1)usage();
      const k=kv.slice(0,i),v=kv.slice(i+1);
      if(v==='')delete config[k];else{try{config[k]=JSON.parse(v)}catch{config[k]=v}}
    }
    await db.query(`update devices set config=$2 where id::text=$1`,[args[0],config]);
    console.log('config =',JSON.stringify(config));
  }else if(cmd==='greeting'){
    const p=await project(args[0]);const g=args[1];if(!g)usage();
    if(g!=='none'&&!/^https?:\/\/|^\//.test(g))throw new Error('Greeting must be an http(s) URL, a /path on this site, or "none"');
    await db.query(`update projects set phone_greeting_url=$2 where id=$1`,[p.id,g==='none'?null:g]);
    console.log(g==='none'?'Greeting removed (clients read the question aloud).':`Greeting for ${p.slug} set to ${g}`);
  }else usage();
}finally{await db.end();}
