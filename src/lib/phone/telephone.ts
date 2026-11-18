/** The telephone workflow as a state machine, independent of any UI:
 *   handset lifted -> greeting -> beep -> recording -> handset replaced -> upload (retry until the server confirms).
 * A Raspberry Pi runs the same steps with GPIO instead of buttons, `aplay`/`arecord` instead of Web Audio, and
 * `DeviceClient`'s two requests in whatever language it likes. This file touches the browser (audio, mic) but not Svelte.
 */
import {DeviceClient,DeviceClientError,type DeviceConfig,type Receipt} from './device-client';
import {WavRecorder} from './recorder';

export type PhoneState = 'idle' | 'greeting' | 'recording' | 'uploading' | 'sent' | 'failed' | 'discarded';
export type PhoneSnapshot = {
  state: PhoneState;
  elapsedMs: number; level: number;
  /** Set when state is 'failed': what went wrong, and whether trying the upload again can help. */
  error: { message: string; code: string; retryable: boolean } | null;
  attempt: number; receipt: Receipt | null; autoStopped: boolean;
};

export class Telephone {
  private snap: PhoneSnapshot = { state: 'idle', elapsedMs: 0, level: 0, error: null, attempt: 0, receipt: null, autoStopped: false };
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private recorder: WavRecorder | null = null;
  private greetingAudio: HTMLAudioElement | null = null;
  private tick: ReturnType<typeof setInterval> | undefined;
  /** Bumped whenever a call ends so stale async steps (a greeting that finishes after hang-up) do nothing. */
  private call = 0;
  /** The finished recording waiting for the server's confirmation. Kept so a failed upload can be retried safely. */
  private pending: { recordingId: string; audio: Uint8Array } | null = null;

  constructor(private client: DeviceClient, private config: DeviceConfig, private onChange: (s: PhoneSnapshot) => void, private opts: { lang?: string } = {}) {}

  private set(p: Partial<PhoneSnapshot>) { this.snap = { ...this.snap, ...p }; this.onChange(this.snap); }
  get hasPendingUpload() { return this.pending !== null; }

  /** Handset lifted. Must be called from a user gesture (audio and microphone permission need one). */
  async pickUp() {
    if (this.pending || ['greeting', 'recording', 'uploading'].includes(this.snap.state)) return;
    const call = ++this.call;
    this.set({ state: 'greeting', elapsedMs: 0, level: 0, error: null, attempt: 0, receipt: null, autoStopped: false });
    try {
      // The microphone permission prompt appears now, as the handset is lifted.
      this.ctx = new AudioContext();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (call !== this.call) return this.release();
      await this.playGreeting(call);
      if (call !== this.call) return;
      await this.beep();
      if (call !== this.call) return;
      this.recorder = new WavRecorder(this.ctx, this.stream);
      await this.recorder.start();
      if (call !== this.call) return this.release();
      const t0 = performance.now(), max = this.config.recording.maxDurationSeconds * 1000;
      this.set({ state: 'recording' });
      this.tick = setInterval(() => {
        const ms = performance.now() - t0;
        this.set({ elapsedMs: Math.min(ms, max), level: this.recorder?.level() ?? 0 });
        if (ms >= max) void this.hangUp(true);
      }, 100);
    } catch (e) {
      if (call !== this.call) return;
      this.call++; this.release();
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      const missing = e instanceof DOMException && e.name === 'NotFoundError';
      this.set({ state: 'failed', error: { message: denied ? 'mic-denied' : missing ? 'mic-missing' : 'audio-failed', code: denied ? 'mic_denied' : 'audio_failed', retryable: false } });
    }
  }

  /** Handset replaced: stop whatever is happening and, if there is a recording, upload it. */
  async hangUp(autoStopped = false) {
    const state = this.snap.state;
    if (state === 'greeting') { this.call++; this.release(); this.set({ state: 'idle', level: 0 }); return; }
    if (state !== 'recording' || !this.recorder) return;
    this.call++;
    clearInterval(this.tick);
    const { wav, durationMs } = this.recorder.stop();
    this.release();
    if (durationMs < this.config.recording.minDurationMs) { this.set({ state: 'discarded', level: 0, elapsedMs: durationMs }); return; }
    this.pending = { recordingId: crypto.randomUUID(), audio: wav };
    this.set({ elapsedMs: durationMs, level: 0, autoStopped });
    await this.upload();
  }

  /** Upload (or re-upload) the finished recording. The same recording ID is reused, so the server stores it once. */
  async upload() {
    const p = this.pending; if (!p) return;
    this.set({ state: 'uploading', error: null, attempt: 1 });
    try {
      const receipt = await this.client.uploadWithRetry({ recordingId: p.recordingId, audio: p.audio, mime: 'audio/wav', consent: [this.config.consent.required] }, 3, (attempt) => this.set({ attempt }));
      this.pending = null;
      this.set({ state: 'sent', receipt, error: null });
    } catch (e) {
      const err = e instanceof DeviceClientError ? e : new DeviceClientError(String(e), 'unknown', true);
      // A permanent rejection (bad audio, consent, revoked) will not improve by retrying: drop the recording.
      if (!err.retryable) this.pending = null;
      this.set({ state: 'failed', error: { message: err.message, code: err.code, retryable: err.retryable } });
    }
  }

  discard() { this.pending = null; this.set({ state: 'idle', error: null, elapsedMs: 0 }); }

  /** Page is going away: free the microphone. */
  destroy() { this.call++; clearInterval(this.tick); this.release(); }

  private release() {
    clearInterval(this.tick);
    this.greetingAudio?.pause(); this.greetingAudio = null;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null;
    this.ctx?.close().catch(() => {}); this.ctx = null; this.recorder = null;
  }

  private async playGreeting(call: number) {
    const url = this.config.greeting.url;
    if (url) {
      try {
        await new Promise<void>((resolve, reject) => {
          const a = new Audio(url); this.greetingAudio = a;
          a.onended = () => resolve(); a.onerror = () => reject(new Error('greeting failed to load'));
          a.play().catch(reject);
        });
        return;
      } catch (e) { if (call !== this.call) return; console.warn('[phone] greeting audio failed, reading the question aloud', e); }
    }
    // No prerecorded greeting (or it failed): read the question aloud so the demo still works.
    if (typeof speechSynthesis === 'undefined') return;
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(this.config.greeting.text);
      if (this.opts.lang) u.lang = this.opts.lang;
      u.onend = () => resolve(); u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  private async beep() {
    const ctx = this.ctx; if (!ctx) return;
    const { frequencyHz, durationMs } = this.config.beep;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = frequencyHz; gain.gain.value = 0.2;
    osc.connect(gain).connect(ctx.destination); osc.start();
    await new Promise((r) => setTimeout(r, durationMs));
    osc.stop();
    // Let the tone die away before recording starts, so the beep is not on the recording.
    await new Promise((r) => setTimeout(r, 120));
  }
}
