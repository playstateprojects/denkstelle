/** Client for the device API (docs/DEVICE_API.md). No DOM or Svelte: a Raspberry Pi client implements the same
 * calls (GET /api/device/config, POST /api/device/recordings) in whatever language it likes. The browser simulator
 * differs only in how it authenticates (`headers`): a session-bound header instead of a Bearer credential.
 */
import {sha256Hex} from '../device-token';

export type DeviceConfig = {
  project: { id: string; slug: string; title: string; question: string };
  greeting: { url: string | null; text: string };
  beep: { frequencyHz: number; durationMs: number };
  recording: { maxDurationSeconds: number; maxBytes: number; acceptedMimeTypes: string[]; minDurationMs: number };
  consent: { required: string; header: string; policyVersion: string };
  device: { id: string; name: string; kind: string; config: Record<string, unknown> };
};
export type Receipt = { recordingId: string; sourceId: string; received: true; duplicate: boolean; processing: string };

/** `retryable` mirrors the server's hint; network failures (no response at all) are always retryable. */
export class DeviceClientError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean, readonly status = 0) { super(message); }
}

async function failure(res: Response): Promise<DeviceClientError> {
  const body = await res.json().catch(() => null) as { error?: string; message?: string; retryable?: boolean } | null;
  return new DeviceClientError(body?.message ?? `Server answered ${res.status}`, body?.error ?? 'http_error', body?.retryable ?? res.status >= 500, res.status);
}

export class DeviceClient {
  constructor(private opts: { baseUrl?: string; headers: Record<string, string>; fetch?: typeof fetch }) {}
  private url(p: string) { return (this.opts.baseUrl ?? '') + p; }
  private f(...a: Parameters<typeof fetch>) { return (this.opts.fetch ?? fetch)(...a); }

  async getConfig(): Promise<DeviceConfig> {
    const res = await this.f(this.url('/api/device/config'), { headers: this.opts.headers }).catch(() => { throw new DeviceClientError('Network error', 'network', true); });
    if (!res.ok) throw await failure(res);
    return res.json();
  }

  /** One attempt. Safe to repeat with the same `recordingId`: the server answers with the original receipt. */
  async upload(o: { recordingId: string; audio: Uint8Array; mime: string; consent: string[] }): Promise<Receipt> {
    const res = await this.f(this.url('/api/device/recordings'), {
      method: 'POST',
      headers: { ...this.opts.headers, 'Content-Type': o.mime, 'X-Recording-Id': o.recordingId, 'X-Content-SHA256': await sha256Hex(o.audio), 'X-Consent': o.consent.join(',') },
      body: o.audio as Uint8Array<ArrayBuffer>
    }).catch(() => { throw new DeviceClientError('Network error', 'network', true); });
    if (!res.ok) throw await failure(res);
    return res.json();
  }

  /** Retries retryable failures with backoff and gives up on permanent ones (bad audio, no consent, revoked device). */
  async uploadWithRetry(o: Parameters<DeviceClient['upload']>[0], attempts = 3, onAttempt?: (n: number) => void): Promise<Receipt> {
    for (let n = 1; ; n++) {
      onAttempt?.(n);
      try { return await this.upload(o); }
      catch (e) {
        if (!(e instanceof DeviceClientError) || !e.retryable || n >= attempts) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (n - 1)));
      }
    }
  }
}
