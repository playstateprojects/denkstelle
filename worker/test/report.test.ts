/** The emailed project report renders from plain data: no database, network or i18n runtime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {renderReport,INSIGHT_THEMES,SPLIT_SOURCES,type ReportData} from '../../src/lib/project-report.ts';

const t=(key:string,params?:Record<string,string|number>)=>params?`${key}${JSON.stringify(params)}`:key;
const theme=(name:string,insights:ReportData['themes'][number]['insights']=[])=>({name,description:`about ${name}`,sources:2,statements:5,bySource:[{title:'Big <book>',statements:4},{title:'Interview one',statements:1}],insights});
const data:ReportData={
  project:{title:'Truth <and> lies',question:'What is true?'},
  stats:{recordings:3,texts:1,statements:40,themes:5,insights:4},
  themes:[theme('First',[{title:'Finding & more',description:'Because.',statements:3,sources:2}]),theme('Second'),theme('Third'),theme('Fourth')],
  url:'https://example.test/dashboard/projects/p1'
};

test('stats, every listed theme and the link are in both bodies',()=>{
  const r=renderReport(data,t);
  assert.match(r.subject,/Truth <and> lies/);
  for(const body of [r.text,r.html]){
    assert.match(body,/report\.mail\.sources(: |<\/td>.*?>)4/);
    for(const n of ['First','Second','Third','Fourth'])assert.ok(body.includes(n));
    assert.ok(body.includes(data.url));
  }
});

test('insights are shown for the leading themes only, with a note where a theme has none',()=>{
  const r=renderReport(data,t);
  const insights=r.text.slice(r.text.indexOf('REPORT.MAIL.TOPINSIGHTS'));
  assert.ok(insights.includes('Finding & more'));
  assert.equal(insights.split('report.mail.noInsights').length-1,INSIGHT_THEMES-1);
  assert.ok(!insights.includes('Fourth'));
});

test('each theme shows how its statements split over sources, largest first, capped with a remainder',()=>{
  const r=renderReport(data,t);
  assert.ok(r.text.includes('Big <book>: 4 · Interview one: 1'));
  assert.ok(r.html.includes('Big &lt;book&gt;: 4 · Interview one: 1'));
  const many={...data,themes:[{...data.themes[0],bySource:Array.from({length:SPLIT_SOURCES+2},(_,n)=>({title:`S${n}`,statements:1}))}]};
  const text=renderReport(many,t).text;
  assert.ok(text.includes(`S${SPLIT_SOURCES-1}: 1 · report.mail.more{"n":2}`));
  assert.ok(!text.includes(`S${SPLIT_SOURCES}: 1`));
});

test('HTML escapes project and model text',()=>{
  const {html}=renderReport(data,t);
  assert.ok(html.includes('Truth &lt;and&gt; lies'));
  assert.ok(html.includes('Finding &amp; more'));
  assert.ok(!html.includes('<and>'));
});

test('a project without themes still renders',()=>{
  const r=renderReport({...data,themes:[],stats:{recordings:0,texts:0,statements:0,themes:0,insights:0}},t);
  assert.ok(r.text.includes('report.mail.noThemes'));
  assert.ok(r.html.includes('report.mail.noThemes'));
});
