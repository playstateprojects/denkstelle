/** Label candidate pairs by hand and append them to the eval set. Resumable: pairs already in --out are skipped.
 *   npm run label:pairs -- [--in eval/candidates.jsonl] [--out eval/pairs.jsonl]
 * At the prompt type a number, optionally followed by a note ("4 one team vs whole company"). s = skip, u = undo last, q = quit.
 * Label without running any model first; the point of this set is that the labels are yours.
 */
import {readFile,appendFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createInterface} from 'node:readline/promises';
import {RELATIONS} from '../worker/src/insight-eval.ts';

const arg=(n:string)=>{const i=process.argv.indexOf(`--${n}`);return i>=0?process.argv[i+1]:undefined};
const IN=arg('in')??'eval/candidates.jsonl',OUT=arg('out')??'eval/pairs.jsonl';
const lines=async(f:string)=>existsSync(f)?(await readFile(f,'utf8')).split('\n').filter(l=>l.trim()&&!l.startsWith('//')):[];

const cands=(await lines(IN)).map(l=>JSON.parse(l) as {id:string;from:string;to:string});
if(!cands.length)throw new Error(`no candidates in ${IN}; run npm run mine:pairs first`);
let done=(await lines(OUT)).map(l=>JSON.parse(l) as {id:string});
const todo=cands.filter(c=>!done.some(d=>d.id===c.id));

const HELP:Record<string,string>={
 equivalent:'same claim; one could replace the other',
 supports:'A is evidence for / an instance of B',
 elaborates:'A adds detail, cause or condition to B (B more general)',
 contradicts:'cannot both be true of the same situation',
 related:'same topic, none of the above',
 unrelated:'different topics',
 insufficient_context:"can't tell without more context",
};
console.log('\nRelations (A -> B):');RELATIONS.forEach((r,i)=>console.log(`  ${i+1} ${r.padEnd(21)} ${HELP[r]}`));
console.log(`\n${done.length} labelled, ${todo.length} to go. Use "s" to skip, "u" to undo, "q" to quit.\n`);

const rl=createInterface({input:process.stdin}),lineIter=rl[Symbol.asyncIterator]();
const ask=async()=>{process.stdout.write('> ');const r=await lineIter.next();if(r.done)return'q';if(!process.stdin.isTTY)console.log(r.value);return(r.value as string).trim()};
const counts=()=>RELATIONS.map(r=>`${r}=${done.filter(d=>(d as {gold?:string}).gold===r).length}`).join(' ');
let n=0;
for(const c of todo){
 console.log(`[${++n}/${todo.length}] ${c.id}\n  A: ${c.from}\n  B: ${c.to}`);
 for(;;){
  const ans=await ask();
  if(ans==='q'){await finish();}
  if(ans==='s')break;
  if(ans==='u'){
   if(!done.length){console.log('nothing to undo');continue}
   const last=done.pop()!;
   const all=(await lines(OUT)).slice(0,-1);await writeFile(OUT,all.length?all.join('\n')+'\n':'');
   console.log(`undid ${last.id}; re-run to relabel it`);continue;
  }
  const m=ans.match(/^([1-7])\s*(.*)$/);
  if(!m){console.log('type 1-7, s, u or q');continue}
  const gold=RELATIONS[+m[1]-1],rec={id:c.id,from:c.from,to:c.to,gold,...(m[2]?{note:m[2]}:{})};
  await appendFile(OUT,JSON.stringify(rec)+'\n');done.push(rec);
  console.log(`  -> ${gold}\n`);break;
 }
}
await finish();

async function finish():Promise<never>{
 rl.close();
 console.log(`\n${done.length} labelled in ${OUT}\n${counts()}`);
 process.exit(0);
}
