/** Pure parts of the context pipeline: grounding what the model says about a window of the text, choosing background
 * passages for an interview, tagging text statements apart from interviews, and the analysis prompt. No database or model needed. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groundWindow,pickPassages,windowUser,MAX_PER_WINDOW,type Passage,type ContextHit} from '../src/context.ts';
import {sourceLabels,textNote,TEXT_NOTE} from '../src/labels.ts';
import {analysisUser} from '../src/analysis.ts';

const passages:Passage[]=Array.from({length:4},(_,i)=>({id:`p${i}`,sequence:i,page:i<2?7:8,text:`Passage ${i}.`}));

test('groundWindow maps window numbers to passage ids and drops what is not grounded',()=>{
  const out=groundWindow({statements:[
    {text:'The text plays with river imagery.',passage_indexes:[0,1,1]},
    {text:'Cites a passage that does not exist.',passage_indexes:[9]},
    {text:'Cites nothing at all here.',passage_indexes:[]},
    {text:'  the text plays with river imagery.  ',passage_indexes:[2]},
    {text:'Mixed: one real, one invented passage.',passage_indexes:[3,40]}
  ]},passages);
  assert.deepEqual(out,[
    {text:'The text plays with river imagery.',passageIds:['p0','p1']},
    {text:'Mixed: one real, one invented passage.',passageIds:['p3']}
  ]);
});

test('groundWindow caps a window and rejects a malformed answer',()=>{
  const many={statements:Array.from({length:30},(_,i)=>({text:`Distinct statement number ${i}`,passage_indexes:[0]}))};
  assert.equal(groundWindow(many,passages).length,MAX_PER_WINDOW);
  assert.throws(()=>groundWindow({statements:'no'},passages),/does not match the expected shape/);
  assert.throws(()=>groundWindow({statements:[{text:'short',passage_indexes:[0]}]},passages),/does not match/);
});

test('windowUser numbers passages and shows page numbers',()=>{
  const u=windowUser({project:'P',question:'Q?',title:'Book',passages});
  assert.match(u,/TEXT: Book/);
  assert.match(u,/\[0\] \(p\.7\) Passage 0\./);
  assert.match(u,/\[3\] \(p\.8\) Passage 3\./);
});

test('pickPassages keeps each passage once at its best distance, best first, within the budget',()=>{
  const hit=(id:string,dist:number,len=100):ContextHit=>({id,label:`L${id}`,text:'x'.repeat(len),dist});
  const out=pickPassages([hit('a',0.5),hit('b',0.2),hit('a',0.1),hit('c',0.3)]);
  assert.deepEqual(out.map(o=>o.label),['La','Lb','Lc']);
  assert.equal(pickPassages([hit('a',0.1),hit('b',0.2),hit('c',0.3)],2).length,2,'max passages');
  assert.equal(pickPassages([hit('a',0.1,3000),hit('b',0.2,3000)],6,5000).length,1,'character budget');
  assert.deepEqual(pickPassages([]),[]);
});

test('sourceLabels tags interviews I1.. and the reference text T1.. independently of order',()=>{
  const m=sourceLabels([{sourceId:'t',fromText:true},{sourceId:'a'},{sourceId:'a'},{sourceId:'b'},{sourceId:'t2',fromText:true}]);
  assert.deepEqual([...m],[['t','T1'],['a','I1'],['b','I2'],['t2','T2']]);
  assert.match(TEXT_NOTE,/not an interview/);
});

test('analysisUser adds background excerpts only when there are some, and never as the speaker',()=>{
  const base={title:'T',question:'Q',texts:['hello','world']};
  assert.doesNotMatch(analysisUser(base),/BACKGROUND/);
  assert.doesNotMatch(analysisUser({...base,context:[]}),/BACKGROUND/);
  const u=analysisUser({...base,context:[{label:'Book, p.3',text:'riverrun'}]});
  assert.match(u,/BACKGROUND EXCERPTS/);
  assert.match(u,/never attribute their content to the speaker/);
  assert.match(u,/\[C1\] \(Book, p\.3\) riverrun/);
  assert.ok(u.indexOf('BACKGROUND')<u.indexOf('TRANSCRIPT WITH SEGMENT INDICES'),'background comes before the transcript');
  assert.match(u,/\[0\] hello\n\[1\] world/);
});

test('textNote lists each reference text by tag and title, and is absent without texts',()=>{
  const st=[{sourceId:'a'},{sourceId:'t',fromText:true,sourceTitle:'Cratylus'},{sourceId:'t',fromText:true,sourceTitle:'Cratylus'},{sourceId:'u',fromText:true}];
  const note=textNote(st,sourceLabels(st))!;
  assert.ok(note.startsWith(TEXT_NOTE));
  assert.ok(note.endsWith('REFERENCE TEXTS:\nT1 = "Cratylus"\nT2 = "Untitled text"'));
  assert.equal(textNote([{sourceId:'a'}],sourceLabels([{sourceId:'a'}])),null);
});
