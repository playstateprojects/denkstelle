/** Topic-first theme placement over the frozen statement set, in memory, several times in different orders (worker/src/topic-match.ts, plus the experimental hierarchy in topic-hierarchy.ts).
 *   npm run eval:topics -- [--set eval/statements/q1-better/deepseek-flash] [--runs 3] [--seed 1] [--judge jev|clef] [--link 0.5] [--no-hint] [--no-relate] [--limit N] [--min-overlap 3] [--near-cos 0.65 (0 = off)]
 *                          [--group-cos 0.65] [--max-cluster 8] [--no-group] [--from eval/results/topics-<ts>.json (reuse its placement, run only grouping)]
 *                          [--baseline eval/results/themes-theme-4-<ts>.json[,more.json]]
 * Reports what eval:themes reports, for comparison: theme count, single-statement themes, hub size (the largest theme's share of
 * statements), and order sensitivity (pair agreement between runs: do two statements share a theme?). Writes eval/results/topics-*.json
 * in the same shape as themes-*.json, so either file can be a --baseline. Run 0 is the original order, the rest are shuffled.
 * Calls the chat model, the embedding model and Jev/Clef for real; it writes nothing to a database.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { DEFAULT_MODEL } from '../worker/src/models.ts';
import { askNouls } from '../worker/src/jev.ts';
import { askNoulsClef } from '../worker/src/clef.ts';
import { embeddings } from '../worker/src/utils.ts';
import { DEFAULT_PROMPTS } from '../worker/src/prompts.ts';
import { modelExtractor, placeAll, newStats, guard, TOPIC_VERSION, LINK_MIN, type Ask } from '../worker/src/topic-match.ts';
import { TopicStore } from '../worker/src/topic-memory.ts';
import { modelProposer, relate, group, MIN_OVERLAP, NEAR_COS, GROUP_COS, MAX_CLUSTER } from '../worker/src/topic-hierarchy.ts';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined };
const flag = (n: string) => process.argv.includes(`--${n}`);
const set = arg('set') ?? 'eval/statements/q1-better/deepseek-flash', runs = Number(arg('runs') ?? 3), seed = Number(arg('seed') ?? 1);
const judgeName = arg('judge') ?? 'jev', linkMin = Number(arg('link') ?? LINK_MIN), minOverlap = Number(arg('min-overlap') ?? MIN_OVERLAP), nearCos = Number(arg('near-cos') ?? NEAR_COS);
const groupCos = Number(arg('group-cos') ?? GROUP_COS), maxCluster = Number(arg('max-cluster') ?? MAX_CLUSTER);
/** --from <topics-*.json>: reuse that file's placement (themes, edges, sub-theme edges) and only run the grouping step. No extractor calls. */
const from = arg('from'), prior = from ? JSON.parse(await readFile(from, 'utf8')) : null;
const ask: Ask = judgeName === 'clef' ? (s, q) => askNoulsClef(process.env, s, q) : (s, q) => askNouls(process.env, s, q);
const PRICE_PER_MTOK = judgeName === 'clef' ? .24 : .042;

const rows = (await readFile(`${set}.jsonl`, 'utf8')).split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as { text: string });
const vecs: number[][] = JSON.parse(await readFile(`${set}.emb.json`, 'utf8'));
if (vecs.length !== rows.length) throw new Error(`${rows.length} statements but ${vecs.length} vectors`);
const statements = rows.map((r, i) => ({ id: `s${i}`, text: r.text, vec: vecs[i] })).slice(0, Number(arg('limit') ?? Infinity));
const N = statements.length;

const rng = (s: number) => () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 };
const shuffled = <T,>(a: T[], r: () => number) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [b[i], b[j]] = [b[j], b[i]] } return b };

// Label embeddings are cached across runs: the same label is the same vector.
const cache = new Map<string, Promise<number[]>>();
const embed = async (texts: string[]) => {
  const need = [...new Set(texts.filter(t => !cache.has(t)))];
  if (need.length) { const got = embeddings(need); need.forEach((t, i) => cache.set(t, got.then(v => v[i]))) }
  return Promise.all(texts.map(t => cache.get(t)!));
};
const extract = modelExtractor(process.env, DEFAULT_MODEL, DEFAULT_PROMPTS.text('topic_extract_system')), propose = modelProposer(process.env, DEFAULT_MODEL);

type Themes = { name: string; statements: string[] }[];
const pairs = (themes: Themes) => { const out = new Set<string>(); for (const t of themes) for (const a of t.statements) for (const b of t.statements) if (a < b) out.add(`${a}|${b}`); return out };
const f1 = (a: Set<string>, b: Set<string>) => { let both = 0; for (const x of a) if (b.has(x)) both++; const p = a.size ? both / a.size : 0, q = b.size ? both / b.size : 0; return p + q ? 2 * p * q / (p + q) : 0 };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
/** The numbers that are compared: themes (atomic ones, after merges), singletons, hub share, how many statements sit in any theme. */
const summarise = (runsThemes: Themes[], total: number) => {
  const per = runsThemes.map(ts => {
    const sizes = ts.map(t => t.statements.length).sort((a, b) => b - a);
    return { themes: ts.length, singles: sizes.filter(s => s === 1).length, hub: (sizes[0] ?? 0) / total, top3: sizes.slice(0, 3).map(s => (s / total)), covered: new Set(ts.flatMap(t => t.statements)).size / total };
  });
  const agree: number[] = [];
  for (let i = 0; i < runsThemes.length; i++) for (let j = i + 1; j < runsThemes.length; j++) agree.push(f1(pairs(runsThemes[i]), pairs(runsThemes[j])));
  return { per, agree };
};
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const show = (title: string, s: ReturnType<typeof summarise>) => {
  console.log(`\n${title}`);
  s.per.forEach((p, i) => console.log(`  run ${i}: ${String(p.themes).padStart(3)} themes, ${String(p.singles).padStart(2)} single-statement, hub ${pct(p.hub)} (top 3: ${p.top3.map(pct).join(', ')}), ${pct(p.covered)} of statements in a theme`));
  console.log(`  pair agreement between runs (F1): ${s.agree.length ? s.agree.map(a => a.toFixed(2)).join(', ') + `  (mean ${mean(s.agree).toFixed(2)})` : 'n/a'}`);
};

console.log(`${TOPIC_VERSION}: ${N} statements, ${prior ? `grouping only, placement from ${from}` : `${runs} runs`}, judge ${judgeName}, link >= ${linkMin}, relate: overlap >= ${minOverlap}, embedding nominations >= ${nearCos}, grouping: cluster >= ${groupCos}, max ${maxCluster}${flag('no-hint') ? ', no vocabulary hint' : ''}`);
const t0 = Date.now();
const nRuns = prior ? Math.min(runs, prior.runs.length) : runs;
const results = await Promise.all(Array.from({ length: nRuns }, async (_, r) => {
  const store = new TopicStore(statements), stats = newStats();
  const d = { store, extract, embed, ask, stats, linkMin, hint: !flag('no-hint'), minOverlap, nearCos };
  let order: string[], placed: { failed: { id: string; error: string }[]; aborted: boolean }, rel: Awaited<ReturnType<typeof relate>> | null = null;
  if (prior) {
    const pr = prior.runs[r]; order = pr.order ?? statements.map(s => s.id); placed = { failed: [], aborted: false };
    const vs = await embed(pr.themes.map((x: { name: string; description?: string }) => x.description ? `${x.name}: ${x.description}` : x.name));
    const ids = new Map<string, string>();
    pr.themes.forEach((x: { name: string; description?: string }, i: number) => ids.set(x.name, store.create(x.name, x.description ?? '', vs[i]).id));
    for (const e of pr.edges) if (ids.has(e.theme)) store.link(e.statement, [{ themeId: ids.get(e.theme)!, edge: { p: e.p, method: e.method } }]);
    for (const x of pr.relations) if (x.kind === 'sub' && ids.has(x.parent) && ids.has(x.child)) store.relations.push({ parent: ids.get(x.parent)!, child: ids.get(x.child)!, p: x.p, judged: null, kind: 'sub' });
    if (flag('relate')) rel = await relate(d);
  } else {
    order = r === 0 ? statements.map(s => s.id) : shuffled(statements.map(s => s.id), rng(seed + r));
    placed = await placeAll(d, order.map(id => statements.find(s => s.id === id)!), (_, __, n) => { if (n % 20 === 0) console.log(`  run ${r}: ${n}/${N} placed`) });
    rel = flag('no-relate') || placed.aborted ? null : await relate(d);
  }
  const grp = flag('no-group') || placed.aborted ? null : await group({ ...d, propose, groupCos, maxCluster });
  const roots = store.roots();
  const members = store.members(), allMembers = store.members(true);
  const atomic = store.atomic().map(t => ({ name: t.name, description: t.description, statements: members.get(t.id) ?? [] })).filter(t => t.statements.length);
  const withDerived: Themes = [...store.themes.values()].map(t => ({ name: t.name, statements: allMembers.get(t.id) ?? [] })).filter(t => t.statements.length);
  const name = (id: string) => store.themes.get(id)?.name ?? id;
  return {
    order, atomic, withDerived, placed, rel, grp, roots, stats,
    relations: store.relations.map(x => ({ parent: name(x.parent), child: name(x.child), p: x.p, kind: x.kind, judged: x.judged })),
    parents: [...store.themes.values()].filter(x => x.kind === 'parent').map(x => ({ name: x.name, description: x.description })),
    merges: store.merges,
    edges: [...store.links].flatMap(([sid, m]) => [...m].filter(([tid]) => store.themes.get(tid)?.kind === 'atomic').map(([tid, e]) => ({ statement: sid, theme: name(tid), p: e.p, method: e.method })))
  };
}));
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);

const mine = summarise(results.map(r => r.atomic), N);
show(`${TOPIC_VERSION} (atomic themes, after merges; derived themes excluded)`, mine);
show(`${TOPIC_VERSION} including derived intersection themes`, summarise(results.map(r => r.withDerived), N));
show(`${TOPIC_VERSION} TOP LEVEL: themes that are not sub-themes, each with the statements of its whole subtree`, summarise(results.map(r => r.roots), N));

const baselines = (arg('baseline') ?? '').split(',').filter(Boolean);
for (const file of baselines) {
  const b = JSON.parse(await readFile(file, 'utf8')) as { jev?: string; runs: { themes: Themes }[]; statements: unknown[] };
  show(`BASELINE ${file.split('/').pop()} (${b.jev ?? '?'})`, summarise(b.runs.map(r => r.themes), b.statements.length));
}

console.log('\nWork per run (mean over runs):');
const st = results.map(r => r.stats);
console.log(`  chat-model extractions: ${mean(st.map(s => s.extractCalls)).toFixed(0)}, ${judgeName} requests: ${mean(st.map(s => s.judgeCalls)).toFixed(0)}, embedding requests: ${mean(st.map(s => s.embedCalls)).toFixed(0)}`);
console.log(`  topics per statement: ${mean(st.flatMap(s => s.topicsPerStatement)).toFixed(2)} (max ${Math.max(...st.flatMap(s => s.topicsPerStatement))})`);
console.log(`  ${judgeName} input tokens: ${mean(st.map(s => s.judgeTokens)).toFixed(0)} per run, about $${(mean(st.map(s => s.judgeTokens)) / 1e6 * PRICE_PER_MTOK).toFixed(4)}`);
console.log(`  topics created as a new theme: ${mean(st.map(s => s.created)).toFixed(0)}, linked to a theme found by embedding: ${mean(st.map(s => s.embedLinks)).toFixed(0)}`);
console.log(`  exact-name reuse: ${mean(st.map(s => s.reuseExact)).toFixed(0)} topics, of which the judge scored below ${linkMin}: ${mean(st.map(s => s.reuseExactBelow)).toFixed(1)} (how often the judge disagreed with the extractor's reuse)`);
const rel = results.map(r => r.rel).filter(Boolean) as NonNullable<(typeof results)[0]['rel']>[];
if (rel.length) console.log(`  relate (mean): ${mean(rel.map(r => r.asked)).toFixed(1)} pairs asked (${mean(rel.map(r => r.nominatedByOverlap)).toFixed(1)} nominated by overlap, ${mean(rel.map(r => r.nominatedByEmbedding)).toFixed(1)} by embedding), ${mean(rel.map(r => r.merged)).toFixed(1)} merged, ${mean(rel.map(r => r.sub)).toFixed(1)} sub-theme edges, ${mean(rel.map(r => r.kept)).toFixed(1)} kept apart, ${mean(rel.map(r => r.derived)).toFixed(1)} derived themes`);

const grps = results.map(r => r.grp).filter(Boolean) as NonNullable<(typeof results)[0]['grp']>[];
if (grps.length) {
  console.log(`  group (mean): ${mean(grps.map(g => g.clusters)).toFixed(1)} clusters, ${mean(grps.map(g => g.none)).toFixed(1)} with no parent proposed, ${mean(grps.map(g => g.parents)).toFixed(1)} new parents kept, ${mean(grps.map(g => g.reused)).toFixed(1)} existing themes reused as parent, ${mean(grps.map(g => g.dropped)).toFixed(1)} dropped (fewer than 2 children passed), ${mean(grps.map(g => g.edges)).toFixed(1)} child edges`);
  results.forEach((r, i) => {
    if (!r.grp) return;
    console.log(`\nGrouping, run ${i} (${r.grp.detail.length} clusters; child p = judge's "is an aspect of the parent"):`);
    for (const x of r.grp.detail) {
      console.log(`  ${x.kept ? 'KEEP' : 'drop'}  ${x.parent}${x.reused ? '  (existing theme)' : ''}`);
      for (const c of x.children) console.log(`          ${c.linked ? '+' : ' '} ${c.p.toFixed(2)}  ${c.name}`);
    }
  });
}
console.log(`  extractor guard (all runs): ${guard.dropped} speech-act names dropped, ${guard.retried} statements asked again`);

if (rel.length) {
  // The pair review: what the judge said about every pair it was asked, strongest "aspect of" signal first. Outcomes with p in
  // [.5,.7) on one direction and low on the other are the near misses a lower WITHIN_MIN would turn into sub-themes.
  const rows = rel[0] ? [...rel[0].judged].sort((x, y) => Math.max(y.aInB, y.bInA, y.same) - Math.max(x.aInB, x.bInA, x.same)) : [];
  console.log(`\nPair review, run 0: ${rows.length} pairs asked (same / a within b / b within a, then outcome):`);
  for (const x of rows) console.log(`  ${x.same.toFixed(2)} ${x.aInB.toFixed(2)} ${x.bInA.toFixed(2)}  ${x.outcome.padEnd(8)} [${x.by[0]}, ${x.both} in common, ${x.aSize}/${x.bSize}]  ${x.a}  |  ${x.b}`);
}
const failed = results.flatMap((r, i) => r.placed.failed.map(f => `run ${i} ${f.id}: ${f.error}`).concat(r.rel?.failed ?? []));
if (failed.length) console.log(`\nFailures (${failed.length}):\n  ${failed.slice(0, 10).join('\n  ')}`);

const r0 = results[0];
console.log('\nThemes of run 0 (atomic):');
for (const t of [...r0.atomic].sort((a, b) => b.statements.length - a.statements.length)) console.log(`  ${String(t.statements.length).padStart(3)}  ${t.name}`);
if (r0.relations.length) {
  console.log('\nRelations of run 0:');
  for (const x of r0.relations.filter(x => x.kind === 'sub')) console.log(`  ${x.child}  ->  sub-theme of  ${x.parent}  (p ${x.p.toFixed(2)})`);
  const d = r0.relations.filter(x => x.kind === 'derived'), kids = [...new Set(d.map(x => x.child))];
  console.log(`  ${kids.length} derived themes, e.g.: ${kids.slice(0, 8).join('; ')}`);
}
if (r0.merges.length) { console.log('\nMerges of run 0:'); for (const m of r0.merges) console.log(`  "${m.absorbed}" into "${m.survivor}" (p ${m.p.toFixed(2)}, ${m.overlap} in common)`) }

await mkdir('eval/results', { recursive: true });
const file = `eval/results/topics-${TOPIC_VERSION}-${judgeName}${prior ? '-grouped' : ''}-${Date.now()}.json`;
await writeFile(file, JSON.stringify({ set, jev: `${TOPIC_VERSION}/${judgeName}`, linkMin, statements: statements.map(({ id, text }) => ({ id, text })), runs: results.map(r => ({ themes: r.atomic, withDerived: r.withDerived, order: r.order, relations: r.relations, merges: r.merges, edges: r.edges, stats: r.stats, relate: r.rel, parents: r.parents, group: r.grp, roots: r.roots })) }, null, 1));
console.log(`\nSaved ${file}`);
