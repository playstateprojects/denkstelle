/** Mine UNLABELLED candidate pairs for the relation eval from a public review dataset (sealuzh/app_reviews on Hugging Face).
 *   npm run mine:pairs -- [--count 60] [--chunks 12] [--seed 1] [--out eval/candidates.jsonl]
 * Then label them with `npm run label:pairs`. No API key needed; rows come from the HF datasets-server.
 * Pairs are mined from heuristic buckets (similar wording, negation flips, star-rating splits, containment, mid and cross-app)
 * so the set contains hard cases. The bucket is written to a sidecar file, NOT the candidates file, so it can't bias labelling.
 * Caveat: the dataset's licence is "unknown". Keep outputs local (they are git-ignored) and use them for internal evaluation only.
 */
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

const arg=(n:string)=>{const i=process.argv.indexOf(`--${n}`);return i>=0?process.argv[i+1]:undefined};
const WANT=+(arg('count')??60),CHUNKS=+(arg('chunks')??12),SEED=+(arg('seed')??1),OUT=arg('out')??'eval/candidates.jsonl';
const META=OUT.replace(/\.jsonl$/,'')+'.meta.json';
const DATASET='sealuzh/app_reviews',TOTAL=288065,CHUNK=100;

function rng(a:number){return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const rnd=rng(SEED);
const shuffle=<T,>(a:T[])=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};

type Row={package_name:string;review:string;star:number};
async function fetchRows(offset:number):Promise<Row[]>{
 const url=`https://datasets-server.huggingface.co/rows?dataset=${DATASET}&config=default&split=train&offset=${offset}&length=${CHUNK}`;
 for(let attempt=0;attempt<3;attempt++){
  const r=await fetch(url);
  if(r.ok)return((await r.json()) as {rows:{row:Row}[]}).rows.map(x=>x.row);
  await new Promise(res=>setTimeout(res,1000*(attempt+1)));
 }
 throw new Error(`failed to fetch rows at offset ${offset}`);
}

type Sent={text:string;app:string;review:number;star:number;toks:string[];neg:boolean};
const STOP=new Set('a an the and or but if so of to in on at for with it its this that is are was were be been am i me my we our you your they them he she not no never nor do does did have has had will would can could just very really too also as by from up out all any some than then when what which who how there here get got one'.split(' '));
const NEG=/\b(not|never|no|cannot|can't|won't|doesn't|don't|didn't|isn't|wasn't|aren't|nothing|without|useless|worst)\b|n't\b/i;
const tok=(s:string)=>(s.toLowerCase().match(/[a-z']+/g)??[]).map(w=>w.replace(/'s$/,'').replace(/s$/,'')).filter(w=>w.length>2&&!STOP.has(w));
const sentences=(t:string)=>t.replace(/\s+/g,' ').split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(s=>{const n=s.split(' ').length;return n>=6&&n<=30&&/[a-z]/i.test(s)});

console.error(`Fetching ${CHUNKS} random chunks of ${CHUNK} reviews from ${DATASET}...`);
const rows:Row[]=[];
for(let i=0;i<CHUNKS;i++)rows.push(...await fetchRows(Math.floor(rnd()*(TOTAL-CHUNK))));
const sents:Sent[]=[],seen=new Set<string>();
rows.forEach((r,ri)=>{for(const s of sentences(r.review)){const k=s.toLowerCase();if(seen.has(k))continue;seen.add(k);const toks=tok(s);if(toks.length>=3)sents.push({text:s,app:r.package_name,review:ri,star:r.star,toks,neg:NEG.test(s)})}});
console.error(`${rows.length} reviews -> ${sents.length} usable sentences across ${new Set(sents.map(s=>s.app)).size} apps`);

const df=new Map<string,number>();
for(const s of sents)for(const w of new Set(s.toks))df.set(w,(df.get(w)??0)+1);
const idf=(w:string)=>Math.log((sents.length+1)/((df.get(w)??0)+1))+1;
const vec=sents.map(s=>{const m=new Map<string,number>();for(const w of s.toks)m.set(w,(m.get(w)??0)+idf(w));return m});
const norm=vec.map(v=>Math.sqrt([...v.values()].reduce((a,x)=>a+x*x,0)));
const sets=sents.map(s=>new Set(s.toks));
function cosine(i:number,j:number){let d=0;const[a,b]=vec[i].size<vec[j].size?[vec[i],vec[j]]:[vec[j],vec[i]];for(const[w,x]of a){const y=b.get(w);if(y)d+=x*y}return d/(norm[i]*norm[j]||1)}
function overlap(i:number,j:number){let c=0;for(const w of sets[i])if(sets[j].has(w))c++;return c/Math.min(sets[i].size,sets[j].size)}

type Cand={i:number;j:number;sim:number;ov:number};
const byApp=new Map<string,number[]>();sents.forEach((s,i)=>byApp.set(s.app,[...(byApp.get(s.app)??[]),i]));
const same:Cand[]=[];
for(const idx of byApp.values())for(let a=0;a<idx.length;a++)for(let b=a+1;b<idx.length;b++){
 const i=idx[a],j=idx[b];if(sents[i].review===sents[j].review)continue;
 const sim=cosine(i,j);if(sim>0&&sim<0.97)same.push({i,j,sim,ov:overlap(i,j)});
}
const cross:Cand[]=[];
for(let n=0;n<20000&&sents.length>1;n++){const i=Math.floor(rnd()*sents.length),j=Math.floor(rnd()*sents.length);if(sents[i].app!==sents[j].app)cross.push({i,j,sim:cosine(i,j),ov:0})}

const len=(i:number)=>sents[i].text.split(' ').length;
const buckets:{name:string;share:number;pool:Cand[]}[]=[
 {name:'negation-flip',share:.15,pool:same.filter(c=>c.sim>=.2&&sents[c.i].neg!==sents[c.j].neg).sort((a,b)=>b.sim-a.sim)},
 {name:'star-split',share:.15,pool:same.filter(c=>c.sim>=.15&&Math.abs(sents[c.i].star-sents[c.j].star)>=3).sort((a,b)=>b.sim-a.sim)},
 {name:'containment',share:.15,pool:same.filter(c=>c.ov>=.6&&Math.max(len(c.i),len(c.j))/Math.min(len(c.i),len(c.j))>=1.6&&c.sim>=.25).sort((a,b)=>b.sim-a.sim)},
 {name:'near',share:.25,pool:same.filter(c=>c.sim>=.35).sort((a,b)=>b.sim-a.sim)},
 {name:'same-app-mid',share:.15,pool:shuffle(same.filter(c=>c.sim>=.05&&c.sim<.2))},
 {name:'cross-app',share:.15,pool:cross.sort((a,b)=>b.sim-a.sim)},
];
const used=new Set<number>(),picked:{c:Cand;bucket:string}[]=[],nApps=byApp.size;
for(const b of buckets){
 const quota=Math.round(WANT*b.share),perApp=Math.max(2,Math.ceil(quota*2/Math.max(nApps,1))),appCount=new Map<string,number>();let got=0;
 for(const c of b.pool){
  if(got>=quota)break;
  const app=sents[c.i].app;
  if(used.has(c.i)||used.has(c.j)||(appCount.get(app)??0)>=perApp)continue;
  used.add(c.i);used.add(c.j);appCount.set(app,(appCount.get(app)??0)+1);picked.push({c,bucket:b.name});got++;
 }
 console.error(`  ${b.name.padEnd(14)} ${got}/${quota}`);
}

const final=shuffle(picked).map((p,k)=>{
 const flip=rnd()<.5,[i,j]=flip?[p.c.j,p.c.i]:[p.c.i,p.c.j],id=`ar-${String(k+1).padStart(3,'0')}`;
 return{pair:{id,from:sents[i].text,to:sents[j].text},meta:{id,bucket:p.bucket,sim:+p.c.sim.toFixed(3),fromApp:sents[i].app,toApp:sents[j].app,fromStar:sents[i].star,toStar:sents[j].star}};
});
await mkdir(dirname(OUT),{recursive:true});
await writeFile(OUT,final.map(f=>JSON.stringify(f.pair)).join('\n')+'\n');
await writeFile(META,JSON.stringify(final.map(f=>f.meta),null,1)+'\n');
console.error(`\nWrote ${final.length} candidates to ${OUT} (buckets in ${META}). Next: npm run label:pairs`);
