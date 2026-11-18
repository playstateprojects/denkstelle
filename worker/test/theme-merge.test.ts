/** Merging themes: the nomination rule, the decision, the merge itself and its failure handling. No database or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatePairs, decideMerge, buildMergeQuestion, mergeThemes, MERGE_MIN, MIN_CONTAINMENT, MIN_OVERLAP, type MergeJudge } from '../src/theme-merge.ts';
import type { Rewriter } from '../src/theme-match.ts';
import { MemoryStore } from '../src/theme-memory.ts';

const S = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, text: `Statement ${i}`, vec: [1, i * .01, 0] }));
const ids = (from: number, to: number) => S.slice(from, to).map(s => s.id);
/** Themes made by hand: name -> the statements in it. Returns the store and the ids by name. */
async function world(spec: Record<string, string[]>) {
  const store = new MemoryStore(S), id: Record<string, string> = {};
  for (const [name, members] of Object.entries(spec)) {
    id[name] = (await store.createTheme({ name, description: `About ${name}` })).id;
    for (const m of members) await store.link(m, [{ themeId: id[name], p: .9, method: 'jev' }]);
  }
  return { store, id };
}
const yes: MergeJudge = async () => .95;
const no: MergeJudge = async () => .2;

test('candidatePairs: nominates by the share of the smaller theme inside the larger, and the larger survives', () => {
  const o = [{ a: 'a', b: 'b', aSize: 10, bSize: 20, both: 8 }];
  assert.deepEqual(candidatePairs(o), [{ survivorId: 'b', absorbedId: 'a', overlap: 8, containment: .8 }]);
});

test('candidatePairs: below the containment or the overlap minimum is not nominated; the boundary is', () => {
  const at = Math.ceil(10 * MIN_CONTAINMENT);
  assert.equal(candidatePairs([{ a: 'a', b: 'b', aSize: 10, bSize: 30, both: at }]).length, 1);
  assert.equal(candidatePairs([{ a: 'a', b: 'b', aSize: 10, bSize: 30, both: at - 1 }]).length, 0);
  assert.equal(candidatePairs([{ a: 'a', b: 'b', aSize: 3, bSize: 3, both: MIN_OVERLAP - 1 }]).length, 0);
  assert.equal(candidatePairs([{ a: 'a', b: 'b', aSize: 3, bSize: 3, both: MIN_OVERLAP }]).length, 1);
});

test('candidatePairs: most overlapping first, and equal sizes pick the same survivor whichever way round', () => {
  const o = [{ a: 'a', b: 'b', aSize: 10, bSize: 10, both: 6 }, { a: 'c', b: 'd', aSize: 10, bSize: 10, both: 9 }];
  assert.deepEqual(candidatePairs(o).map(p => [p.survivorId, p.absorbedId]), [['c', 'd'], ['a', 'b']]);
  assert.equal(candidatePairs([{ a: 'z', b: 'y', aSize: 5, bSize: 5, both: 5 }])[0].survivorId, 'y');
});

test('decideMerge: the threshold itself is a yes', () => {
  assert.equal(decideMerge(MERGE_MIN), true);
  assert.equal(decideMerge(MERGE_MIN - .01), false);
});

test('buildMergeQuestion puts both topics, with their statements, in the state and asks one plain question', () => {
  const { state, questions } = buildMergeQuestion(
    { id: '1', name: 'Booking', description: 'Reserving kit', examples: ['Booking is clunky'] },
    { id: '2', name: 'Reservations', description: null, examples: ['Slots vanish'] });
  assert.deepEqual(state, {
    topic_a: { name: 'Booking', description: 'Reserving kit', statements_filed_under_it: ['Booking is clunky'] },
    topic_b: { name: 'Reservations', statements_filed_under_it: ['Slots vanish'] }
  });
  assert.deepEqual(Object.keys(questions), ['same_topic']);
  assert.equal(questions.same_topic.type, 'noul');
  assert.ok(!JSON.stringify(state).includes('"1"'), 'internal ids are not sent');
});

test('a nominated pair that Jev calls the same topic is merged into the larger theme', async () => {
  const { store, id } = await world({ Big: ids(0, 10), Small: ids(5, 12) });   // Small: 7 statements, 5 shared with Big
  const r = await mergeThemes({ store, judge: yes });
  assert.equal(r.merged.length, 1);
  assert.deepEqual([r.merged[0].survivor, r.merged[0].absorbed], ['Big', 'Small']);
  assert.ok(!store.themes.has(id.Small));
  assert.deepEqual([...store.members().get(id.Big)!].sort(), ids(0, 12).sort());
  assert.deepEqual(store.merges.map(m => [m.survivorId, m.absorbedId, m.overlap]), [[id.Big, id.Small, 5]]);
});

test('Jev is asked about both topics with their statements', async () => {
  const { store } = await world({ Big: ids(0, 10), Small: ids(5, 12) });
  let seen: Parameters<MergeJudge> | undefined;
  await mergeThemes({ store, judge: async (a, b) => { seen = [a, b]; return .95 } });
  assert.equal(seen![0].name, 'Big');
  assert.equal(seen![1].name, 'Small');
  assert.ok(seen![0].examples.length > 0 && seen![1].examples.length > 0);
});

test('a pair Jev does not call the same topic is kept, and asked once', async () => {
  const { store, id } = await world({ Big: ids(0, 10), Small: ids(5, 12) });
  let calls = 0;
  const r = await mergeThemes({ store, judge: async () => { calls++; return .5 } });
  assert.equal(r.merged.length, 0);
  assert.equal(r.kept.length, 1);
  assert.equal(calls, 1);
  assert.ok(store.themes.has(id.Small));
});

test('themes that barely overlap are never put to Jev', async () => {
  const { store } = await world({ A: ids(0, 10), B: ids(9, 20) });             // one shared statement
  let calls = 0;
  const r = await mergeThemes({ store, judge: async () => { calls++; return 1 } });
  assert.equal(calls, 0);
  assert.equal(r.merged.length + r.kept.length, 0);
});

test('after a merge the overlaps are read again, so a third theme can merge into the grown survivor', async () => {
  // C overlaps B (60%) and B overlaps A. Once B is in A, C sits inside A.
  const { store, id } = await world({ A: ids(0, 12), B: ids(6, 14), C: ids(10, 15) });
  const r = await mergeThemes({ store, judge: yes });
  assert.equal(r.merged.length, 2);
  assert.deepEqual([...store.themes.keys()], [id.A]);
  assert.equal(store.members().get(id.A)!.length, 15);
});

test('a statement in both themes keeps one membership, with the higher probability', async () => {
  const { store, id } = await world({ Big: ids(0, 10), Small: ids(5, 12) });
  await store.link('s6', [{ themeId: id.Big, p: .62, method: 'jev' }]);
  await mergeThemes({ store, judge: yes });
  assert.equal(store.links.get('s6')!.get(id.Big)!.p, .9);                      // Small's .9 beat Big's .62
  assert.equal(store.members().get(id.Big)!.filter(x => x === 's6').length, 1);
});

test('the survivor is rewritten from all of its statements after a merge', async () => {
  const { store, id } = await world({ Big: ids(0, 10), Small: ids(5, 12) });
  let size = 0;
  const rewrite: Rewriter = async i => { size = i.size; return { name: 'Booking and reserving', description: 'Both' } };
  const r = await mergeThemes({ store, judge: yes, rewrite });
  assert.equal(size, 12);
  assert.equal(store.themes.get(id.Big)!.name, 'Booking and reserving');
  assert.equal(r.merged[0].renamedTo, 'Booking and reserving');
});

test('a failing rewrite never undoes the merge', async () => {
  const { store, id } = await world({ Big: ids(0, 10), Small: ids(5, 12) });
  const log = console.error; console.error = () => { };
  try {
    const r = await mergeThemes({ store, judge: yes, rewrite: async () => { throw new Error('model down') } });
    assert.equal(r.merged.length, 1);
    assert.ok(!store.themes.has(id.Small));
    assert.equal(store.themes.get(id.Big)!.name, 'Big');
  } finally { console.error = log }
});

test('a Jev failure skips that pair and is reported, never read as a "no" or a "yes"', async () => {
  const { store, id } = await world({ A: ids(0, 10), B: ids(5, 12), C: ids(20, 28), D: ids(23, 30) });
  let n = 0;
  const judge: MergeJudge = async () => { if (n++ === 0) throw new Error('Jev 500'); return .95 };
  const r = await mergeThemes({ store, judge });
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /Jev 500/);
  assert.equal(r.kept.length, 0);
  assert.equal(r.merged.length, 1);
  assert.ok(store.themes.has(id.A) && store.themes.has(id.B) || store.themes.has(id.C) && store.themes.has(id.D));
});

test('three failures in a row stop the run', async () => {
  const { store } = await world({ A: ids(0, 10), B: ids(5, 12), C: ids(12, 22), D: ids(15, 25), E: ids(20, 30), F: ids(22, 30) });
  const r = await mergeThemes({ store, judge: async () => { throw new Error('down') } });
  assert.equal(r.aborted, true);
  assert.equal(r.failed.length, 3);
});

test('an out-of-range answer from the judge is an error, not a decision', async () => {
  const { store } = await world({ Big: ids(0, 10), Small: ids(5, 12) });
  const r = await mergeThemes({ store, judge: (async () => 1.4) as MergeJudge });
  assert.equal(r.merged.length, 0);
  assert.equal(r.failed.length, 1);
});

test('merging into nothing, or a theme that does not exist, throws', async () => {
  const { store, id } = await world({ A: ids(0, 3) });
  await assert.rejects(store.merge(id.A, 'nope', { probability: 1, overlap: 0, by: 't' }));
});

test('no judge is called when no themes exist', async () => {
  const r = await mergeThemes({ store: new MemoryStore(S), judge: no });
  assert.deepEqual([r.merged.length, r.kept.length, r.failed.length], [0, 0, 0]);
});
