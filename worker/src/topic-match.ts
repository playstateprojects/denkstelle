/** Themes, topic first. Replaces the per-statement "which existing theme is this?" question of theme-match.ts as the default way
 * statements get their themes (`assignTopics`; the old path stays available as `assignThemes`, `npm run themes:assign -- --classic`).
 *
 * Each statement first gets 1 to 3 ATOMIC topics from a chat model ("the laser cutter lab is too expensive" -> "laser cutter lab",
 * "price"; prompt `topic_extract_system`). Each topic is then matched to the project's themes:
 *
 *   1. exact canonical name                    -> candidate
 *   2. nearest themes by label embedding       -> candidates
 *   3. Jev scores the statement against EVERY candidate, one request per statement. That probability is the edge weight
 *      (statement_themes.probability), so an exact name match is only a candidate: a sloppy reuse of a name does not get weight 1.
 *   4. a candidate at or above LINK_MIN gets the edge (up to MAX_LINKS_PER_TOPIC); if none does, the topic becomes a new theme.
 *
 * The chat model generates (what is this about?), Jev judges (how sure are we?), code decides. The extractor is shown the themes of
 * the statement's nearest statements, so it reuses their wording. Names and descriptions are English whatever the statement's language.
 *
 * Eval (92 statements, 3 orders, eval/results/topics-*.json): against the per-statement method, the largest theme holds 11 to 13% of
 * statements instead of 16 to 50%, and runs agree on which statements share a theme at F1 0.50 instead of 0.32 to 0.40. The number of
 * themes is not lower (34 to 43). A hierarchy on top (topic-hierarchy.ts) is experimental and not used here.
 *
 * Not done here, on purpose: rewriting a theme's wording as it grows (theme-match.ts does that), merging (it found nothing in the eval),
 * and the `pending` state (every statement is placed or fails and is retried on the next run).
 * Bump TOPIC_VERSION when the question wording, the prompt or the thresholds change.
 */
import { z } from 'zod';
import type { Sql } from 'postgres';
import { modelDef, llmComplete, parseJson, LlmError, type Env } from './models.ts';
import { askNouls, type Noul } from './jev.ts';
import { embeddings, vector } from './utils.ts';
import { canonical } from './themes.ts';
import { buildQuestions, type Candidate } from './theme-match.ts';
import type { Prompts } from './prompts.ts';

export const TOPIC_VERSION = 'topic-1';
export const MAX_TOPICS = 3;
/** A candidate theme at or above this probability gets the edge. 0.5 is "more likely than not": the theme-2 eval found most
 * statements at 0.5 to 0.6 against an existing theme were right matches, and a miss costs a near-duplicate theme. */
export const LINK_MIN = .5;
export const MAX_LINKS_PER_TOPIC = 2;
/** Themes of the nearest statements shown to the extractor, so it reuses wording. */
export const HINT_THEMES = 8;
export const NEAREST_STATEMENTS = 12;
/** Themes by label embedding put to the judge per topic, besides an exact match. */
export const EMBED_CANDIDATES = 3;
export const EXAMPLES_PER_THEME = 3;
export const EXAMPLE_CHARS = 200;
const MAX_CONSECUTIVE_FAILURES = 3;

export type Topic = { name: string; description: string };
export type Extractor = (i: { statement: string; existing: string[] }) => Promise<Topic[]>;
export type Embedder = (texts: string[]) => Promise<number[][]>;
/** One request, every question over the same state: the shape of askNouls (jev.ts) and askNoulsClef (clef.ts). */
export type Ask = (state: Record<string, unknown>, questions: Record<string, Noul>) => Promise<{ answers: Record<string, number>; tokens: number }>;

/** The prompt asks for subjects, not speech acts. This is the check in code: a name made only of speech-act words ("next steps",
 * "concrete improvement ideas", "level of criticism") is dropped, and when nothing is left the model is asked once more. */
export const ACT = new Set(['improvement', 'improvements', 'idea', 'ideas', 'criticism', 'critique', 'feedback', 'suggestion', 'suggestions', 'opinion', 'opinions', 'concern', 'concerns', 'comment', 'comments', 'step', 'steps', 'wish', 'wishes', 'request', 'requests', 'level', 'remark', 'remarks']);
export const FILLER = new Set(['of', 'for', 'the', 'and', 'a', 'on', 'about', 'concrete', 'practical', 'next', 'further', 'specific', 'general', 'overall', 'future', 'possible', 'various', 'new', 'more']);
export const speechAct = (name: string) => { const w = name.toLowerCase().split(/[^a-zà-ÿ]+/).filter(x => x && !FILLER.has(x)); return w.length > 0 && w.every(x => ACT.has(x)) };
/** How often the guard fired in this process (the eval prints it). */
export const guard = { dropped: 0, retried: 0 };

export const label = (t: { name: string; description?: string | null }) => t.description ? `${t.name}: ${t.description}` : t.name;

export class ExtractError extends LlmError { }
const Extracted = z.object({ topics: z.array(z.object({ name: z.string().min(2), description: z.string().default('') })).min(1) });

export const extractingUser = (i: { statement: string; existing: string[] }) =>
  `STATEMENT: ${i.statement}\n\nEXISTING THEMES:\n${i.existing.length ? i.existing.map(n => `- ${n}`).join('\n') : '(none yet)'}\n\nReturn JSON.`;

/** The live extractor: the model proposes, code trims (at most MAX_TOPICS, no empty, repeated or speech-act names). An unusable
 * answer is an error, not a theme. `system` is the prompt `topic_extract_system`. */
export const modelExtractor = (env: Env, modelId: string, system: string, temperature = 0): Extractor => async i => {
  const def = modelDef(modelId); if (!def) throw new ExtractError(`Unknown model "${modelId}"`);
  const once = async (extra = ''): Promise<{ kept: Topic[]; dropped: string[] }> => {
    const out = await llmComplete(def, env, { system, user: extractingUser(i) + extra, temperature });
    let json: unknown;
    try { json = parseJson(out.raw) } catch { throw new ExtractError(`${def.label} did not return valid JSON`, out.raw, out.ms) }
    const parsed = Extracted.safeParse(json);
    if (!parsed.success) throw new ExtractError(`${def.label} topics JSON does not match the expected shape`, out.raw, out.ms);
    const seen = new Set<string>(), kept: Topic[] = [], dropped: string[] = [];
    for (const t of parsed.data.topics) {
      const name = t.name.trim().slice(0, 60), key = canonical(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (speechAct(name)) { dropped.push(name); continue }
      kept.push({ name, description: t.description.trim().slice(0, 300) });
    }
    return { kept: kept.slice(0, MAX_TOPICS), dropped };
  };
  let r = await once(); guard.dropped += r.dropped.length;
  if (!r.kept.length) {
    guard.retried++;
    r = await once(`\n\nYour previous answer (${r.dropped.map(n => `"${n}"`).join(', ') || 'nothing usable'}) named the kind of statement, not what it is about. Name the thing the statement concerns.`);
    guard.dropped += r.dropped.length;
  }
  if (!r.kept.length) throw new ExtractError(`${def.label} returned no usable topic`);
  return r.kept;
};

export type Method = 'exact' | 'embed' | 'seed' | 'name_match';
export type Edge = { p: number | null; method: Method };
export type ThemeRef = { id: string; name: string; description: string };
type Maybe<T> = T | Promise<T>;

/** Where themes and edges live: Postgres in the pipeline (pgTopicStore), memory in the tests and the eval (topic-memory.ts). */
export interface PlaceStore {
  /** Themes of the statement's nearest already-themed statements, nearest first. Only the extractor's vocabulary hint. */
  nearbyThemes(statementId: string, limit: number): Maybe<ThemeRef[]>;
  byCanonical(name: string): Maybe<ThemeRef | undefined>;
  /** The themes whose label embedding is nearest to `vec`. */
  nearestByLabel(vec: number[], limit: number): Maybe<ThemeRef[]>;
  /** Statements already in the theme, nearest to the statement first, for the judge to read. */
  examples(themeId: string, statementId: string): Maybe<string[]>;
  /** A theme with this name, created unless one with the same canonical name exists. `vec` is the embedding of the label. */
  create(name: string, description: string, vec: number[]): Maybe<ThemeRef>;
  /** Every judgement made for the statement, yes and no, so thresholds can be changed and re-scored without new calls. */
  judged?(statementId: string, js: { themeId: string; p: number }[], by: string): Maybe<void>;
  /** All of the statement's edges at once; marks the statement placed. */
  link(statementId: string, links: { themeId: string; edge: Edge }[], by?: string): Maybe<void>;
}

export type Stats = { extractCalls: number; judgeCalls: number; judgeTokens: number; embedCalls: number; reuseExact: number; reuseExactBelow: number; created: number; embedLinks: number; topicsPerStatement: number[] };
export const newStats = (): Stats => ({ extractCalls: 0, judgeCalls: 0, judgeTokens: 0, embedCalls: 0, reuseExact: 0, reuseExactBelow: 0, created: 0, embedLinks: 0, topicsPerStatement: [] });
export type PlaceDeps = { store: PlaceStore; extract: Extractor; embed: Embedder; ask: Ask; stats: Stats; linkMin?: number; hint?: boolean };
export type Placed = { topics: Topic[]; links: { theme: string; p: number | null; method: Method }[]; created: string[] };

async function judge(d: PlaceDeps, statement: string, candidates: Candidate[]): Promise<number[]> {
  if (!candidates.length) return [];
  const { state, questions } = buildQuestions(statement, candidates);
  const { answers, tokens } = await d.ask(state, questions);
  d.stats.judgeCalls++; d.stats.judgeTokens += tokens;
  const ps = candidates.map((_, i) => answers[`theme_${i}`]);
  if (ps.some(p => typeof p !== 'number' || !(p >= 0 && p <= 1))) throw new Error(`Expected ${candidates.length} probabilities between 0 and 1, got ${JSON.stringify(ps)}`);
  return ps;
}

/** Places one statement. Anything that fails throws before the statement gets an edge, so it is simply retried later. */
export async function placeStatement(d: PlaceDeps, st: { id: string; text: string }): Promise<Placed> {
  const linkMin = d.linkMin ?? LINK_MIN, store = d.store;
  const existing = d.hint === false ? [] : (await store.nearbyThemes(st.id, HINT_THEMES)).map(t => t.name);
  const topics = await d.extract({ statement: st.text, existing }); d.stats.extractCalls++; d.stats.topicsPerStatement.push(topics.length);
  const vecs = await d.embed(topics.map(label)); d.stats.embedCalls++;
  const refs = new Map<string, ThemeRef>();
  const per: { topic: Topic; vec: number[]; exact?: ThemeRef; ids: string[] }[] = [];
  for (let i = 0; i < topics.length; i++) {
    const exact = await store.byCanonical(topics[i].name), cands = new Map<string, ThemeRef>();
    if (exact) cands.set(exact.id, exact);
    for (const n of await store.nearestByLabel(vecs[i], EMBED_CANDIDATES)) cands.set(n.id, n);
    for (const [id, t] of cands) refs.set(id, t);
    per.push({ topic: topics[i], vec: vecs[i], exact, ids: [...cands.keys()] });
  }
  const all = [...refs.keys()];
  const ps = await judge(d, st.text, await Promise.all(all.map(async id => ({ id, name: refs.get(id)!.name, description: refs.get(id)!.description || null, examples: await store.examples(id, st.id) }))));
  const p = new Map(all.map((id, i) => [id, ps[i]]));
  if (store.judged && all.length) await store.judged(st.id, all.map((id, i) => ({ themeId: id, p: ps[i] })), TOPIC_VERSION);
  const edges = new Map<string, Edge>(), created: string[] = [], names = new Map([...refs].map(([id, t]) => [id, t.name]));
  const add = (id: string, e: Edge) => { const have = edges.get(id); if (!have || (e.p ?? -1) > (have.p ?? -1)) edges.set(id, e) };
  for (const x of per) {
    const ranked = x.ids.map(id => ({ id, p: p.get(id)! })).sort((a, b) => b.p - a.p);
    const yes = ranked.filter(r => r.p >= linkMin).slice(0, MAX_LINKS_PER_TOPIC);
    for (const r of yes) { add(r.id, { p: r.p, method: r.id === x.exact?.id ? 'exact' : 'embed' }); if (r.id !== x.exact?.id) d.stats.embedLinks++ }
    if (x.exact) { d.stats.reuseExact++; if (!(p.get(x.exact.id)! >= linkMin)) d.stats.reuseExactBelow++ }
    if (yes.length) continue;
    // The extractor named an existing theme exactly but the judge says no: the extractor's word is evidence, so the edge is kept with the judge's weight.
    if (x.exact) { add(x.exact.id, { p: p.get(x.exact.id)!, method: 'name_match' }); continue }
    const t = await store.create(x.topic.name, x.topic.description, x.vec); d.stats.created++; created.push(t.name); names.set(t.id, t.name);
    add(t.id, { p: null, method: 'seed' });
  }
  await store.link(st.id, [...edges].map(([themeId, edge]) => ({ themeId, edge })), TOPIC_VERSION);
  return { topics, created, links: [...edges].map(([id, e]) => ({ theme: names.get(id) ?? id, p: e.p, method: e.method })) };
}

/** Arrival order, one at a time. One statement failing is skipped (and returned), three in a row stop the run: the service is probably down. */
export async function placeAll(d: PlaceDeps, sts: { id: string; text: string }[], onPlaced?: (st: { id: string; text: string }, p: Placed, n: number) => void) {
  const failed: { id: string; error: string }[] = []; let streak = 0, n = 0;
  for (const st of sts) {
    try { const placed = await placeStatement(d, st); streak = 0; n++; onPlaced?.(st, placed, n) }
    catch (e) { failed.push({ id: st.id, error: e instanceof Error ? e.message : String(e) }); if (++streak >= MAX_CONSECUTIVE_FAILURES) break }
  }
  return { failed, aborted: streak >= MAX_CONSECUTIVE_FAILURES, placed: n };
}

/** Postgres store for one project. Relies on the caller holding the project's theme lock (see assignTopics). */
export function pgTopicStore(sql: Sql, projectId: string): PlaceStore {
  const ref = (r: { id: string; name: string; description: string | null }): ThemeRef => ({ id: r.id, name: r.name, description: r.description ?? '' });
  return {
    async nearbyThemes(statementId, limit) {
      const rows = await sql<{ id: string; name: string; description: string | null }[]>`
    select t.id,t.name,t.description from (
     select x.theme_id,min(n.dist) as dist from (
      select s.id,(s.embedding <=> me.embedding)::float8 as dist
      from statements s,(select embedding from statements where id=${statementId}) me
      where s.project_id=${projectId} and s.id<>${statementId} and s.embedding is not null and me.embedding is not null
       and exists (select 1 from statement_themes q where q.statement_id=s.id)
      order by s.embedding <=> me.embedding limit ${NEAREST_STATEMENTS}
     ) n join statement_themes x on x.statement_id=n.id group by x.theme_id
    ) n join themes t on t.id=n.theme_id order by n.dist limit ${limit}`;
      return rows.map(ref);
    },
    async byCanonical(name) {
      const [r] = await sql<{ id: string; name: string; description: string | null }[]>`select id,name,description from themes where project_id=${projectId} and canonical=${canonical(name)}`;
      return r ? ref(r) : undefined;
    },
    async nearestByLabel(vec, limit) {
      const rows = await sql<{ id: string; name: string; description: string | null }[]>`
    select id,name,description from themes where project_id=${projectId} and embedding is not null order by embedding <=> ${vector(vec)}::vector limit ${limit}`;
      return rows.map(ref);
    },
    async examples(themeId, statementId) {
      const rows = await sql<{ text: string }[]>`
    select s.text from statement_themes x join statements s on s.id=x.statement_id
    cross join (select embedding from statements where id=${statementId}) me
    where x.theme_id=${themeId} and s.id<>${statementId} order by s.embedding <=> me.embedding limit ${EXAMPLES_PER_THEME}`;
      return rows.map(r => r.text.slice(0, EXAMPLE_CHARS));
    },
    async create(name, description, vec) {
      const [row] = await sql<{ id: string; name: string; description: string | null }[]>`
    insert into themes(project_id,canonical,name,description,embedding,named_size) values(${projectId},${canonical(name)},${name},${description || null},${vector(vec)}::vector,1)
    on conflict(project_id,canonical) do update set canonical=themes.canonical returning id,name,description`;
      return ref(row);
    },
    async judged(statementId, js, by) {
      for (const j of js) await sql`insert into theme_judgements(statement_id,theme_id,probability,judged_by) values(${statementId},${j.themeId},${j.p},${by})
    on conflict(statement_id,theme_id) do update set probability=excluded.probability,judged_by=excluded.judged_by,judged_at=now()`;
    },
    async link(statementId, links, by) {
      await sql.begin(async tx => {
        for (const l of links) await tx`insert into statement_themes(statement_id,theme_id,probability,method,judged_by) values(${statementId},${l.themeId},${l.edge.p},${l.edge.method},${by ?? TOPIC_VERSION})
     on conflict(statement_id,theme_id) do update set probability=excluded.probability,method=excluded.method,judged_by=excluded.judged_by`;
        await tx`update statements set theme_status='assigned' where id=${statementId}`;
      });
    }
  };
}

export type TopicAssignResult = { considered: number; placed: number;/** themes started by a topic nothing matched */created: number; failed: { statement: string; error: string }[]; aborted: boolean };

/** Places every statement of the project's ready sources that has no theme yet (or was left pending by the old method), in the order
 * they arrived. One run per project at a time (advisory lock, shared with the classic path and the legacy rebuild): a second caller
 * waits, then sees the first one's work. `opts` replaces the live extractor, embedder or judge in tests. */
export async function assignTopics(sql: Sql, env: Env, modelId: string, prompts: Prompts, projectId: string,
  opts: { extract?: Extractor; embed?: Embedder; ask?: Ask; linkMin?: number; onPlaced?: (st: { id: string; text: string }, p: Placed, n: number) => void } = {}): Promise<TopicAssignResult> {
  const [project] = await sql<{ id: string }[]>`select id from projects where id=${projectId}`;
  if (!project) throw new Error(`No project ${projectId}`);
  const d: PlaceDeps = {
    store: pgTopicStore(sql, projectId), stats: newStats(), linkMin: opts.linkMin,
    extract: opts.extract ?? modelExtractor(env, modelId, prompts.text('topic_extract_system')),
    embed: opts.embed ?? embeddings,
    ask: opts.ask ?? ((state, questions) => askNouls(env, state, questions))
  };
  const result: TopicAssignResult = { considered: 0, placed: 0, created: 0, failed: [], aborted: false };
  const key = `themes:${projectId}`;
  const conn = await sql.reserve();
  try {
    await conn`select pg_advisory_lock(hashtext(${key}))`;
    // A document still being read ('processing') is left out until it is ready, as in the classic pass.
    const todo = await sql<{ id: string; text: string }[]>`
   select st.id,st.text from statements st join sources s on s.id=st.source_id
   where st.project_id=${projectId} and s.status='ready' and (st.theme_status is null or st.theme_status='pending')
   order by s.created_at,st.created_at,st.id`;
    const run = await placeAll(d, todo, opts.onPlaced);
    result.considered = todo.length; result.placed = run.placed; result.created = d.stats.created; result.aborted = run.aborted;
    result.failed = run.failed.map(f => ({ statement: f.id, error: f.error }));
    // Themes whose statements were deleted (a re-run or removed source) have nothing left to stand on.
    await sql`delete from themes t where t.project_id=${projectId} and not exists (select 1 from statement_themes x where x.theme_id=t.id)`;
  } finally {
    await conn`select pg_advisory_unlock(hashtext(${key}))`.catch(() => { });
    conn.release();
  }
  return result;
}
