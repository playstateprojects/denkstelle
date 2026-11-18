/** Try Clairic as the statement extractor, over the frozen interview transcripts, and compare with the chat-model statements.
 *   node --env-file=.env --import tsx scripts/eval-clairic-statements.ts [--dir eval/transcripts/q1-better] [--set eval/statements/q1-better/deepseek-flash.jsonl] [--only en-01]
 * Needs R2_ACCOUNT_ID and WORKERS_AI_API_TOKEN (the same pair utils.ts uses for embeddings). Writes eval/results/clairic-statements-<ts>.jsonl.
 *
 * Clairic returns spans of its input, so the state is the transcript's segments joined by newlines, each with a known offset:
 * a span maps back to segment indexes by arithmetic, with no model-supplied citations to validate.
 */
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';

const arg=(n:string)=>{const i=process.argv.indexOf(`--${n}`);return i>=0?process.argv[i+1]:undefined};
const dir=arg('dir')??'eval/transcripts/q1-better',set=arg('set')??'eval/statements/q1-better/deepseek-flash.jsonl',only=arg('only');
const {R2_ACCOUNT_ID:account,WORKERS_AI_API_TOKEN:token}=process.env;
if(!account||!token)throw new Error('R2_ACCOUNT_ID and WORKERS_AI_API_TOKEN required');

const QUESTION='How could Motionlab be better?';
const INSTRUCTIONS=arg('instructions')??`Each distinct point the speaker makes that bears on the question "${QUESTION}": a problem, a wish, a suggestion or an opinion. Return the speaker's own words for it. Skip filler, greetings and small talk.`;

type Span=[number,number];
type Answer={value?:string[];spans?:Span[];confidence?:number};
async function clairic(state:string){
 const res=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/clairic`,{method:'POST',
  headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
  body:JSON.stringify({model:'clairic',state,fields:{statements:{type:'list',items:'text',instructions:INSTRUCTIONS}}}),signal:AbortSignal.timeout(60_000)});
 const body:any=await res.json().catch(()=>null);
 if(!res.ok)throw new Error(`Clairic ${res.status}: ${JSON.stringify(body).slice(0,400)}`);
 return body?.result??body;   // the REST API wraps the model output in `result`
}

const files=(await readdir(dir)).filter(f=>/^(de|en)-\d+\.json$/.test(f)&&(!only||f.startsWith(only))).sort();
const ref=new Map<string,{text:string;segment_indexes:number[]}[]>();
for(const l of (await readFile(set,'utf8')).split('\n').filter(x=>x.trim())){const r=JSON.parse(l);(ref.get(r.interview)??ref.set(r.interview,[]).get(r.interview)!).push(r)}

const out:any[]=[];let first=true;
for(const f of files){
 const t:{id:string;lang:string;texts:string[]}=JSON.parse(await readFile(`${dir}/${f}`,'utf8'));
 // Segment k occupies [starts[k], starts[k]+len) in the state; segments are separated by "\n".
 const starts:number[]=[];let pos=0;for(const s of t.texts){starts.push(pos);pos+=s.length+1}
 const state=t.texts.join('\n');
 const r=await clairic(state);
 if(first){console.log('raw response shape (first call):\n'+JSON.stringify(r,null,1).slice(0,1500)+'\n');first=false}
 const a:Answer=r.answers?.statements??{};
 const text:string=r.state_text??state;
 const items=(a.value??[]).map((v,i)=>{
  const sp=a.spans?.[i];
  const slice=sp?text.slice(sp[0],sp[1]):undefined;
  // Segments the span touches. Fall back to a text search if the offsets do not reproduce the value.
  let [lo,hi]=sp&&slice===v?sp:(()=>{const k=text.indexOf(v);return k>=0?[k,k+v.length]:[-1,-1]})();
  const segs:number[]=[];
  if(lo>=0)t.texts.forEach((s,k)=>{if(starts[k]<hi&&starts[k]+s.length>lo)segs.push(k)});
  return {text:v,span:sp,offsets_ok:slice===v,segment_indexes:segs};
 });
 out.push({interview:t.id,lang:t.lang,truncated:r.truncated,usage:r.usage,confidence:a.confidence,statements:items});
}

// Comparison. Per interview: how many statements each, and how well the cited segments line up.
const segsOf=(xs:{segment_indexes:number[]}[])=>new Set(xs.flatMap(x=>x.segment_indexes));
let totalC=0,totalR=0,bad=0,uncited=0,ok=0,n=0,jac=0;
console.log('interview  clairic  chat   coverage(jaccard of cited segments)  offsets_ok  truncated');
for(const o of out){
 const rs=ref.get(o.interview)??[],cs=o.statements as {segment_indexes:number[];offsets_ok:boolean}[];
 const a=segsOf(cs),b=segsOf(rs),inter=[...a].filter(x=>b.has(x)).length,union=new Set([...a,...b]).size;
 const j=union?inter/union:0;jac+=j;n++;totalC+=cs.length;totalR+=rs.length;
 ok+=cs.filter(c=>c.offsets_ok).length;uncited+=cs.filter(c=>!c.segment_indexes.length).length;
 console.log(`${o.interview.padEnd(10)} ${String(cs.length).padStart(6)}  ${String(rs.length).padStart(5)}   ${j.toFixed(2).padStart(6)}   ${cs.filter(c=>c.offsets_ok).length}/${cs.length}   ${o.truncated??'?'}`);
}
console.log(`\ntotal clairic ${totalC} vs chat ${totalR}; mean coverage jaccard ${(jac/Math.max(n,1)).toFixed(2)}; offsets reproduce the value for ${ok}/${totalC}; ${uncited} uncited`);

await mkdir('eval/results',{recursive:true});
const path=`eval/results/clairic-statements-${Date.now()}.jsonl`;
await writeFile(path,out.map(o=>JSON.stringify(o)).join('\n')+'\n');
console.log(`wrote ${path}`);

// Side by side for one interview, to eyeball whether the spans read as statements.
const eye=out.find(o=>o.interview===(only??'en-01'))??out[0];
if(eye){
 console.log(`\n--- ${eye.interview}: clairic ---`);for(const s of eye.statements)console.log(`  [${s.segment_indexes.join(',')}] ${s.text}`);
 console.log(`--- ${eye.interview}: chat model ---`);for(const s of ref.get(eye.interview)??[])console.log(`  [${s.segment_indexes.join(',')}] ${s.text}`);
}
