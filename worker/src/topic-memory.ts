/** PlaceStore in memory, plus the tree operations the hierarchy experiment needs (merge, sub-theme edges, derived themes, roots).
 * Used by the tests and `npm run eval:topics`; the pipeline uses pgTopicStore in topic-match.ts. */
import { canonical } from './themes.ts';
import { NEAREST_STATEMENTS, EXAMPLES_PER_THEME, EXAMPLE_CHARS, type Edge, type PlaceStore } from './topic-match.ts';

export const cos = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i] } return d / (Math.sqrt(x * y) || 1) };

export type Theme = { id: string; name: string; description: string; canon: string; vec: number[]; kind: 'atomic' | 'derived' | 'parent' };
export type Relation = { parent: string; child: string; p: number; judged: { same: number; childInParent: number; parentInChild: number } | null; kind: 'derived' | 'sub' };
export type Statement = { id: string; text: string; vec: number[] };

export class TopicStore implements PlaceStore {
  readonly themes = new Map<string, Theme>();
  /** statement id -> theme id -> edge */
  readonly links = new Map<string, Map<string, Edge>>();
  readonly relations: Relation[] = [];
  readonly merges: { survivor: string; absorbed: string; p: number; overlap: number }[] = [];
  private readonly byId: Map<string, Statement>;
  private seq = 0;
  constructor(readonly statements: Statement[]) { this.byId = new Map(statements.map(s => [s.id, s])) }

  atomic() { return [...this.themes.values()].filter(t => t.kind === 'atomic') }
  byCanonical(name: string) { const c = canonical(name); return [...this.themes.values()].find(t => t.kind !== 'derived' && t.canon === c) }
  create(name: string, description: string, vec: number[], kind: Theme['kind'] = 'atomic'): Theme {
    const t: Theme = { id: `t${++this.seq}`, name, description, canon: canonical(name), vec, kind }; this.themes.set(t.id, t); return t;
  }
  link(statementId: string, links: { themeId: string; edge: Edge }[]) {
    const m = this.links.get(statementId) ?? new Map<string, Edge>(); this.links.set(statementId, m);
    for (const { themeId, edge } of links) { const have = m.get(themeId); if (!have || (edge.p ?? -1) > (have.p ?? -1)) m.set(themeId, edge) }
  }
  /** theme id -> statement ids, atomic themes only unless `all` */
  members(all = false) {
    const out = new Map<string, string[]>();
    for (const [sid, m] of this.links) for (const tid of m.keys()) if (all || this.themes.get(tid)?.kind === 'atomic') (out.get(tid) ?? out.set(tid, []).get(tid)!).push(sid);
    return out;
  }
  /** Themes of the statement's nearest already-themed statements, nearest first. Used as the extractor's hint and as nothing else. */
  nearbyThemes(statementId: string, limit: number): Theme[] {
    const me = this.byId.get(statementId)!, best = new Map<string, number>();
    const near = this.statements.filter(s => s.id !== statementId && this.links.get(s.id)?.size).map(s => ({ s, sim: cos(me.vec, s.vec) })).sort((a, b) => b.sim - a.sim).slice(0, NEAREST_STATEMENTS);
    for (const n of near) for (const t of this.links.get(n.s.id)!.keys()) if (this.themes.get(t)?.kind === 'atomic' && !best.has(t)) best.set(t, n.sim);
    return [...best].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => this.themes.get(id)!);
  }
  nearestByLabel(vec: number[], limit: number): Theme[] {
    return this.atomic().map(t => ({ t, sim: cos(vec, t.vec) })).sort((a, b) => b.sim - a.sim).slice(0, limit).map(x => x.t);
  }
  examples(themeId: string, statementId: string, limit = EXAMPLES_PER_THEME): string[] {
    const me = this.byId.get(statementId)!;
    return this.statements.filter(s => s.id !== statementId && this.links.get(s.id)?.has(themeId)).sort((a, b) => cos(me.vec, b.vec) - cos(me.vec, a.vec)).slice(0, limit).map(s => s.text.slice(0, EXAMPLE_CHARS));
  }
  /** Themes that are a sub-theme of something. Derived themes do not count: they are intersections, not children in the topic tree. */
  childIds() { return new Set(this.relations.filter(r => r.kind === 'sub').map(r => r.child)) }
  private subtree(id: string, own: Map<string, string[]>, out = new Set<string>()): Set<string> {
    for (const x of own.get(id) ?? []) out.add(x);
    for (const r of this.relations) if (r.parent === id && r.kind === 'sub') this.subtree(r.child, own, out);
    return out;
  }
  /** The top level of the tree: every atomic or parent theme that is not a sub-theme, with the statements of its whole subtree. */
  roots(): { id: string; name: string; statements: string[]; children: number }[] {
    const own = this.members(), kids = this.childIds();
    return [...this.themes.values()].filter(t => t.kind !== 'derived' && !kids.has(t.id))
      .map(t => ({ id: t.id, name: t.name, statements: [...this.subtree(t.id, own)], children: this.relations.filter(r => r.parent === t.id && r.kind === 'sub').length }))
      .filter(t => t.statements.length);
  }
  /** Folds `absorbed` into `survivor`: its statements join the survivor (the higher weight kept) and the theme is gone. */
  merge(survivor: string, absorbed: string, p: number, overlap: number) {
    for (const m of this.links.values()) {
      const l = m.get(absorbed); if (!l) continue;
      const have = m.get(survivor); if (!have || (l.p ?? -1) > (have.p ?? -1)) m.set(survivor, l);
      m.delete(absorbed);
    }
    this.merges.push({ survivor: this.themes.get(survivor)!.name, absorbed: this.themes.get(absorbed)!.name, p, overlap });
    this.themes.delete(absorbed);
  }
}

