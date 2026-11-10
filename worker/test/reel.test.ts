/** Pure parts of the theme-reel composer: weights, windows, selection, arrangement validation. No database or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {score,windowAround,select,arrange,clampParams} from '../src/reel.ts';
import {DEFAULT_PROMPTS} from '../src/prompts.ts';

const seg=(n:number,len=3000)=>Array.from({length:n},(_,i)=>({start_ms:i*len,end_ms:(i+1)*len,text:`s${i}`}));
const theme=(name:string)=>({id:name,name,description:null,sources:1});
let uid=0;
const clip=(source:string,lo:number,hi:number,sc:number,t='a',dur=10000)=>({source_id:source,lo,hi,start_ms:lo*dur,end_ms:(hi+1)*dur,text:`${source}${lo}`,weight:1,
  ratings:{relevance:sc,standalone:sc,insight:sc,vividness:sc},score:sc,rationale:String(uid++),theme:theme(t)});

test('score weights criteria and stays within 1-5',()=>{
  assert.equal(score({relevance:5,standalone:5,insight:5,vividness:5}),5);
  assert.equal(score({relevance:1,standalone:1,insight:1,vividness:1}),1);
  assert.equal(score({relevance:5,standalone:1,insight:1,vividness:1}),2.4);
});

test('windowAround adds context and respects length limits',()=>{
  const s=seg(30);
  assert.deepEqual(windowAround(s,5,5),{lo:4,hi:6});
  assert.deepEqual(windowAround(s,0,0),{lo:0,hi:1}); // short at the start: extended forward to the minimum
  const w=windowAround(s,2,20)!;assert.ok(s[w.hi].end_ms-s[w.lo].start_ms<=35000);
  assert.equal(windowAround(s,40,41),null);
});

test('select takes one clip per theme, prefers new speakers and respects the budget',()=>{
  const a=[clip('A',0,0,4.5,'t1'),clip('B',0,0,4.0,'t1')];
  const b=[clip('A',5,5,4.4,'t2'),clip('C',0,0,3.5,'t2')];
  const picked=select([a,b],{target_ms:20000,min_score:3});
  assert.equal(picked.length,2);
  assert.deepEqual(picked.map(c=>c.source_id).sort(),['A','C'].sort()); // second theme avoids speaker A
  assert.ok(picked.reduce((n,c)=>n+c.end_ms-c.start_ms,0)<=22000);
});

test('select drops weak clips and never overlaps within one source',()=>{
  const picked=select([[clip('A',0,3,4,'t1'),clip('A',2,5,4.2,'t1'),clip('B',0,0,2,'t1')]],{target_ms:120000,min_score:3});
  assert.equal(picked.length,1);
  assert.deepEqual(select([[clip('A',0,0,2,'t1')]],{target_ms:60000,min_score:3}),[]);
});

test('arrange without a model call for a single clip, and params clamp',async()=>{
  const r=await arrange({},'deepseek-flash',DEFAULT_PROMPTS,[clip('A',0,0,4,'only')]);
  assert.deepEqual(r.order,[0]);assert.equal(r.title,'only');
  assert.deepEqual(clampParams({target_ms:1,themes:99,min_score:0}).themes,8);
  assert.equal(clampParams({target_ms:1}).target_ms,20000);
});
