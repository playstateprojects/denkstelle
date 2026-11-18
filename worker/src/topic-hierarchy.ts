/** Hierarchy over topic themes (EXPERIMENTAL: used by `npm run eval:topics`, not by the pipeline).
 *
 * `relate` looks at how themes overlap: heavy overlap lets the judge say same topic (merge) or which is an aspect of the other (sub-theme
 * edge); partial overlap becomes a DERIVED theme "A x B". `group` clusters sibling themes, has the chat model propose a parent, and has
 * the judge score each child. The eval (92 statements, 3 orders) found the parents readable at small cluster sizes but unstable across
 * orders, and the judge agreed with nearly every proposal, so this is kept out of the pipeline until it has user feedback to go on.
 */
import { z } from 'zod';
import { modelDef, llmComplete, parseJson, LlmError, type Env } from './models.ts';
import type { Noul } from './jev.ts';
import { canonical } from './themes.ts';
import { speechAct, ACT, FILLER, label, EXAMPLES_PER_THEME, EXAMPLE_CHARS, type PlaceDeps } from './topic-match.ts';
import { TopicStore, cos, type Theme } from './topic-memory.ts';

/** What `relate` and `group` need: placement dependencies, with the in-memory store. */
export type Deps = Omit<PlaceDeps, 'store'> & { store: TopicStore; minOverlap?: number;
  /** relate also asks about each theme's NEAR_K nearest themes by label embedding when at least this similar (0 turns it off) */ nearCos?: number };

/** relate: statements in common before two themes are looked at, and the share of the smaller theme inside the larger that counts as "heavy". */
export const MIN_OVERLAP = 3;
/** Label-embedding nominations for relate: each theme's NEAR_K nearest themes at or above NEAR_COS. Name-only embeddings are loose (median pair 0.55, 90th percentile 0.65), so this is a nomination and the judge decides. */
export const NEAR_COS = .65;
export const NEAR_K = 2;
export const HEAVY = .6;
export const SAME_MIN = .7;
export const WITHIN_MIN = .7;
/** The other direction must be clearly weaker, otherwise the two are peers (or one topic), not parent and child. */
export const WITHIN_REVERSE_MAX = .5;


export function relationQuestions(a: { name: string; description: string; examples: string[] }, b: { name: string; description: string; examples: string[] }): { state: Record<string, unknown>; questions: Record<string, Noul> } {
  const side = (t: typeof a) => ({ name: t.name, description: t.description, statements_filed_under_it: t.examples });
  const within = (x: string, y: string): Noul => ({
    type: 'noul',
    instructions: `Is \`${x}\` a specific aspect of \`${y}\`, so that a statement about \`${x}\` is also about \`${y}\`?`,
    criteria: { true: `Everything filed under ${x} is also about ${y}, and ${y} covers more than ${x} does.`, false: `${x} is the same subject as ${y}, or wider than it, or a separate subject that merely often comes up with it.` }
  });
  return {
    state: { topic_a: side(a), topic_b: side(b) },
    questions: {
      same_topic: { type: 'noul', instructions: 'Are `topic_a` and `topic_b` the same topic, worded differently?', criteria: { true: 'Both names describe one subject, and the statements filed under either would fit the other.', false: 'They are different subjects, or one is an aspect of the other.' } },
      a_within_b: within('topic_a', 'topic_b'),
      b_within_a: within('topic_b', 'topic_a')
    }
  };
}

/** Every pair the judge was asked about, kept so thresholds can be re-scored and rejected pairs read. a and b are theme names. */
export type JudgedPair = { a: string; b: string; aSize: number; bSize: number; both: number; by: 'overlap' | 'embedding'; same: number; aInB: number; bInA: number; outcome: 'merged' | 'sub:a<b' | 'sub:b<a' | 'loop' | 'kept' };
export type RelateResult = { judged: JudgedPair[]; nominatedByOverlap: number; nominatedByEmbedding: number; asked: number; merged: number; sub: number; derived: number; kept: number; failed: string[] };

/** Hierarchy pass over the atomic themes, run once after placement. See the header for the rules. */
export async function relate(d: Deps): Promise<RelateResult> {
  const store = d.store, out: RelateResult = { judged: [], nominatedByOverlap: 0, nominatedByEmbedding: 0, asked: 0, merged: 0, sub: 0, derived: 0, kept: 0, failed: [] };
  const minOverlap = d.minOverlap ?? MIN_OVERLAP, nearCos = d.nearCos ?? NEAR_COS;
  let m = store.members();
  const ids = [...m.keys()].sort();
  type Pair = { a: string; b: string; both: number; cont: number; by: 'overlap' | 'embedding' };
  const key = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;
  const ask: Pair[] = [], partial: Pair[] = [], asking = new Set<string>();
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const A = new Set(m.get(ids[i])), both = m.get(ids[j])!.filter(x => A.has(x)).length;
    if (both < minOverlap) continue;
    const cont = both / Math.min(m.get(ids[i])!.length, m.get(ids[j])!.length), p: Pair = { a: ids[i], b: ids[j], both, cont, by: 'overlap' };
    if (cont >= HEAVY) { ask.push(p); asking.add(key(p.a, p.b)); out.nominatedByOverlap++ } else partial.push(p);
  }
  ask.sort((x, y) => y.cont - x.cont || y.both - x.both);
  if (nearCos > 0) for (const a of ids) {
    const A = store.themes.get(a)!;
    for (const n of store.nearestByLabel(A.vec, NEAR_K + 1).filter(t => t.id !== a).slice(0, NEAR_K)) {
      if (cos(A.vec, n.vec) < nearCos || asking.has(key(a, n.id))) continue;
      asking.add(key(a, n.id)); out.nominatedByEmbedding++;
      const both = (m.get(a) ?? []).filter(x => new Set(m.get(n.id)).has(x)).length;
      ask.push({ a, b: n.id, both, cont: both / Math.min(m.get(a)!.length, m.get(n.id)!.length), by: 'embedding' });
    }
  }
  const descends = (x: string, of: string): boolean => store.relations.some(r => r.parent === of && (r.child === x || descends(x, r.child)));
  const gone = new Set<string>();
  const some = (id: string) => (m.get(id) ?? []).slice(0, EXAMPLES_PER_THEME).map(s => store.statements.find(x => x.id === s)!.text.slice(0, EXAMPLE_CHARS));
  for (const pair of ask) {
    if (gone.has(pair.a) || gone.has(pair.b)) continue;
    const A = store.themes.get(pair.a)!, B = store.themes.get(pair.b)!;
    try {
      const { state, questions } = relationQuestions({ name: A.name, description: A.description, examples: some(A.id) }, { name: B.name, description: B.description, examples: some(B.id) });
      const { answers, tokens } = await d.ask(state, questions); d.stats.judgeCalls++; d.stats.judgeTokens += tokens; out.asked++;
      const same = answers.same_topic, aInB = answers.a_within_b, bInA = answers.b_within_a;
      const sizeA = m.get(A.id)!.length, sizeB = m.get(B.id)!.length;
      let outcome: JudgedPair['outcome'] = 'kept';
      const sub = (parent: Theme, child: Theme, p: number, rev: number) => {
        if (descends(parent.id, child.id)) { out.kept++; outcome = 'loop'; return }   // would close a loop
        store.relations.push({ parent: parent.id, child: child.id, p, judged: { same, childInParent: p, parentInChild: rev }, kind: 'sub' }); out.sub++;
        outcome = parent === B ? 'sub:a<b' : 'sub:b<a';
      };
      if (same >= SAME_MIN) {
        const [s, x] = sizeA >= sizeB ? [A, B] : [B, A]; store.merge(s.id, x.id, same, pair.both); gone.add(x.id); out.merged++; m = store.members(); outcome = 'merged';
      } else if (aInB >= WITHIN_MIN && bInA <= WITHIN_REVERSE_MAX) sub(B, A, aInB, bInA);
      else if (bInA >= WITHIN_MIN && aInB <= WITHIN_REVERSE_MAX) sub(A, B, bInA, aInB);
      else out.kept++;
      out.judged.push({ a: A.name, b: B.name, aSize: sizeA, bSize: sizeB, both: pair.both, by: pair.by, same, aInB, bInA, outcome });
    } catch (e) { out.failed.push(`${A.name} / ${B.name}: ${e instanceof Error ? e.message : e}`) }
  }
  // Partial overlaps become derived themes: the statements carrying both tags, no model call. Weight = the weaker of the two edges.
  for (const pair of partial) {
    if (gone.has(pair.a) || gone.has(pair.b)) continue;
    const A = store.themes.get(pair.a)!, B = store.themes.get(pair.b)!;
    const t = store.create(`${A.name} × ${B.name}`, '', [], 'derived');
    for (const [, links] of store.links) {
      const a = links.get(A.id), b = links.get(B.id); if (!a || !b) continue;
      links.set(t.id, { p: Math.min(a.p ?? 1, b.p ?? 1), method: 'seed' });
    }
    store.relations.push({ parent: A.id, child: t.id, p: 1, judged: null, kind: 'derived' }, { parent: B.id, child: t.id, p: 1, judged: null, kind: 'derived' });
    out.derived++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Grouping: sibling themes often share a parent that does not exist yet ("wheelchair accessibility" and "device accessibility" are
// both accessibility, neither is an aspect of the other), so judging pairs of existing themes cannot find them. This step does:
//   1. cluster the root themes by label embedding (average linkage, at most MAX_CLUSTER themes, at least GROUP_COS similar)   [code]
//   2. the chat model proposes ONE broader parent topic for a cluster, or says there is none                                 [generation]
//   3. the judge scores each child: is it a specific aspect of the proposed parent? One request per cluster                  [judgement]
//   4. children at or above WITHIN_MIN get the edge; a NEW parent needs at least two of them, otherwise it is dropped         [code]
// A proposed name equal to an existing theme reuses that theme as the parent.

export const GROUP_COS = .65;
export const MAX_CLUSTER = 8;
export const PARENT_SYSTEM = `You name the broader topic that several narrower topics belong to. Input: CHILD TOPICS (name: description). Produce valid JSON only:
{"parent":{"name":"1-4 word label","description":"one neutral sentence saying what the topic covers"}}
or {"parent":null} when the topics have no honest common subject.
Rules:
- The parent is a subject that is WIDER than each child it covers: a statement about any one of those children is also about the parent. It is not a list of the children ("A and B"), and it is not one of the children renamed.
- It may cover most of the children rather than all of them; if it fits only one, or none, answer null.
- Never generic ("miscellaneous", "other", "general", "issues", "aspects", "experience") and never a kind of speech act ("feedback", "ideas", "criticism", "suggestions").
- Write the name and description in English.`;

export type Parent = { name: string; description: string };
export type Proposer = (children: { name: string; description: string }[]) => Promise<Parent | null>;
export class ProposeError extends LlmError { }
const Proposed = z.object({ parent: z.object({ name: z.string().min(2), description: z.string().default('') }).nullable() });
const GENERIC = new Set(['miscellaneous', 'other', 'others', 'general', 'various', 'issues', 'issue', 'aspects', 'aspect', 'things', 'topics', 'topic', 'experience', 'misc', 'stuff']);
export const genericName = (name: string) => { const w = name.toLowerCase().split(/[^a-zà-ÿ]+/).filter(x => x && !FILLER.has(x)); return !w.length || w.every(x => GENERIC.has(x) || ACT.has(x)) };

export const modelProposer = (env: Env, modelId: string, temperature = 0): Proposer => async children => {
  const def = modelDef(modelId); if (!def) throw new ProposeError(`Unknown model "${modelId}"`);
  const out = await llmComplete(def, env, { system: PARENT_SYSTEM, user: `CHILD TOPICS:\n${children.map(c => `- ${label(c)}`).join('\n')}\n\nReturn JSON.`, temperature });
  let json: unknown;
  try { json = parseJson(out.raw) } catch { throw new ProposeError(`${def.label} did not return valid JSON`, out.raw, out.ms) }
  const parsed = Proposed.safeParse(json);
  if (!parsed.success) throw new ProposeError(`${def.label} parent JSON does not match the expected shape`, out.raw, out.ms);
  const pr = parsed.data.parent; if (!pr) return null;
  const name = pr.name.trim().slice(0, 60);
  if (!canonical(name) || genericName(name) || speechAct(name)) return null;
  return { name, description: pr.description.trim().slice(0, 300) };
};

/** Average-linkage agglomerative clustering by cosine; merging stops below `t` or when a cluster would pass `max`. Only clusters of 2+ are returned. */
export function cluster(items: { id: string; vec: number[] }[], t = GROUP_COS, max = MAX_CLUSTER): string[][] {
  let cs = items.map(i => [i]);
  const avg = (a: typeof items, b: typeof items) => { let s = 0; for (const x of a) for (const y of b) s += cos(x.vec, y.vec); return s / (a.length * b.length) };
  for (;;) {
    let best = -1, bi = -1, bj = -1;
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      if (cs[i].length + cs[j].length > max) continue;
      const v = avg(cs[i], cs[j]); if (v > best) { best = v; bi = i; bj = j }
    }
    if (best < t) break;
    cs = cs.filter((_, k) => k !== bi && k !== bj).concat([[...cs[bi], ...cs[bj]]]);
  }
  return cs.filter(c => c.length >= 2).map(c => c.map(x => x.id));
}

export function parentQuestions(parent: Parent, children: { name: string; description: string; examples: string[] }[]): { state: Record<string, unknown>; questions: Record<string, Noul> } {
  const questions: Record<string, Noul> = {}, topics: Record<string, unknown> = {};
  children.forEach((c, i) => {
    topics[`c${i}`] = { name: c.name, ...(c.description ? { description: c.description } : {}), statements_filed_under_it: c.examples };
    questions[`c${i}`] = {
      type: 'noul',
      instructions: `Is \`topics.c${i}\` a specific aspect of \`parent\`, so that a statement about \`topics.c${i}\` is also about \`parent\`?`,
      criteria: { true: 'Everything filed under the topic is also about the parent, and the parent covers more than the topic does.', false: 'The topic is the same subject as the parent, or wider than it, or a separate subject that only sometimes comes up with it.' }
    };
  });
  return { state: { parent: { name: parent.name, description: parent.description }, topics }, questions };
}

export type GroupResult = { clusters: number; proposed: number; none: number; parents: number; reused: number; dropped: number; edges: number; failed: string[];
  detail: { parent: string; reused: boolean; kept: boolean; children: { name: string; p: number; linked: boolean }[] }[] };

export async function group(d: Deps & { propose: Proposer; groupCos?: number; maxCluster?: number }): Promise<GroupResult> {
  const store = d.store, out: GroupResult = { clusters: 0, proposed: 0, none: 0, parents: 0, reused: 0, dropped: 0, edges: 0, failed: [], detail: [] };
  const kids = store.childIds(), own = store.members();
  const roots = store.atomic().filter(t => !kids.has(t.id) && own.get(t.id)?.length && t.vec.length);
  const clusters = cluster(roots.map(t => ({ id: t.id, vec: t.vec })), d.groupCos ?? GROUP_COS, d.maxCluster ?? MAX_CLUSTER);
  out.clusters = clusters.length;
  const descends = (x: string, of: string): boolean => store.relations.some(r => r.parent === of && (r.child === x || descends(x, r.child)));
  for (const ids of clusters) {
    const cs = ids.map(id => store.themes.get(id)!).filter(t => !store.childIds().has(t.id));
    if (cs.length < 2) continue;
    try {
      const prop = await d.propose(cs.map(t => ({ name: t.name, description: t.description }))); out.proposed++;
      if (!prop) { out.none++; out.detail.push({ parent: '(none proposed)', reused: false, kept: false, children: cs.map(t => ({ name: t.name, p: 0, linked: false })) }); continue }
      const have = store.byCanonical(prop.name), reused = !!have;
      const kidsOf = cs.filter(t => t.id !== have?.id);
      const examples = (id: string) => (own.get(id) ?? []).slice(0, EXAMPLES_PER_THEME).map(sid => store.statements.find(x => x.id === sid)!.text.slice(0, EXAMPLE_CHARS));
      const { state, questions } = parentQuestions(prop, kidsOf.map(t => ({ name: t.name, description: t.description, examples: examples(t.id) })));
      const { answers, tokens } = await d.ask(state, questions); d.stats.judgeCalls++; d.stats.judgeTokens += tokens;
      const scored = kidsOf.map((t, i) => ({ t, p: answers[`c${i}`] })), passed = scored.filter(x => x.p >= WITHIN_MIN && !(have && descends(have.id, x.t.id)));
      const keep = reused ? passed.length >= 1 : passed.length >= 2;
      out.detail.push({ parent: prop.name, reused, kept: keep, children: scored.map(x => ({ name: x.t.name, p: x.p, linked: keep && passed.includes(x) })) });
      if (!keep) { out.dropped++; continue }
      let parent = have;
      if (!parent) { const [v] = await d.embed([label(prop)]); d.stats.embedCalls++; parent = store.create(prop.name, prop.description, v, 'parent'); out.parents++ } else out.reused++;
      for (const x of passed) { store.relations.push({ parent: parent.id, child: x.t.id, p: x.p, judged: null, kind: 'sub' }); out.edges++ }
    } catch (e) { out.failed.push(`${cs.map(t => t.name).join(', ')}: ${e instanceof Error ? e.message : e}`) }
  }
  return out;
}
