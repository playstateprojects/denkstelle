/** Microphone -> mono 16 kHz 16-bit WAV. Browser-only, no Svelte. The Pi equivalent is `arecord -f S16_LE -r 16000 -c 1`. */
import {encodeWav} from '../audio-formats';

export const TARGET_RATE = 16000;

/** Box-average downsampling (cheap anti-aliasing for speech) or linear interpolation when upsampling. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = i * ratio, end = Math.min(input.length, (i + 1) * ratio);
    if (ratio > 1) {
      let sum = 0, n = 0;
      for (let j = Math.floor(start); j < Math.ceil(end); j++) { sum += input[j]; n++; }
      out[i] = n ? sum / n : 0;
    } else {
      const j = Math.floor(start), frac = start - j;
      out[i] = input[j] * (1 - frac) + (input[Math.min(j + 1, input.length - 1)] * frac);
    }
  }
  return out;
}

const WORKLET = `class Tap extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('tap',Tap)`;

export class WavRecorder {
  private chunks: Float32Array[] = [];
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private samples = 0;
  /** Seconds of audio captured so far (from sample count, not wall time). */
  get seconds() { return this.samples / this.ctx.sampleRate; }
  constructor(private ctx: AudioContext, private stream: MediaStream) {}

  async start() {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await this.ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 1024;
    this.node = new AudioWorkletNode(this.ctx, 'tap');
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => { this.chunks.push(e.data); this.samples += e.data.length; };
    this.source.connect(this.analyser);
    this.source.connect(this.node); // the tap outputs nothing, so it is not connected to the speakers
  }
  /** Current input level, 0..100. */
  level() {
    if (!this.analyser) return 0;
    const x = new Float32Array(this.analyser.fftSize); this.analyser.getFloatTimeDomainData(x);
    let sq = 0; for (const n of x) sq += n * n;
    return Math.min(100, Math.sqrt(sq / x.length) * 300);
  }
  stop(): { wav: Uint8Array; durationMs: number } {
    this.node?.port.close(); this.node?.disconnect(); this.source?.disconnect(); this.node = null;
    const all = new Float32Array(this.samples); let at = 0;
    for (const c of this.chunks) { all.set(c, at); at += c.length; }
    this.chunks = [];
    const mono = resample(all, this.ctx.sampleRate, TARGET_RATE);
    return { wav: encodeWav(mono, TARGET_RATE), durationMs: Math.round((mono.length / TARGET_RATE) * 1000) };
  }
}
