import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeCandidates,mayProposeMembership,shouldCreateEdge,validateAssessment,type Assessment} from '../src/insight-logic.ts';

const assessment=(relation:Assessment['relation']):Assessment=>({
 fromStatementId:'statement-A',toStatementId:'statement-B',relation,
 reason:'The claims were compared against their source passages.',
 confidence:0.75,evidenceSegmentIds:['segment-A','segment-B'],modelId:'classifier-v1',promptVersion:'1'
});

test('retrieval deduplicates and keeps the strongest candidate, never a self-pair',()=>{
 const candidates=mergeCandidates([
  {statementId:'a',candidateId:'b',similarity:.7,method:'nearest_statement'},
  {statementId:'b',candidateId:'a',similarity:.9,method:'counterclaim'},
  {statementId:'a',candidateId:'a',similarity:1,method:'nearest_statement'},
  {statementId:'a',candidateId:'c',similarity:.8,method:'nearest_statement'}
 ]);
 assert.equal(candidates.length,2);
 assert.equal(candidates.find(x=>x.candidateId==='a')?.method,'counterclaim');
});

test('equivalent requires its own validated check against the canonical insight',()=>{
 const canon=(relation:Assessment['relation'],to='statement-C'):Assessment=>({...assessment(relation),fromStatementId:'statement-B',toStatementId:to});
 assert.equal(mayProposeMembership(assessment('equivalent'),canon('equivalent')),true);
 assert.equal(mayProposeMembership(assessment('equivalent'),canon('related')),false);
 assert.equal(mayProposeMembership(assessment('related'),canon('equivalent')),false);
 // canonical assessment about an unrelated statement does not vouch for this one
 assert.equal(mayProposeMembership(assessment('equivalent'),{...canon('equivalent'),fromStatementId:'x',toStatementId:'y'}),false);
 // unvalidated canonical judgement is rejected
 assert.throws(()=>mayProposeMembership(assessment('equivalent'),{...canon('equivalent'),evidenceSegmentIds:[]}),/source evidence/);
});

test('merge keeps every retrieval method, separates insight candidates, caps both sides',()=>{
 const m=mergeCandidates([
  {statementId:'a',candidateId:'b',similarity:.7,method:'nearest_statement'},
  {statementId:'b',candidateId:'a',similarity:.9,method:'counterclaim'},
  {statementId:'a',candidateId:'b',similarity:.5,method:'nearest_insight'}
 ]);
 assert.equal(m.length,2);
 assert.deepEqual(m.find(x=>x.method==='counterclaim')?.methods.sort(),['counterclaim','nearest_statement']);
 const capped=mergeCandidates([
  {statementId:'a',candidateId:'x',similarity:.9,method:'nearest_statement'},
  {statementId:'b',candidateId:'x',similarity:.8,method:'nearest_statement'}
 ],1);
 assert.equal(capped.length,1);
});

test('contradictions and topical links form edges, not merge requests',()=>{
 for (const r of ['supports','contradicts','related','elaborates'] as const) assert.equal(shouldCreateEdge(r),true);
 for (const r of ['equivalent','unrelated','insufficient_context'] as const) assert.equal(shouldCreateEdge(r),false);
});

test('classifications require evidence and provenance; uncertainty remains valid',()=>{
 assert.throws(()=>validateAssessment({...assessment('contradicts'),evidenceSegmentIds:[]}),/source evidence/);
 assert.throws(()=>validateAssessment({...assessment('equivalent'),modelId:''}),/provenance/);
 assert.throws(()=>validateAssessment({...assessment('supports'),confidence:2}),/confidence/);
 assert.doesNotThrow(()=>validateAssessment({...assessment('insufficient_context'),evidenceSegmentIds:[],confidence:null}));
});

import {score,parseClassification,buildUserPrompt,type Prediction} from '../src/insight-eval.ts';

test('eval: parsing is strict and scoring counts failures against recall',()=>{
 assert.equal(parseClassification({relation:'Equivalent',reason:'x',confidence:.9})?.relation,'equivalent');
 assert.equal(parseClassification({relation:'same'}),null);
 assert.equal(parseClassification({relation:'related',confidence:3})?.confidence,null);
 const p:Prediction[]=[
  {id:'1',gold:'equivalent',pred:'equivalent'},
  {id:'2',gold:'related',pred:'equivalent'},
  {id:'3',gold:'contradicts',pred:null},
  {id:'4',gold:'contradicts',pred:'contradicts'},
  {id:'5',gold:'unrelated',pred:'insufficient_context'}
 ];
 const r=score(p);
 assert.equal(r.parseFailures,1);
 assert.equal(r.accuracy,2/5);
 assert.equal(r.falseMergeRate,1/3);          // 1 of 3 non-equivalent answered pairs predicted equivalent
 assert.equal(r.contradictionRecall,1/2);     // the failed parse is a miss
 assert.equal(r.overAbstainRate,1/4);
});

test('eval: swap consistency maps directional relations and ignores unscored pairs',()=>{
 const r=score([
  {id:'1',gold:'equivalent',pred:'equivalent',swapPred:'equivalent'},
  {id:'2',gold:'contradicts',pred:'contradicts',swapPred:'related'},
  {id:'3',gold:'supports',pred:'supports',swapPred:'elaborates'}   // directional: not in the symmetric set
 ]);
 assert.equal(r.swapConsistency,1/2);
 assert.match(buildUserPrompt({from:'a',to:'b',fromContext:'c'}),/context for A: c/);
});
