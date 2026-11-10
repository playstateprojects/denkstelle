/** HTTP front for the processing container. Cloudflare reaches it only through the processor Worker.
 *   POST /drain   work through all due jobs (one at a time), respond when done
 *   GET  /status  { busy }  (the Container class asks this before letting the instance sleep)
 *   GET  /health
 * The caller keeps the /drain request open while we work: that open request is what keeps the container awake.
 */
import {createServer} from 'node:http';
import type {Sql} from 'postgres';
import {database} from './utils.ts';
import {drainQueue,type DrainResult} from './drain.ts';

const PORT=Number(process.env.PORT??8080);
// Stop claiming new jobs after this long so one request never outlives the caller's 15-minute limit.
const DRAIN_BUDGET_MS=8*60*1000;

let sql:Sql|null=null;
const db=()=>sql??(sql=database());
let draining:Promise<DrainResult>|null=null;
let pokedWhileBusy=false;
let stopping=false;

/** Concurrent /drain calls join the running drain instead of starting a second one. */
function drain():Promise<DrainResult>{
  if(draining){pokedWhileBusy=true;return draining;}
  pokedWhileBusy=false;
  const run=drainQueue(db(),{maxMs:DRAIN_BUDGET_MS,shouldStop:()=>stopping,onPoke:()=>{const again=pokedWhileBusy;pokedWhileBusy=false;return again;}});
  const tracked=run.finally(()=>{draining=null;});
  draining=tracked;
  return tracked;
}

const json=(res:import('node:http').ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};

const server=createServer(async(req,res)=>{
  try{
    if(req.method==='GET'&&req.url==='/health')return json(res,200,{ok:true});
    if(req.method==='GET'&&req.url==='/status')return json(res,200,{busy:draining!==null});
    if(req.method==='POST'&&req.url==='/drain')return json(res,200,await drain());
    json(res,404,{error:'not found'});
  }catch(err){
    console.error('[drain] failed:',err);
    json(res,500,{error:String(err).slice(0,500)});
  }
});
server.listen(PORT,()=>console.log(`denkstelle worker listening on :${PORT}`));

// Cloudflare sends SIGTERM on deploys/host moves and waits up to 15 minutes: finish the current job, claim no more.
process.on('SIGTERM',async()=>{
  console.log('SIGTERM: finishing current job, then exiting');
  stopping=true;
  try{await draining;}catch{}
  server.close();
  await sql?.end({timeout:5}).catch(()=>{});
  process.exit(0);
});
