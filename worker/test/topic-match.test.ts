/** Topic-first placement: the flow from extracted topics to edges. No database or network: the store is in memory, and the
 * extractor, the embedder and the judge are fakes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {placeStatement,placeAll,speechAct,newStats,LINK_MIN,MAX_TOPICS,type Extractor,type Embedder,type Ask,type PlaceDeps,type Topic} from '../src/topic-match.ts';
import {TopicStore} from '../src/topic-memory.ts';

// Two-dimensional "embeddings": a label's direction decides which themes are near it.
const E:Record<string,number[]>={price:[1,0],cost:[.95,.31],booking:[0,1]};
const vec=(t:string)=>E[Object.keys(E).find(k=>t.toLowerCase().startsWith(k))??'']??[.7,.7];
const embed:Embedder=async ts=>ts.map(vec);
const st=(id:string,text='x')=>({id,text,vec:[1,0]});
/** The extractor answers from a table keyed by statement text; the judge from a table keyed by theme name (default no). */
const extractor=(table:Record<string,Topic[]>):Extractor=>async i=>table[i.statement];
const judge=(yes:Record<string,number>={}):Ask=>async (_state,questions)=>({answers:Object.fromEntries(Object.entries(questions).map(([id,q])=>{
  const name=/topic: "([^"]+)"/.exec(q.instructions)?.[1]??'';return [id,yes[name]??.1]})),tokens:10});
const deps=(store:TopicStore,table:Record<string,Topic[]>,yes?:Record<string,number>,o:Partial<PlaceDeps>={}):PlaceDeps=>({store,extract:extractor(table),embed,ask:judge(yes),stats:newStats(),...o});
const t=(name:string,description=''):Topic=>({name,description});
const names=(s:TopicStore,sid:string)=>[...(s.links.get(sid)?.keys()??[])].map(id=>s.themes.get(id)!.name).sort();

test('a statement with two topics starts two themes and is linked to both, without a judge weight',async()=>{
  const store=new TopicStore([st('s1','A')]);
  const placed=await placeStatement(deps(store,{A:[t('laser cutter lab'),t('price')]}),{id:'s1',text:'A'});
  assert.deepEqual(names(store,'s1'),['laser cutter lab','price']);
  assert.deepEqual(placed.created.sort(),['laser cutter lab','price']);
  assert.ok([...store.links.get('s1')!.values()].every(e=>e.method==='seed'&&e.p===null));
});

test('an exact name is a candidate, not a free pass: the judge\'s probability is the edge weight',async()=>{
  const store=new TopicStore([st('s1','A'),st('s2','B')]);
  const d=deps(store,{A:[t('price')],B:[t('price')]},{price:.83});
  await placeStatement(d,{id:'s1',text:'A'});
  await placeStatement(d,{id:'s2',text:'B'});
  assert.equal(store.themes.size,1);
  const e=[...store.links.get('s2')!.values()][0];
  assert.equal(e.method,'exact'); assert.equal(e.p,.83);
});

test('an exact name the judge scores below the link threshold keeps the edge as name_match with the judge\'s weight',async()=>{
  const store=new TopicStore([st('s1','A'),st('s2','B')]);
  const d=deps(store,{A:[t('price')],B:[t('price')]},{price:.2});
  await placeStatement(d,{id:'s1',text:'A'});
  await placeStatement(d,{id:'s2',text:'B'});
  assert.equal(store.themes.size,1);
  const e=[...store.links.get('s2')!.values()][0];
  assert.equal(e.method,'name_match'); assert.equal(e.p,.2);
  assert.equal(d.stats.reuseExactBelow,1);
});

test('a different name found by label embedding joins the theme when the judge says yes, and starts its own theme when it says no',async()=>{
  const store=new TopicStore([st('s1','A'),st('s2','B'),st('s3','C')]);
  await placeStatement(deps(store,{A:[t('price')]}),{id:'s1',text:'A'});
  await placeStatement(deps(store,{B:[t('cost')]},{price:LINK_MIN}),{id:'s2',text:'B'});
  assert.deepEqual(names(store,'s2'),['price']);
  assert.equal([...store.links.get('s2')!.values()][0].method,'embed');
  await placeStatement(deps(store,{C:[t('cost')]},{price:.4}),{id:'s3',text:'C'});
  assert.deepEqual(names(store,'s3'),['cost']);
  assert.equal(store.themes.size,2);
});

test('a topic is linked to at most MAX_LINKS_PER_TOPIC themes, best first',async()=>{
  const store=new TopicStore([st('a','A'),st('b','B'),st('c','C'),st('d','D')]);
  for(const [id,name] of [['a','price'],['b','pricing'],['c','cost']]){
    const theme=store.create(name,'',vec(name));
    store.link(id,[{themeId:theme.id,edge:{p:null,method:'seed'}}]);
  }
  await placeStatement(deps(store,{D:[t('price tag')]},{price:.9,pricing:.8,cost:.7}),{id:'d',text:'D'});
  assert.deepEqual(names(store,'d'),['price','pricing']);
});

test('a failed judge call leaves the statement unplaced',async()=>{
  const store=new TopicStore([st('s1','A'),st('s2','B')]);
  await placeStatement(deps(store,{A:[t('price')]}),{id:'s1',text:'A'});
  const d=deps(store,{B:[t('price')]},undefined,{ask:async()=>{throw new Error('Jev 500')}});
  await assert.rejects(()=>placeStatement(d,{id:'s2',text:'B'}),/Jev 500/);
  assert.equal(store.links.get('s2'),undefined);
});

test('placeAll skips a failing statement and stops after three failures in a row',async()=>{
  const sts=[1,2,3,4,5].map(i=>st(`s${i}`,`T${i}`));
  const store=new TopicStore(sts);
  const run=await placeAll(deps(store,{},undefined,{extract:async()=>{throw new Error('down')}}),sts);
  assert.equal(run.failed.length,3); assert.equal(run.aborted,true); assert.equal(run.placed,0);
  const ok=await placeAll(deps(new TopicStore(sts),Object.fromEntries(sts.map(s=>[s.text,[t('price')]]))),sts);
  assert.equal(ok.placed,5); assert.equal(ok.aborted,false);
});

test('speechAct: names that only describe the kind of statement are rejected, subjects are not',()=>{
  for(const n of ['next steps','concrete improvement ideas','level of criticism','Improvements','feedback'])assert.equal(speechAct(n),true,n);
  for(const n of ['price','laser cutter lab','feedback culture','booking system','device manuals'])assert.equal(speechAct(n),false,n);
});

test('MAX_TOPICS is the cap the prompt promises',()=>assert.equal(MAX_TOPICS,3));
