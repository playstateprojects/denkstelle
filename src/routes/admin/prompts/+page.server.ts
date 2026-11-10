// Admin: pick a model, edit its versioned prompts, and try a draft on a sample (on one or several models).
import { fail } from '@sveltejs/kit';
import { connect } from '$lib/server/db';
import { requireDbAdmin } from '$lib/server/access';
import { llmEnv } from '$lib/server/llm-env';
import { MODELS, DEFAULT_MODEL, modelDef, modelConfigured } from '../../../../worker/src/models';
import {
  PROMPT_DEFS, promptDef, loadPrompts, listVersions, saveVersion, activateVersion, clearActive,
  tablesExist, getActiveModel, setActiveModel, type PromptKey
} from '../../../../worker/src/prompts';
import { analyze, AnalysisError } from '../../../../worker/src/analysis';
import type { Actions, PageServerLoad } from './$types';

const BODY_MAX = 20000, NOTES_MAX = 300, SAMPLE_MAX = 20000;

const modelFrom = (v: unknown) => modelDef(String(v ?? ''))?.id;
/** Why a body is not acceptable for its prompt, if it isn't. */
function problem(kind: string, body: string): string | undefined {
  if (!body.trim()) return 'the prompt is empty';
  if (body.length > BODY_MAX) return `the prompt is longer than ${BODY_MAX} characters`;
  if (kind === 'number') {
    const n = Number(body);
    if (!Number.isFinite(n) || n < 0 || n > 2) return 'this one must be a number from 0 to 2';
  }
  return undefined;
}

export const load: PageServerLoad = async ({ url, locals, platform }) => {
  requireDbAdmin(locals);
  const sql = connect(platform);
  try {
    const keys = llmEnv(platform);
    const model = modelFrom(url.searchParams.get('model')) ?? DEFAULT_MODEL;
    const def = promptDef(url.searchParams.get('key') ?? '') ?? PROMPT_DEFS[0];
    const [ready, activeModel, prompts, versions] = await Promise.all([
      tablesExist(sql), getActiveModel(sql), loadPrompts(sql, model), listVersions(sql, model, def.key)
    ]);
    return {
      ready, model, activeModel, def, key: def.key,
      live: prompts.text(def.key as PromptKey),
      liveVersion: prompts.versions[def.key] ?? 0,
      versions,
      models: MODELS.map((m) => ({ id: m.id, label: m.label, configured: modelConfigured(m, keys), keyEnv: m.keyEnv })),
      menu: PROMPT_DEFS.map((d) => ({ key: d.key, label: d.label, version: prompts.versions[d.key] ?? 0 }))
    };
  } finally { await sql.end({ timeout: 1 }); }
};

function readTarget(form: FormData) {
  return { model: modelFrom(form.get('model')), def: promptDef(String(form.get('key') ?? '')) };
}

export const actions: Actions = {
  save: async ({ request, locals, platform }) => {
    const user = requireDbAdmin(locals);
    const form = await request.formData();
    const { model, def } = readTarget(form);
    if (!model || !def) return fail(400, { error: 'unknown model or prompt' });
    const body = String(form.get('body') ?? '').replace(/\r\n/g, '\n').trim();
    const bad = problem(def.kind, body);
    if (bad) return fail(400, { error: bad });
    const notes = String(form.get('notes') ?? '').trim().slice(0, NOTES_MAX);
    const activate = form.get('activate') === 'on';
    const sql = connect(platform);
    try {
      if (!(await tablesExist(sql))) return fail(503, { error: 'run `npm run db:migrate` first: the prompts tables do not exist' });
      const version = await saveVersion(sql, { model, key: def.key, body, notes, activate, by: user.email });
      return { saved: version, activated: activate };
    } finally { await sql.end({ timeout: 1 }); }
  },

  activate: async ({ request, locals, platform }) => {
    requireDbAdmin(locals);
    const form = await request.formData();
    const { model, def } = readTarget(form);
    const version = Number(form.get('version'));
    if (!model || !def || !Number.isInteger(version)) return fail(400, { error: 'unknown version' });
    const sql = connect(platform);
    try {
      await activateVersion(sql, model, def.key, version);
      return { saved: version, activated: true };
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : 'could not activate' });
    } finally { await sql.end({ timeout: 1 }); }
  },

  // no version active: the built-in default runs
  reset: async ({ request, locals, platform }) => {
    requireDbAdmin(locals);
    const { model, def } = readTarget(await request.formData());
    if (!model || !def) return fail(400, { error: 'unknown model or prompt' });
    const sql = connect(platform);
    try { await clearActive(sql, model, def.key); return { reset: true }; }
    finally { await sql.end({ timeout: 1 }); }
  },

  // which model the processing pipeline uses from now on
  useModel: async ({ request, locals, platform }) => {
    requireDbAdmin(locals);
    const model = modelFrom((await request.formData()).get('pipelineModel'));
    if (!model) return fail(400, { error: 'unknown model' });
    const sql = connect(platform);
    try {
      if (!(await tablesExist(sql))) return fail(503, { error: 'run `npm run db:migrate` first: the settings table does not exist' });
      await setActiveModel(sql, model);
      return { pipelineModel: model };
    } finally { await sql.end({ timeout: 1 }); }
  },

  // runs the analysis on a sample transcript on each chosen model. The edited model uses the unsaved draft;
  // the others use their own live prompts, so this doubles as a side-by-side comparison.
  preview: async ({ request, locals, platform }) => {
    requireDbAdmin(locals);
    const form = await request.formData();
    const { model: edited, def } = readTarget(form);
    if (!edited || !def) return fail(400, { error: 'unknown model or prompt' });
    const body = String(form.get('body') ?? '').replace(/\r\n/g, '\n').trim();
    const bad = problem(def.kind, body);
    if (bad) return fail(400, { error: bad });
    const chosen = form.getAll('runOn').map(modelFrom).filter((m): m is string => !!m);
    const targets = [...new Set(chosen)];
    if (!targets.length) return fail(400, { error: 'choose at least one model to run on' });
    const sample = String(form.get('sample') ?? '').replace(/\r\n/g, '\n').slice(0, SAMPLE_MAX);
    const texts = sample.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!texts.length) return fail(400, { error: 'paste a sample transcript (one segment per line)' });
    const input = {
      title: String(form.get('sampleTitle') ?? '').trim().slice(0, 160) || 'Sample',
      question: String(form.get('sampleQuestion') ?? '').trim().slice(0, 500) || 'Sample question',
      speakerName: String(form.get('sampleSpeaker') ?? '').trim().slice(0, 100) || undefined,
      texts
    };
    const keys = llmEnv(platform);
    const sql = connect(platform);
    try {
      const results = await Promise.all(targets.map(async (id) => {
        const label = modelDef(id)!.label;
        const base = await loadPrompts(sql, id);
        const prompts = id === edited ? base.with(def.key as PromptKey, body) : base;
        const sources = Object.fromEntries(PROMPT_DEFS.map((d) => {
          const v = prompts.versions[d.key] ?? 0;
          return [d.label, v === -1 ? 'draft' : v ? `v${v}` : 'default'];
        }));
        try {
          const r = await analyze(keys, id, prompts, input);
          return { model: id, label, sources, ok: true as const, ms: r.ms, extracted: r.extracted, raw: r.raw };
        } catch (err) {
          const e = err instanceof AnalysisError || (err as { raw?: string })?.raw !== undefined ? (err as AnalysisError) : undefined;
          return { model: id, label, sources, ok: false as const, ms: e?.ms ?? 0, error: err instanceof Error ? err.message : 'failed', raw: e?.raw };
        }
      }));
      return { results };
    } finally { await sql.end({ timeout: 1 }); }
  }
};
