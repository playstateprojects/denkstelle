/** Merging themes that cover the same subject.
 *
 * Placement (theme-match.ts) lets a statement join up to three themes. When a statement is a clear yes for several themes, those
 * themes are probably one subject under different names, and the placements say so for free: the share of the smaller theme's
 * statements that also sit in the larger one. That overlap only NOMINATES a pair. Jev decides whether the two are the same topic
 * (one question per pair), and code owns the outcome:
 *
 *   overlap >= MIN_CONTAINMENT and at least MIN_OVERLAP statements in common   -> ask Jev
 *   Jev's P(same topic) >= MERGE_MIN                                            -> merge: the larger theme absorbs the smaller
 *   anything else                                                               -> keep both
 *
 * A false "keep" leaves a duplicate that the next run can still merge; a false "merge" pollutes a theme, so the bar is not low.
 * Merging is not splitting. When a theme is a large part of the project (a source about one subject), merging makes that visible;
 * finding structure inside it is the job of a later, separate step.
 *
 * Types only are imported from theme-match.ts, which calls this module.
 */
import type { ThemeStore, ThemeOverlap, Rewriter } from './theme-match.ts';
import { askNouls, type Noul } from './jev.ts';

export const MERGE_JEV_VERSION = 'merge-1';
/** Share of the smaller theme's statements that are also in the larger one. In the first Truth and lies run, themes that were
 * plainly one subject overlapped 0.70 to 0.88, and a theme that was only partly inside another 0.33. */
export const MIN_CONTAINMENT = .6;
/** Statements in common, so two small themes sharing one statement are not nominated. */
export const MIN_OVERLAP = 3;
/** Noul starting point from TypeSafe's guidance: at or above is a yes. */
export const MERGE_MIN = .7;
const EXAMPLES = 4;
const EXAMPLE_CHARS = 200;
const REWRITE_STATEMENTS = 40;
const MAX_CONSECUTIVE_FAILURES = 3;

export type Described = { id: string; name: string; description: string | null; examples: string[] };
/** P(the two are the same topic). Symmetric: the order is the caller's business. */
export type MergeJudge = (a: Described, b: Described) => Promise<number>;

export type Pair = { survivorId: string; absorbedId: string; overlap: number; containment: number };

/** The pairs worth asking about, most overlapping first. The larger theme survives (the older id on a tie, so it is deterministic). */
export function candidatePairs(overlaps: ThemeOverlap[], minContainment = MIN_CONTAINMENT, minOverlap = MIN_OVERLAP): Pair[] {
  return overlaps
    .filter(o => o.both >= minOverlap && o.both / Math.min(o.aSize, o.bSize) >= minContainment)
    .map(o => {
      const aWins = o.aSize > o.bSize || (o.aSize === o.bSize && o.a < o.b);
      return { survivorId: aWins ? o.a : o.b, absorbedId: aWins ? o.b : o.a, overlap: o.both, containment: o.both / Math.min(o.aSize, o.bSize) };
    })
    .sort((x, y) => y.containment - x.containment || y.overlap - x.overlap);
}

/** The truth table for one pair: Jev's probability in, merge or keep out. */
export const decideMerge = (p: number, min = MERGE_MIN) => p >= min;

export function buildMergeQuestion(a: Described, b: Described): { state: Record<string, unknown>; questions: Record<string, Noul> } {
  const side = (d: Described) => ({ name: d.name, ...(d.description ? { description: d.description } : {}), statements_filed_under_it: d.examples.map(e => e.slice(0, EXAMPLE_CHARS)) });
  return {
    state: { topic_a: side(a), topic_b: side(b) },
    questions: {
      same_topic: {
        type: 'noul',
        instructions: 'Are `topic_a` and `topic_b` the same topic, worded differently?',
        criteria: {
          true: 'Both describe the same subject, and a statement filed under one would fit the other just as well.',
          false: 'One is a narrower part of the other, or they cover different aspects of a shared general subject, even if their names overlap.'
        }
      }
    }
  };
}

export const jevMergeJudge = (env: { TYPESAFE_API_KEY?: string }): MergeJudge => async (a, b) => {
  const { state, questions } = buildMergeQuestion(a, b);
  return (await askNouls(env, state, questions)).answers.same_topic;
};

export type Merged = { survivorId: string; absorbedId: string; survivor: string; absorbed: string; overlap: number; containment: number; p: number; renamedTo?: string };
export type Kept = { aId: string; bId: string; a: string; b: string; overlap: number; containment: number; p: number };
export type MergeResult = { merged: Merged[]; kept: Kept[]; failed: { pair: string; error: string }[]; aborted: boolean };
export type MergeDeps = { store: ThemeStore; judge: MergeJudge; rewrite?: Rewriter; minContainment?: number; minOverlap?: number; minP?: number };

/** Merges until no nominated pair is left that has not been judged "keep". After each merge the overlaps are read again, because
 * the survivor is now larger and may overlap others differently. A pair is asked once per run. A Jev failure skips the pair
 * (never counted as "no": it is reported); three failures in a row stop the run. */
export async function mergeThemes(d: MergeDeps, o: { onMerged?: (m: Merged) => void; onKept?: (k: Kept) => void } = {}): Promise<MergeResult> {
  const out: MergeResult = { merged: [], kept: [], failed: [], aborted: false };
  const asked = new Set<string>();
  let streak = 0;
  for (;;) {
    const pair = candidatePairs(await d.store.overlaps(), d.minContainment, d.minOverlap).find(p => !asked.has(`${p.survivorId}|${p.absorbedId}`));
    if (!pair) break;
    asked.add(`${pair.survivorId}|${pair.absorbedId}`);
    const [sg, ag] = await Promise.all([d.store.growth(pair.survivorId), d.store.growth(pair.absorbedId)]);
    try {
      const [se, ae] = await Promise.all([d.store.sample(pair.survivorId, EXAMPLES), d.store.sample(pair.absorbedId, EXAMPLES)]);
      const p = await d.judge(
        { id: pair.survivorId, name: sg.name, description: sg.description, examples: se.map(s => s.text) },
        { id: pair.absorbedId, name: ag.name, description: ag.description, examples: ae.map(s => s.text) });
      if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new Error(`Expected a probability between 0 and 1, got ${JSON.stringify(p)}`);
      streak = 0;
      if (!decideMerge(p, d.minP)) {
        const k = { aId: pair.survivorId, bId: pair.absorbedId, a: sg.name, b: ag.name, overlap: pair.overlap, containment: pair.containment, p };
        out.kept.push(k); o.onKept?.(k); continue;
      }
      await d.store.merge(pair.survivorId, pair.absorbedId, { probability: p, overlap: pair.overlap, by: MERGE_JEV_VERSION });
      const m: Merged = { survivorId: pair.survivorId, absorbedId: pair.absorbedId, survivor: sg.name, absorbed: ag.name, overlap: pair.overlap, containment: pair.containment, p };
      // The survivor now holds both memberships, so its wording is written again from all of them. The merge already happened:
      // a failed rewrite is logged and the wording is retried when the theme next grows.
      if (d.rewrite) try {
        const g = await d.store.growth(pair.survivorId);
        const next = await d.rewrite({ theme: { name: g.name, description: g.description }, statements: await d.store.sample(pair.survivorId, REWRITE_STATEMENTS), size: g.size });
        const r = await d.store.rename(pair.survivorId, next, g.size, MERGE_JEV_VERSION);
        if (r.renamed) m.renamedTo = next.name;
      } catch (e) { console.error(`Merged theme ${pair.survivorId} not rewritten, the old wording stays:`, e instanceof Error ? e.message : e) }
      out.merged.push(m); o.onMerged?.(m);
    } catch (e) {
      out.failed.push({ pair: `${sg.name} + ${ag.name}`, error: e instanceof Error ? e.message : String(e) });
      if (++streak >= MAX_CONSECUTIVE_FAILURES) { out.aborted = true; break }
    }
  }
  return out;
}
