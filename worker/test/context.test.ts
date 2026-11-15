/** Pure parts of project context documents: accepted file types and cutting text into passages. No database needed. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chunkPages,contextFileKind,normalizeText,titleFromFilename} from '../../src/lib/context-text.ts';

test('contextFileKind accepts PDF and plain text, by type or by extension when the browser sends none',()=>{
  assert.deepEqual(contextFileKind({type:'application/pdf',name:'a.pdf'}),{kind:'pdf',mime:'application/pdf'});
  assert.deepEqual(contextFileKind({type:'',name:'Book.PDF'}),{kind:'pdf',mime:'application/pdf'});
  assert.deepEqual(contextFileKind({type:'text/plain; charset=utf-8',name:'a.txt'}),{kind:'text',mime:'text/plain'});
  assert.deepEqual(contextFileKind({type:'',name:'notes.md'}),{kind:'text',mime:'text/plain'});
  assert.equal(contextFileKind({type:'image/png',name:'a.pdf'}),null,'a wrong declared type is not rescued by the extension');
  assert.equal(contextFileKind({type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',name:'a.docx'}),null);
});

test('titleFromFilename drops the extension and underscores',()=>{
  assert.equal(titleFromFilename('finnegans_wake.pdf'),'finnegans wake');
  assert.equal(titleFromFilename('.pdf'),'Untitled');
});

test('normalizeText strips BOM, NULs and CRLF and collapses blank runs',()=>{
  assert.equal(normalizeText('﻿a\r\nb\u0000  \r\n\r\n\r\n\r\nc'),'a\nb\n\nc');
});

test('chunkPages: passages stay in size, keep exact offsets and cover all the text',()=>{
  const para=(n:number)=>Array.from({length:n},(_,i)=>`Sentence number ${i} of the paragraph.`).join(' ');
  const text=[para(12),para(30),para(5),para(60)].join('\n\n');
  const chunks=chunkPages([{page:null,text}]);
  const norm=normalizeText(text);
  assert.ok(chunks.length>=3,`${norm.length} chars should need at least 3 passages, got ${chunks.length}`);
  chunks.forEach((c,i)=>{
    assert.equal(c.sequence,i);
    assert.equal(c.text,norm.slice(c.charStart,c.charEnd),'text is exactly the slice at its offsets');
    assert.ok(c.text.length<=1500,`passage ${i} is ${c.text.length} chars`);
    assert.equal(c.text,c.text.trim());
  });
  // Nothing is lost or reordered: the passages, ignoring whitespace, spell the original text.
  assert.equal(chunks.map(c=>c.text).join('').replace(/\s/g,''),norm.replace(/\s/g,''));
  for(let i=1;i<chunks.length;i++)assert.ok(chunks[i].charStart>=chunks[i-1].charEnd,'passages do not overlap');
});

test('chunkPages: never spans pages and records the page number',()=>{
  const chunks=chunkPages([{page:1,text:'First page.'},{page:2,text:'   '},{page:3,text:'Third page.'}]);
  assert.deepEqual(chunks.map(c=>[c.sequence,c.page,c.text]),[[0,1,'First page.'],[1,3,'Third page.']]);
});

test('chunkPages: splits a long text with no spaces or punctuation without looping forever',()=>{
  const chunks=chunkPages([{page:null,text:'x'.repeat(4000)}]);
  assert.equal(chunks.length,3);
  assert.equal(chunks.reduce((n,c)=>n+c.text.length,0),4000);
});

test('chunkPages: empty input gives no passages',()=>{
  assert.deepEqual(chunkPages([]),[]);
  assert.deepEqual(chunkPages([{page:null,text:' \n\n '}]),[]);
});
