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

test('equivalent requires an independent check against the canonical insight',()=>{
 assert.equal(mayProposeMembership(assessment('equivalent'),'equivalent'),true);
 assert.equal(mayProposeMembership(assessment('equivalent'),'related'),false);
 assert.equal(mayProposeMembership(assessment('related'),'equivalent'),false);
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
