import { env } from '$env/dynamic/private';
import type { Env } from '../../../worker/src/models';

/** API keys for the model calls: Worker secrets/vars first, then local .env. Strings only (bindings are skipped). */
export function llmEnv(platform?: Readonly<App.Platform>): Env {
  const out: Env = { ...env };
  for (const [k, v] of Object.entries(platform?.env ?? {})) if (typeof v === 'string') out[k] = v;
  return out;
}
