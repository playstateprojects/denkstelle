import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const url=process.env.DATABASE_URL;
if(!url)throw new Error('DATABASE_URL missing');
const db=new pg.Client({connectionString:url});
await db.connect();
try{
  await db.query(`create table if not exists schema_migrations(
    name text primary key,
    checksum text not null,
    applied_at timestamptz not null default now()
  )`);
  const applied=new Map<string,string>(
    (await db.query('select name,checksum from schema_migrations')).rows.map(r=>[r.name,r.checksum])
  );
  const files=(await readdir('db')).filter(n=>n.endsWith('.sql')).sort();
  let count=0;
  for(const f of files){
    const sql=await readFile(path.join('db',f),'utf8');
    const checksum=createHash('sha256').update(sql).digest('hex');
    const prev=applied.get(f);
    if(prev){
      if(prev!==checksum)console.warn(`Warning: ${f} changed since it was applied (not re-run)`);
      continue;
    }
    console.log('Applying',f);
    try{
      await db.query('begin');
      await db.query(sql);
      await db.query('insert into schema_migrations(name,checksum) values($1,$2)',[f,checksum]);
      await db.query('commit');
      count++;
    }catch(e){
      await db.query('rollback');
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    }
  }
  console.log(count?`Applied ${count} migration(s)`:'Already up to date');
}finally{await db.end();}
