/** Theme placement: the decision table, the Jev questions and the placement flow. No database or network:
 * the store is in memory and Jev and the namer are fakes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {decide,buildQuestions,placeStatement,placeAll,rewriteDue,spread,rewritingUser,REWRITE_EVERY,THRESHOLDS,MAX_THEMES_PER_STATEMENT,namingUser,type Judge,type Namer,type Rewriter} from '../src/theme-match.ts';
import {MemoryStore} from '../src/theme-memory.ts';
import {askNouls} from '../src/jev.ts';

const j=(themeId:string,p:number)=>({themeId,p});

test('decide: no candidates, or only clear noes, start a new theme',()=>{
 assert.deepEqual(decide([]),{kind:'create'});
 assert.deepEqual(decide([j('a',.05),j('b',THRESHOLDS.notMember)]),{kind:'create'});
});

test('decide: a clear yes joins the theme; the boundary counts as yes',()=>{
 assert.deepEqual(decide([j('a',.2),j('b',THRESHOLDS.member)]),{kind:'assign',links:[j('b',THRESHOLDS.member)]});
});

test('decide: an unsettled candidate with no yes waits as pending instead of creating a theme',()=>{
 assert.deepEqual(decide([j('a',.1),j('b',.5)]),{kind:'pending'});
 assert.deepEqual(decide([j('a',.31)]),{kind:'pending'});
});

test('decide: yeses win over unsettled candidates, which are not joined',()=>{
 assert.deepEqual(decide([j('a',.5),j('b',.9)]),{kind:'assign',links:[j('b',.9)]});
});

test('decide: several themes can be joined, best first, up to the cap',()=>{
 const many=Array.from({length:MAX_THEMES_PER_STATEMENT+2},(_,i)=>j(`t${i}`,.75+i*.01));
 const out=decide(many);
 assert.equal(out.kind,'assign');
 if(out.kind==='assign'){
  assert.equal(out.links.length,MAX_THEMES_PER_STATEMENT);
  assert.ok(out.links.every((l,i,a)=>!i||a[i-1].p>=l.p));
 }
});

test('buildQuestions: the statement is shared state and every candidate is its own yes/no question',()=>{
 const {state,questions}=buildQuestions('Booking is clunky.',[
  {id:'x',name:'Booking',description:'How equipment is reserved',examples:['Slots are hard to find.']},
  {id:'y',name:'Noise',description:null,examples:[]}]);
 assert.deepEqual(state,{statement:'Booking is clunky.'});  // no project question: see buildQuestions
 assert.deepEqual(Object.keys(questions),['theme_0','theme_1']);
 assert.ok(Object.values(questions).every(q=>q.type==='noul'&&q.criteria?.true&&q.criteria?.false));
 assert.match(questions.theme_0.instructions,/"Booking" \(How equipment is reserved\)/);
 assert.match(questions.theme_0.instructions,/"Slots are hard to find\."/);
 assert.doesNotMatch(questions.theme_1.instructions,/already filed/);
});

// Two clusters on the x and y axes; z is far from both.
const S=[
 {id:'s1',text:'Booking is clunky',vec:[1,0,0]},
 {id:'s2',text:'Booking takes many clicks',vec:[.95,.05,0]},
 {id:'s3',text:'Workshops are too loud',vec:[0,1,0]},
 {id:'s4',text:'There is no step-free entrance',vec:[0,0,1]},
];
const namer=(names:string[]):Namer=>async()=>({name:names.shift()??'Fallback',description:'d'});
/** A judge that says yes when the statement and the theme's examples share a first word. */
const byWord:Judge=async({statement,candidates})=>candidates.map(c=>c.examples.some(e=>e.split(' ')[0]===statement.split(' ')[0])?.9:.05);
const flow=async(order:string[],judge:Judge,names:string[])=>{
 const store=new MemoryStore(S),calls:string[]=[];
 const deps={store,judge:async(i:Parameters<Judge>[0])=>{calls.push(i.statement);return judge(i)},name:namer(names)};
 const placed=[];
 for(const id of order)placed.push(await placeStatement(deps,S.find(s=>s.id===id)!));
 return {store,calls,placed};
};

test('the first statement starts a theme without asking Jev anything',async()=>{
 const {store,calls,placed}=await flow(['s1'],byWord,['Booking']);
 assert.equal(calls.length,0);
 assert.equal(placed[0].placement.kind,'create');
 assert.deepEqual([...store.themes.values()].map(t=>t.name),['Booking']);
 assert.equal(store.status.get('s1'),'assigned');
 assert.equal(store.links.get('s1')!.get('theme-1')!.method,'seed');
});

test('a statement Jev says belongs joins the theme, keeps its probability and records every judgement',async()=>{
 const {store,placed}=await flow(['s1','s2'],byWord,['Booking']);
 assert.equal(placed[1].placement.kind,'assign');
 assert.equal(store.themes.size,1);
 assert.deepEqual(store.links.get('s2')!.get('theme-1'),{p:.9,method:'jev'});
 assert.deepEqual(store.judgements.get('s2'),[{themeId:'theme-1',p:.9}]);
});

test('a statement that fits nothing nearby starts its own theme, named from the nearby themes it does not belong to',async()=>{
 const store=new MemoryStore(S),seen:string[][]=[];
 const deps={store,judge:async()=>[.05],name:async(i:Parameters<Namer>[0])=>{seen.push(i.nearby.map(n=>n.name));return {name:i.nearby.length?'Noise':'Booking',description:''}}};
 await placeStatement(deps,S[0]);
 await placeStatement(deps,S[2]);
 assert.deepEqual(seen,[[],['Booking']]);
 assert.deepEqual([...store.themes.values()].map(t=>t.name),['Booking','Noise']);
});

test('an unsettled statement is parked, creates nothing, and is placed when asked again',async()=>{
 const store=new MemoryStore(S);
 let p=.5;
 const deps={store,judge:async()=>[p],name:namer(['Booking'])};
 await placeStatement(deps,S[0]);
 const first=await placeStatement(deps,S[1]);
 assert.equal(first.placement.kind,'pending');
 assert.equal(store.status.get('s2'),'pending');
 assert.equal(store.themes.size,1);
 p=.8;
 assert.equal((await placeStatement(deps,S[1])).placement.kind,'assign');
 assert.equal(store.status.get('s2'),'assigned');
});

test('a new theme named like an existing one is joined, not duplicated',async()=>{
 const store=new MemoryStore(S);
 const deps={store,judge:async()=>[.05],name:namer(['Booking','booking!'])};
 await placeStatement(deps,S[0]);
 await placeStatement(deps,S[1]);
 assert.equal(store.themes.size,1);
 assert.equal(store.links.get('s2')!.get('theme-1')!.method,'name_match');
});

test('a failing judge or namer leaves the statement untouched so it is retried',async()=>{
 const store=new MemoryStore(S);
 await placeStatement({store,judge:async()=>[],name:namer(['Booking'])},S[0]);
 await assert.rejects(placeStatement({store,judge:async()=>{throw new Error('Jev 503')},name:namer([])},S[1]),/Jev 503/);
 assert.equal(store.status.get('s2'),undefined);
 assert.equal(store.links.get('s2'),undefined);
 await assert.rejects(placeStatement({store,judge:async()=>[.05],name:async()=>{throw new Error('model down')}},S[2]),/model down/);
 assert.equal(store.status.get('s3'),undefined);
 assert.equal(store.themes.size,1);
});

test('a judge that answers the wrong number of probabilities, or one out of range, is an error',async()=>{
 const store=new MemoryStore(S);
 await placeStatement({store,judge:async()=>[],name:namer(['Booking'])},S[0]);
 await assert.rejects(placeStatement({store,judge:async()=>[],name:namer([])},S[1]),/Expected 1 probabilities/);
 await assert.rejects(placeStatement({store,judge:async()=>[1.4],name:namer([])},S[1]),/Expected 1 probabilities/);
 assert.equal(store.status.get('s2'),undefined);
});

test('namingUser marks reference-text statements and lists the nearby themes',()=>{
 const u=namingUser({statement:{text:'Names are conventions.',fromText:true},nearby:[{id:'a',name:'Booking',description:'Reserving',examples:[]}]});
 assert.match(u,/reference text/);
 assert.match(u,/- Booking: Reserving/);
 assert.match(namingUser({statement:{text:'x'},nearby:[]}),/\(none\)/);
});

test('askNouls returns one probability per question and treats a bad answer as an error',async t=>{
 const reply=(status:number,body:unknown)=>t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(body),{status}));
 const q={a:{type:'noul' as const,instructions:'?'}};
 reply(200,{answers:{a:{type:'noul',noul:.83}},usage:{input_tokens:7}});
 assert.deepEqual(await askNouls({TYPESAFE_API_KEY:'k'},{x:1},q),{answers:{a:.83},tokens:7});
 reply(200,{answers:{}});
 await assert.rejects(askNouls({TYPESAFE_API_KEY:'k'},{x:1},q),/no probability for "a"/);
 reply(200,{answers:{a:{type:'noul',noul:1.2}}});
 await assert.rejects(askNouls({TYPESAFE_API_KEY:'k'},{x:1},q),/no probability/);
 reply(429,{detail:'slow down'});
 await assert.rejects(askNouls({TYPESAFE_API_KEY:'k'},{x:1},q),/Jev 429/);
 await assert.rejects(askNouls({},{x:1},q),/TYPESAFE_API_KEY is not set/);
});

// ---- rewriting a theme's wording as it grows ----

test('rewriteDue: due exactly when the theme has grown by REWRITE_EVERY since its wording was written',()=>{
 assert.equal(rewriteDue(1+REWRITE_EVERY-1,1),false);
 assert.equal(rewriteDue(1+REWRITE_EVERY,1),true);
 assert.equal(rewriteDue(20,20),false);
});

test('spread keeps everything under the limit, otherwise an even spread that includes the first and last',()=>{
 assert.deepEqual(spread([1,2,3],5),[1,2,3]);
 const out=spread(Array.from({length:100},(_,i)=>i),5);
 assert.deepEqual(out,[0,25,50,74,99]);
 assert.equal(spread([1,2,3],1).length,1);
});

// Eleven statements about one thing: every one is a clear yes for the theme the first one starts.
const MANY=Array.from({length:12},(_,i)=>({id:`m${i}`,text:`Booking problem ${i}`,vec:[1,i*.01,0]}));
const yes:Judge=async({candidates})=>candidates.map(()=>.9);
const grow=async(n:number,rewrite:Rewriter,store=new MemoryStore(MANY))=>{
 const deps={store,judge:yes,name:namer(['Booking']),rewrite},placed=[];
 for(const s of MANY.slice(0,n))placed.push(await placeStatement(deps,s));
 return {store,placed};
};

test('a theme is rewritten when it has grown by five statements, not before',async()=>{
 const seen:number[]=[];
 const rewrite:Rewriter=async i=>{seen.push(i.size);return {name:'Booking is hard',description:'How reserving equipment goes wrong'}};
 const before=await grow(REWRITE_EVERY,rewrite);          // size 5: grown by 4
 assert.deepEqual(seen,[]);
 assert.equal(before.store.themes.get('theme-1')!.name,'Booking');
 const after=await grow(REWRITE_EVERY+1,rewrite);         // size 6: grown by 5
 assert.deepEqual(seen,[6]);
 assert.equal(after.store.themes.get('theme-1')!.name,'Booking is hard');
 assert.deepEqual(after.placed.at(-1)!.renamed,[{themeId:'theme-1',from:'Booking',to:'Booking is hard'}]);
 assert.deepEqual(after.store.renames,[{themeId:'theme-1',from:'Booking',to:'Booking is hard',size:6}]);
});

test('after a rewrite the count starts again: the next one is five statements later',async()=>{
 const sizes:number[]=[];
 const rewrite:Rewriter=async i=>{sizes.push(i.size);return {name:`Booking ${i.size}`,description:''}};
 await grow(12,rewrite);
 assert.deepEqual(sizes,[6,11]);
});

test('the rewriter sees the current wording and the theme\'s statements',async()=>{
 let got:Parameters<Rewriter>[0]|undefined;
 await grow(REWRITE_EVERY+1,async i=>{got=i;return {name:i.theme.name,description:i.theme.description??''}});
 assert.equal(got!.theme.name,'Booking');
 assert.equal(got!.statements.length,6);
 assert.equal(got!.statements[0].text,'Booking problem 0');
});

test('a rewrite that changes nothing is not a rename, but the count still restarts',async()=>{
 let calls=0;
 const {store,placed}=await grow(REWRITE_EVERY+2,async i=>{calls++;return {name:i.theme.name,description:i.theme.description??''}});
 assert.equal(calls,1);
 assert.equal(store.renames.length,0);
 assert.ok(placed.every(p=>p.renamed.length===0));
});

test('a failing rewrite never undoes the placement and is tried again at the next statement',async()=>{
 let fail=true,calls=0;
 const rewrite:Rewriter=async()=>{calls++;if(fail)throw new Error('model down');return {name:'Booking is hard',description:''}};
 const log=console.error;console.error=()=>{};
 try{
  const {store,placed}=await grow(REWRITE_EVERY+1,rewrite);
  assert.equal(placed.at(-1)!.placement.kind,'assign');
  assert.equal(store.status.get('m5'),'assigned');
  assert.equal(store.themes.get('theme-1')!.name,'Booking');
  fail=false;
  await placeStatement({store,judge:yes,name:namer([]),rewrite},MANY[6]);
  assert.equal(store.themes.get('theme-1')!.name,'Booking is hard');
  assert.equal(calls,2);
 }finally{console.error=log}
});

test('a rewrite that would give two themes one name keeps the old wording and counts as reviewed',async()=>{
 const store=new MemoryStore(MANY);
 await store.createTheme({name:'Noise',description:''});
 const {store:s}=await grow(REWRITE_EVERY+1,async()=>({name:'noise!',description:'x'}),store);
 assert.equal(s.themes.get('theme-2')!.name,'Booking');
 assert.equal(s.themes.get('theme-2')!.namedSize,6);
 assert.equal(s.renames.length,0);
});

test('without a rewriter nothing is rewritten, however large the theme grows',async()=>{
 const store=new MemoryStore(MANY),deps={store,judge:yes,name:namer(['Booking'])};
 for(const s of MANY)await placeStatement(deps,s);
 assert.equal(store.themes.get('theme-1')!.name,'Booking');
});

test('rewritingUser marks reference-text statements and says when only a spread is shown',()=>{
 const u=rewritingUser({theme:{name:'Booking',description:'Reserving'},size:50,statements:[{text:'a',fromText:false},{text:'b',fromText:true}]});
 assert.match(u,/CURRENT THEME: Booking: Reserving/);
 assert.match(u,/\(2 of 50, evenly spread\)/);
 assert.match(u,/\[1\] \(text\) b/);
 assert.doesNotMatch(rewritingUser({theme:{name:'B',description:null},size:2,statements:[{text:'a',fromText:false},{text:'b',fromText:false}]}),/evenly spread/);
});

// ---- the settling pass and thresholds ----

test('decide with settle: a statement more likely in than out joins, otherwise it starts a theme',()=>{
 assert.deepEqual(decide([j('a',.1),j('b',.5)],THRESHOLDS,MAX_THEMES_PER_STATEMENT,true),{kind:'assign',links:[j('b',.5)]});
 assert.deepEqual(decide([j('a',.1),j('b',.45)],THRESHOLDS,MAX_THEMES_PER_STATEMENT,true),{kind:'create'});
 assert.deepEqual(decide([j('a',.5),j('b',.9)],THRESHOLDS,MAX_THEMES_PER_STATEMENT,true).kind,'assign');
 // The same judgements are unsettled in the first pass.
 assert.deepEqual(decide([j('a',.1),j('b',.5)]),{kind:'pending'});
});

test('thresholds are a parameter: the same judgements decide differently at another cut',()=>{
 const js=[j('a',.62)];
 assert.equal(decide(js,{member:.6,notMember:.3,settle:.5}).kind,'assign');
 assert.equal(decide(js,{member:.7,notMember:.3,settle:.5}).kind,'pending');
});

test('placeStatement passes its thresholds to decide',async()=>{
 const store=new MemoryStore(S);
 await placeStatement({store,judge:async()=>[],name:namer(['Booking'])},S[0]);
 const lenient=await placeStatement({store,judge:async()=>[.62],name:namer([]),thresholds:{member:.6,notMember:.3,settle:.5}},S[1]);
 assert.equal(lenient.placement.kind,'assign');
 const strict=await placeStatement({store,judge:async()=>[.62],name:namer(['Other']),thresholds:{member:.7,notMember:.3,settle:.5}},S[2]);
 assert.equal(strict.placement.kind,'pending');
});

test('placeAll: what the first pass leaves pending is asked again, and starts a theme if it still fits nothing',async()=>{
 const store=new MemoryStore(S);
 const asked:string[]=[];
 const judge:Judge=async({statement,candidates})=>{asked.push(statement);return candidates.map(()=>.45)};   // unsettled in pass 1, still below the settle bar in pass 2
 const run=await placeAll({store,judge,name:namer(['A','B','C','D'])},S);
 assert.equal(run.aborted,false);
 // s1 starts a theme; s2, s3, s4 are unsettled in pass 1, then each starts one in pass 2 (nothing is left pending).
 assert.deepEqual(run.settled,['s2','s3','s4']);
 assert.ok([...run.final.values()].every(p=>p.placement.kind!=='pending'));
 assert.ok([...store.status.values()].every(v=>v==='assigned'));
 assert.equal(store.themes.size,4);
 // The settling pass asked again (twice each for s2..s4).
 assert.equal(asked.filter(x=>x===S[1].text).length,2);
});

test('placeAll: statements settled by the second pass can join themes the first pass made',async()=>{
 const store=new MemoryStore(S);
 let pass=1;
 // Pass 1: everything after the first is unsettled. Pass 2: a clear yes for the theme of s1.
 const judge:Judge=async({candidates})=>candidates.map(()=>pass===1?.5:.9);
 const run=await placeAll({store,judge,name:namer(['Booking'])},S.slice(0,3),{onPlaced:(_s,_p,n)=>{pass=n===1&&_s.id==='s3'?2:pass}});
 assert.equal(store.themes.size,1);
 assert.deepEqual(run.settled,['s2','s3']);
 assert.equal(store.links.get('s2')!.get('theme-1')!.method,'jev');
});

test('placeAll: one failing statement is reported and the rest are placed; three in a row stop the run',async()=>{
 const store=new MemoryStore(S);
 const bad=new Set(['s2']);
 const judge:Judge=async({statement,candidates})=>{if(bad.has(S.find(x=>x.text===statement)!.id))throw new Error('Jev 503');return candidates.map(()=>.9)};
 const run=await placeAll({store,judge,name:namer(['Booking'])},S);
 assert.deepEqual(run.failed.map(f=>f.statement),['s2']);
 assert.equal(run.aborted,false);
 assert.equal(store.status.get('s2'),undefined);
 assert.equal(store.status.get('s3'),'assigned');

 const dead:Judge=async()=>{throw new Error('Jev down')};
 const store2=new MemoryStore(S);
 await placeStatement({store:store2,judge:dead,name:namer(['Booking'])},S[0]);
 const run2=await placeAll({store:store2,judge:dead,name:namer([])},S.slice(1));
 assert.equal(run2.aborted,true);
 assert.equal(run2.failed.length,3);
});
