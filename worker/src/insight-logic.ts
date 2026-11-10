/** Pure, testable decision policy for the next Denkstelle insights pipeline.
 * Integration with pgvector retrieval and JEV / alternative classifier is intentionally
 * separate: no model behaviour is simulated here and these functions do not mutate DB.
 */
export type Relation = 'equivalent' | 'supports' | 'contradicts' | 'related' | 'elaborates' | 'unrelated' | 'insufficient_context';
export type RetrievalMethod = 'nearest_statement' | 'nearest_insight' | 'counterclaim' | 'manual';
export type Candidate = {statementId:string;candidateId:string;similarity:number;method:RetrievalMethod};
export type Assessment = {
  fromStatementId:string;
  toStatementId:string;
  relation:Relation;
  reason:string;
  confidence:number|null;
  evidenceSegmentIds:string[];
  modelId:string;
  promptVersion:string;
};
export type InsightMembership = {insightId:string;statementId:string;role:'supports'|'challenges'|'context'};

const VALID = new Set<Relation>(['equivalent','supports','contradicts','related','elaborates','unrelated','insufficient_context']);
const RELATED = new Set<Relation>(['equivalent','supports','contradicts','related','elaborates']);

/** The nearest neighbours and counterclaim search are retrieval candidate generators,
 * not semantic verdicts. The farthest vectors are not a useful contradiction heuristic.
 * Deduplicate across retrieval strategies, keep the best similarity, and never self-match.
 */
export function mergeCandidates(input: Candidate[], maxPerStatement=20):Candidate[] {
  if (!Number.isInteger(maxPerStatement)||maxPerStatement<1) throw new Error('invalid limit');
  const best=new Map<string,Candidate>();
  for (const c of input) {
    if (!c.statementId || !c.candidateId || c.statementId===c.candidateId || !Number.isFinite(c.similarity)) continue;
    const key=[c.statementId,c.candidateId].sort().join(':');
    const prev=best.get(key);
    if (!prev||c.similarity>prev.similarity) best.set(key,c);
  }
  // Limit per origin to prevent highly connected statements dominating comparisons.
  const counts=new Map<string,number>();
  return [...best.values()].sort((a,b)=>b.similarity-a.similarity).filter(c=>{
    const n=counts.get(c.statementId)??0;
    if(n>=maxPerStatement)return false;
    counts.set(c.statementId,n+1);
    return true;
  });
}

/** Reject malformed, unsupported judgements. An LLM's confidence is metadata, not truth. */
export function validateAssessment(a: Assessment): void {
  if (!a.fromStatementId||!a.toStatementId||a.fromStatementId===a.toStatementId) throw new Error('invalid statement pair');
  if (!VALID.has(a.relation)) throw new Error('unknown relation');
  if (!a.modelId||!a.promptVersion) throw new Error('missing classifier provenance');
  if (!a.reason.trim()) throw new Error('classification requires a reason');
  if (a.confidence!==null&&(!Number.isFinite(a.confidence)||a.confidence<0||a.confidence>1)) throw new Error('invalid confidence');
  if (RELATED.has(a.relation)&&a.evidenceSegmentIds.length===0) throw new Error('positive relation requires source evidence');
}

/** An equivalence classifier may *propose* membership, but cannot automatically
 * merge whole connected components. Compare against the insight's canonical meaning,
 * and avoid transitive A≈B≈C => A≈C errors.
 */
export function mayProposeMembership(a:Assessment, canonicalRelation:Relation):boolean {
  validateAssessment(a);
  return a.relation==='equivalent'&&canonicalRelation==='equivalent';
}

/** Contradictions remain edges. Neither contradiction nor topical similarity is a merge. */
export function shouldCreateEdge(relation:Relation):boolean {
  return relation==='supports'||relation==='contradicts'||relation==='related'||relation==='elaborates';
}
