/** Cloudflare's Clef, a System One model on Workers AI, behind the same shape as askNouls in jev.ts: one request, every question over
 * the same state, P(yes) per question id. Output tokens are free. Prototype: used by `npm run eval:topics -- --judge clef`.
 * Needs R2_ACCOUNT_ID and WORKERS_AI_API_TOKEN (the pair utils.ts uses for embeddings). */
import type { Noul } from './jev.ts';

const TIMEOUT_MS = 60_000;

export async function askNoulsClef(env: { R2_ACCOUNT_ID?: string; WORKERS_AI_API_TOKEN?: string }, state: Record<string, unknown>, questions: Record<string, Noul>): Promise<{ answers: Record<string, number>; tokens: number }> {
  if (!env.R2_ACCOUNT_ID || !env.WORKERS_AI_API_TOKEN) throw new Error('R2_ACCOUNT_ID and WORKERS_AI_API_TOKEN are required for Clef');
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.R2_ACCOUNT_ID}/ai/run/@cf/cloudflare/clef`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.WORKERS_AI_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'clef', state, questions }), signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.success === false) throw new Error(`Clef ${res.status}: ${JSON.stringify(body?.errors ?? body).slice(0, 300)}`);
  const answers: Record<string, number> = {};
  for (const id of Object.keys(questions)) {
    const v = body?.result?.answers?.[id]?.noul;
    if (typeof v !== 'number' || !(v >= 0 && v <= 1)) throw new Error(`Clef returned no probability for "${id}"`);
    answers[id] = v;
  }
  return { answers, tokens: body?.result?.usage?.input_tokens ?? 0 };
}
