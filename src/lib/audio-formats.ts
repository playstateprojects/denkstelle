/** Audio formats the device API accepts. Pure (no framework or runtime imports) so the server, the browser
 * simulator and the tests share it. To support another format (say FLAC or Opus), add an entry to `formats`:
 * a MIME type, a file extension and an `inspect` that checks the bytes are a COMPLETE file and reports its duration.
 */
export type AudioInfo = { durationMs: number; sampleRate: number; channels: number };
export type AudioFormat = {
  mime: string;
  extension: string;
  /** Throws AudioFormatError if the bytes are not a complete, playable file of this format. */
  inspect(bytes: Uint8Array): AudioInfo;
};
export class AudioFormatError extends Error {}

const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));

/** Reads the RIFF header of a PCM WAV and checks the data chunk is fully present, so a truncated upload is rejected. */
export function inspectWav(bytes: Uint8Array): AudioInfo {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') throw new AudioFormatError('Not a WAV file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = ascii(bytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) throw new AudioFormatError('Truncated WAV header');
      fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt) throw new AudioFormatError('WAV data chunk before fmt chunk');
      // 1 = integer PCM; 0xFFFE = WAVE_FORMAT_EXTENSIBLE (what many Linux tools write for >16 bit or >2 channels).
      if (fmt.format !== 1 && fmt.format !== 0xfffe) throw new AudioFormatError('Only PCM WAV is supported');
      if (!fmt.channels || fmt.channels > 2) throw new AudioFormatError('WAV must be mono or stereo');
      if (fmt.sampleRate < 8000 || fmt.sampleRate > 96000) throw new AudioFormatError('Unsupported WAV sample rate');
      if (![8, 16, 24, 32].includes(fmt.bits)) throw new AudioFormatError('Unsupported WAV bit depth');
      if (body + size > bytes.length) throw new AudioFormatError('WAV is truncated (data chunk is shorter than declared)');
      const frame = fmt.channels * (fmt.bits / 8);
      return { durationMs: Math.round((size / frame / fmt.sampleRate) * 1000), sampleRate: fmt.sampleRate, channels: fmt.channels };
    }
    pos = body + size + (size & 1); // chunks are word-aligned
  }
  throw new AudioFormatError('WAV has no data chunk');
}

export const formats: Record<string, AudioFormat> = {
  'audio/wav': { mime: 'audio/wav', extension: 'wav', inspect: inspectWav }
};
/** Common spellings of the same type, mapped to the canonical key in `formats`. */
const aliases: Record<string, string> = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav' };

/** Looks up a Content-Type header value (parameters allowed) in the registry. */
export function audioFormatFor(contentType: string | null): AudioFormat | null {
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return formats[aliases[mime] ?? mime] ?? null;
}
export const acceptedAudioMimes = () => Object.keys(formats);

/** Encodes mono float samples (-1..1) as a 16-bit PCM WAV. Used by the browser simulator. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}
