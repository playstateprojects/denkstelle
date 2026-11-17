/** Run theme placement over a frozen statement set, in memory, several times in different orders.
 *   npm run eval:themes -- [--set eval/statements/q1-better/deepseek-flash] [--runs 3] [--seed 1] [--member 0.6] [--settle 0.5] [--no-rewrite] [--no-settle]
 * Reads <set>.jsonl (one statement per line, field `text`) and <set>.emb.json (a vector per line, same order).
 * Calls Jev and the chat model for real, so it needs TYPESAFE_API_KEY and a chat model key; it writes nothing to a database.
 * Run 0 is the original order, the rest are shuffled: how much the themes move between runs is the order sensitivity.
 * Agreement is pair-level: for two statements, do they share a theme? It handles statements in several themes.
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {DEFAULT_MODEL} from '../worker/src/models.ts';
import {DEFAULT_PROMPTS} from '../worker/src/prompts.ts';
import {placeAll,jevJudge,modelNamer,modelRewriter,THEME_JEV_VERSION,THRESHOLDS,REWRITE_EVERY,type Judge} from '../worker/src/theme-match.ts';
import {MemoryStore} from '../worker/src/theme-memory.ts';

const arg=(n:string)=>{const i=process.argv.indexOf(`--${n}`);return i>=0?process.argv[i+1]:undefined};
const set=arg('set')??'eval/statements/q1-better/deepseek-flash',runs=Number(arg('runs')??3),seed=Number(arg('seed')??1);
const thresholds={...THRESHOLDS,member:Number(arg('member')??THRESHOLDS.member),settle:Number(arg('settle')??THRESHOLDS.settle)};
const rows=(await readFile(`${set}.jsonl`,'utf8')).split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l) as {text:string;interview?:string;idx?:number});
const vecs:number[][]=JSON.parse(await readFile(`${set}.emb.json`,'utf8'));
if(vecs.length!==rows.length)throw new Error(`${rows.length} statements but ${vecs.length} vectors`);
const statements=rows.map((r,i)=>({id:`s${i}`,text:r.text,vec:vecs[i]}));

// A small seeded shuffle, so a run can be repeated.
const rng=(s:number)=>()=>{s=(s*1664525+1013904223)>>>0;return s/2**32};
const shuffled=<T>(a:T[],r:()=>number)=>{const b=[...a];for(let i=b.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[b[i],b[j]]=[b[j],b[i]]}return b};

const judge:Judge=jevJudge(process.env),name=modelNamer(process.env,DEFAULT_MODEL,DEFAULT_PROMPTS);
// --no-rewrite turns off the rewrite-every-${REWRITE_EVERY} step, to see what it changes.
const rewrite=process.argv.includes('--no-rewrite')?undefined:modelRewriter(process.env,DEFAULT_MODEL,DEFAULT_PROMPTS);
type Run={decisions:{id:string;pass:number;kind:string;judged:{themeId:string;p:number}[]}[];themeNames:Record<string,string>;order:string[];themes:{name:string;statements:string[]}[];pending:string[];jevCalls:number;renames:{from:string;to:string;size:number}[]};
const results:Run[]=[],settled:number[]=[];
for(let r=0;r<runs;r++){
 const order=r===0?statements.map(s=>s.id):shuffled(statements.map(s=>s.id),rng(seed+r));
 const store=new MemoryStore(statements);let calls=0;
 const deps={store,judge:async(i:Parameters<typeof judge>[0])=>{calls++;return judge(i)},name,rewrite,thresholds};
 const decisions:Run['decisions']=[];
 const run=await placeAll(deps,order.map(id=>statements.find(s=>s.id===id)!),{settle:!process.argv.includes('--no-settle'),onPlaced:(st,placed,pass)=>{decisions.push({id:st.id,pass,kind:placed.placement.kind,judged:placed.judged})}});
 settled.push(run.settled.length);
 const members=store.members();
 results.push({decisions,themeNames:Object.fromEntries([...store.themes.values()].map(t=>[t.id,t.name])),order,themes:[...store.themes.values()].map(t=>({name:t.name,statements:members.get(t.id)??[]})),pending:[...store.status].filter(([,v])=>v==='pending').map(([k])=>k),jevCalls:calls,renames:store.renames.map(({from,to,size})=>({from,to,size}))});
 console.log(`run ${r}: ${results[r].themes.length} themes, ${results[r].themes.filter(t=>t.statements.length===1).length} single-statement, ${results[r].pending.length} pending, ${settled[r]} settled in pass 2, ${results[r].renames.length} rewrites, ${calls} Jev calls`);
}

const pairs=(run:Run)=>{const out=new Set<string>();for(const t of run.themes)for(const a of t.statements)for(const b of t.statements)if(a<b)out.add(`${a}|${b}`);return out};
const f1=(a:Set<string>,b:Set<string>)=>{let both=0;for(const x of a)if(b.has(x))both++;const p=a.size?both/a.size:0,q=b.size?both/b.size:0;return p+q?2*p*q/(p+q):0};
if(runs>1){
 console.log('\nPair agreement between runs (F1 over statement pairs that share a theme):');
 for(let i=0;i<runs;i++)for(let j=i+1;j<runs;j++)console.log(`  run ${i} vs ${j}: ${f1(pairs(results[i]),pairs(results[j])).toFixed(2)}`);
}
console.log('\nRewrites in run 0:');
for(const x of results[0].renames)console.log(`  at ${String(x.size).padStart(3)} statements: "${x.from}" -> "${x.to}"`);
console.log('\nThemes of run 0:');
for(const t of [...results[0].themes].sort((a,b)=>b.statements.length-a.statements.length))console.log(`  ${String(t.statements.length).padStart(3)}  ${t.name}`);

await mkdir('eval/results',{recursive:true});
const file=`eval/results/themes-${THEME_JEV_VERSION}-${Date.now()}.json`;
await writeFile(file,JSON.stringify({set,jev:THEME_JEV_VERSION,thresholds,statements:statements.map(({id,text})=>({id,text})),runs:results},null,1));
console.log(`\nSaved ${file}`);
