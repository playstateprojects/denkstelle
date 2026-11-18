/** Pure parts of the insight pass: grounding the model's citations and the per-theme basis. No database or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {ground,basis,MAX_PER_THEME,InsightError} from '../src/insights.ts';

const statements=[{id:'a',sourceId:'s1',text:'one'},{id:'b',sourceId:'s2',text:'two'},{id:'c',sourceId:'s2',text:'three'}];
const insight=(title:string,statement_ids:number[])=>({title,description:'d',statement_ids});

test('citations map back to statement ids; unknown and duplicate numbers are dropped',()=>{
 const [i]=ground({insights:[insight('Finding',[2,0,0,9])]},statements);
 assert.deepEqual(i,{title:'Finding',description:'d',statementIds:['c','a']});
});

test('an insight resting on fewer than two valid statements is dropped',()=>{
 const out=ground({insights:[insight('Unbacked',[]),insight('Invented',[7,8]),insight('Paraphrase',[1]),insight('Half invented',[1,9]),insight('Backed',[1,2])]},statements);
 assert.deepEqual(out.map(i=>i.title),['Backed']);
});

test('at most MAX_PER_THEME insights survive',()=>{
 const out=ground({insights:Array.from({length:MAX_PER_THEME+2},(_,n)=>insight(`I${n}`,[0,1]))},statements);
 assert.equal(out.length,MAX_PER_THEME);
});

test('a malformed answer is an error, never an empty result',()=>{
 assert.throws(()=>ground({insight:[]},statements),InsightError);
 assert.throws(()=>ground({insights:[{title:'x',statement_ids:['0']}]},statements),InsightError);
 assert.deepEqual(ground({insights:[]},statements),[]);
});

test('basis ignores statement order and changes with statements, model or prompt version',()=>{
 const b=basis('m',1,['a','b']);
 assert.equal(basis('m',1,['b','a']),b);
 assert.notEqual(basis('m',1,['a','b','c']),b);
 assert.notEqual(basis('m',2,['a','b']),b);
 assert.notEqual(basis('n',1,['a','b']),b);
});
