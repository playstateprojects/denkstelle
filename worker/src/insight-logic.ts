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

/** Candidate after merging: `method` is the strongest hit, `methods` every strategy that found the pair. */
export type MergedCandidate = Candidate & {methods:RetrievalMethod[]};

/** The nearest neighbours and counterclaim search are retrieval candidate generators,
 * not semantic verdicts. The farthest vectors are not a useful contradiction heuristic.
 * Deduplicate across retrieval strategies, keep the best similarity and remember every
 * method that found the pair, and never self-match. Statement pairs are deduplicated
 * unordered (relation direction is the classifier's job, not retrieval's); insight
 * candidates live in a separate key space so IDs of different kinds never collide.
 * The per-statement cap counts a statement on either side of a statement pair.
 */
export function mergeCandidates(input: Candidate[], maxPerStatement=20):MergedCandidate[] {
  if (!Number.isInteger(maxPerStatement)||maxPerStatement<1) throw new Error('invalid limit');
  const best=new Map<string,MergedCandidate>();
  for (const c of input) {
    if (!c.statementId || !c.candidateId || c.statementId===c.candidateId || !Number.isFinite(c.similarity)) continue;
    const isInsight=c.method==='nearest_insight';
    const key=isInsight?`insight:${c.statementId}:${c.candidateId}`:`statement:${[c.statementId,c.candidateId].sort().join(':')}`;
    const prev=best.get(key);
    if (!prev) { best.set(key,{...c,methods:[c.method]}); continue; }
    const methods=prev.methods.includes(c.method)?prev.methods:[...prev.methods,c.method];
    best.set(key,c.similarity>prev.similarity?{...c,methods}:{...prev,methods});
  }
  // Limit per statement to prevent highly connected statements dominating comparisons.
  const counts=new Map<string,number>();
  const take=(id:string)=>counts.set(id,(counts.get(id)??0)+1);
  return [...best.values()].sort((a,b)=>b.similarity-a.similarity).filter(c=>{
    const ids=c.method==='nearest_insight'?[c.statementId]:[c.statementId,c.candidateId];
    if (ids.some(id=>(counts.get(id)??0)>=maxPerStatement)) return false;
    ids.forEach(take);
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
 * merge whole connected components. The candidate must be 'equivalent' to the insight's
 * canonical statement, supported by its own validated assessment, so A≈B and B≈C never
 * imply A≈C. `canonical` is the assessment of the same statement against that canonical
 * meaning; both must involve the same statement.
 */
export function mayProposeMembership(a:Assessment, canonical:Assessment):boolean {
  validateAssessment(a);
  validateAssessment(canonical);
  const shared=[a.fromStatementId,a.toStatementId].some(id=>id===canonical.fromStatementId||id===canonical.toStatementId);
  return shared&&a.relation==='equivalent'&&canonical.relation==='equivalent';
}

/** Contradictions remain edges. Neither contradiction nor topical similarity is a merge. */
export function shouldCreateEdge(relation:Relation):boolean {
  return relation==='supports'||relation==='contradicts'||relation==='related'||relation==='elaborates';
}
