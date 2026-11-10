/** Evaluation helpers for the pairwise relation classifier: prompt, parsing and scoring.
 * Pure and testable; the CLI in scripts/eval-insights.ts does the model calls.
 */
import type {Relation} from './insight-logic.ts';

export const EVAL_PROMPT_VERSION='eval-1';
export const RELATIONS:readonly Relation[]=['equivalent','supports','contradicts','related','elaborates','unrelated','insufficient_context'];
/** Relations whose truth does not depend on which statement is "from": used for the swap-consistency check. */
export const SYMMETRIC:ReadonlySet<Relation>=new Set(['equivalent','contradicts','related','unrelated','insufficient_context']);
export const SWAPPED:Record<Relation,Relation>={equivalent:'equivalent',contradicts:'contradicts',related:'related',unrelated:'unrelated',insufficient_context:'insufficient_context',supports:'elaborates',elaborates:'supports'};

/** One hand-labelled pair. Labels must be written without looking at any model output. */
export type LabelledPair={id:string;from:string;to:string;fromContext?:string;toContext?:string;gold:Relation;note?:string};

export const SYSTEM_PROMPT=`You compare two statements taken from interviews and judge how they relate.
Choose exactly one relation for the pair (A, B):
- equivalent: A and B make the same claim, so one could replace the other without losing meaning.
- supports: A is evidence for, or an instance of, B's claim.
- elaborates: A adds detail, a cause or a condition to B's claim (B is the more general one).
- contradicts: A and B cannot both be true of the same situation.
- related: same topic, but none of the above.
- unrelated: different topics.
- insufficient_context: you cannot tell without more context. Prefer this over guessing.
Similar wording is not agreement; a negation or different scope can change the meaning. Use only the text given.
Reply as JSON: {"relation": "...", "reason": "one sentence", "confidence": 0 to 1}`;

export function buildUserPrompt(p:{from:string;to:string;fromContext?:string;toContext?:string}):string{
 const side=(l:string,t:string,c?:string)=>`${l}: ${t}${c?`\n(context for ${l}: ${c})`:''}`;
 return `${side('A',p.from,p.fromContext)}\n\n${side('B',p.to,p.toContext)}`;
}

export type Parsed={relation:Relation;reason:string;confidence:number|null};
/** Strict: anything unparseable is a failure that is counted, never silently coerced to a label. */
export function parseClassification(v:unknown):Parsed|null{
 if(!v||typeof v!=='object')return null;
 const o=v as Record<string,unknown>;
 const relation=typeof o.relation==='string'?o.relation.trim().toLowerCase() as Relation:undefined;
 if(!relation||!RELATIONS.includes(relation))return null;
 const c=o.confidence;
 const confidence=typeof c==='number'&&Number.isFinite(c)&&c>=0&&c<=1?c:null;
 return {relation,reason:typeof o.reason==='string'?o.reason:'',confidence};
}

export type Prediction={id:string;gold:Relation;pred:Relation|null;swapPred?:Relation|null};
export type Report={
 n:number;parseFailures:number;accuracy:number;
 perRelation:Record<string,{support:number;predicted:number;precision:number|null;recall:number|null;f1:number|null}>;
 confusion:Record<string,Record<string,number>>;
 /** Predicted equivalent when gold was not: the error that would wrongly merge insights. */
 falseMergeRate:number|null;
 contradictionRecall:number|null;contradictionPrecision:number|null;
 /** Share of non-abstained answers that were insufficient_context when gold was decidable. */
 overAbstainRate:number|null;
 swapConsistency:number|null;
};
const ratio=(a:number,b:number)=>b?a/b:null;

export function score(preds:Prediction[]):Report{
 const confusion:Report['confusion']={};
 const ok=preds.filter(p=>p.pred!==null);
 for(const p of ok){(confusion[p.gold]??={})[p.pred!]=(confusion[p.gold][p.pred!]??0)+1;}
 const perRelation:Report['perRelation']={};
 for(const r of RELATIONS){
  const support=preds.filter(p=>p.gold===r).length;
  const predicted=ok.filter(p=>p.pred===r).length;
  const tp=ok.filter(p=>p.gold===r&&p.pred===r).length;
  // Parse failures count against recall: the classifier did not find the pair.
  const precision=ratio(tp,predicted),recall=ratio(tp,support);
  const f1=precision!==null&&recall!==null&&precision+recall>0?2*precision*recall/(precision+recall):precision===null||recall===null?null:0;
  perRelation[r]={support,predicted,precision,recall,f1};
 }
 const notEquiv=ok.filter(p=>p.gold!=='equivalent');
 const decidable=ok.filter(p=>p.gold!=='insufficient_context');
 const swapped=preds.filter(p=>p.pred&&p.swapPred&&SYMMETRIC.has(p.gold));
 return {
  n:preds.length,parseFailures:preds.length-ok.length,
  accuracy:preds.length?ok.filter(p=>p.pred===p.gold).length/preds.length:0,
  perRelation,confusion,
  falseMergeRate:ratio(notEquiv.filter(p=>p.pred==='equivalent').length,notEquiv.length),
  contradictionRecall:perRelation.contradicts.recall,contradictionPrecision:perRelation.contradicts.precision,
  overAbstainRate:ratio(decidable.filter(p=>p.pred==='insufficient_context').length,decidable.length),
  swapConsistency:ratio(swapped.filter(p=>SWAPPED[p.pred!]===p.swapPred).length,swapped.length)
 };
}

const pct=(x:number|null)=>x===null?'  n/a':`${(x*100).toFixed(0).padStart(4)}%`;
export function formatReport(r:Report,title:string):string{
 const L=[`# ${title}`,`pairs: ${r.n}  parse failures: ${r.parseFailures}  accuracy: ${pct(r.accuracy).trim()}`,'',
  'relation              support  pred   prec   rec    f1'];
 for(const k of RELATIONS){const x=r.perRelation[k];L.push(`${k.padEnd(21)} ${String(x.support).padStart(7)} ${String(x.predicted).padStart(5)} ${pct(x.precision)} ${pct(x.recall)} ${pct(x.f1)}`);}
 L.push('',`false-merge rate (gold!=equivalent, predicted equivalent): ${pct(r.falseMergeRate).trim()}`,
  `contradiction recall / precision: ${pct(r.contradictionRecall).trim()} / ${pct(r.contradictionPrecision).trim()}`,
  `over-abstain rate (insufficient_context on decidable pairs): ${pct(r.overAbstainRate).trim()}`,
  `swap consistency (A,B vs B,A): ${pct(r.swapConsistency).trim()}`,'','confusion (rows gold, cols predicted):');
 for(const g of RELATIONS)if(r.confusion[g])L.push(`  ${g}: ${Object.entries(r.confusion[g]).map(([k,v])=>`${k}=${v}`).join(' ')}`);
 return L.join('\n');
}
