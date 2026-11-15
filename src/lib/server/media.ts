import { error } from '@sveltejs/kit';
export function mediaBucket(platform?:Readonly<App.Platform>) {
  const bucket=platform?.env?.MEDIA;
  if(!bucket) error(503,'Private R2 media bucket is not configured');
  return bucket;
}
export const maxVideoBytes=60*1024*1024;
export const captureModes=['video','audio','either'] as const;
export type CaptureMode=(typeof captureModes)[number];
export const isCaptureMode=(x:unknown):x is CaptureMode=>captureModes.includes(x as CaptureMode);
export function validVideoMime(mime:string) {
  return /^video\/(mp4|webm|quicktime)(?:\s*;.*)?$/i.test(mime);
}
/** MediaRecorder produces audio/webm (Chrome/Firefox), audio/mp4 (Safari) or audio/ogg (Firefox). */
export function validAudioMime(mime:string) {
  return /^audio\/(mp4|webm|ogg|mpeg|wav|x-m4a)(?:\s*;.*)?$/i.test(mime);
}
export function mediaExtension(mime:string) {
  const m=mime.split(';')[0].trim().toLowerCase();
  const map:Record<string,string>={'video/webm':'webm','video/quicktime':'mov','audio/webm':'webm','audio/ogg':'ogg','audio/mpeg':'mp3','audio/wav':'wav','audio/mp4':'m4a','audio/x-m4a':'m4a'};
  return map[m]??'mp4';
}
/** Version of the participant consent wording. Stored with every permission row, for browser and device uploads alike. */
export const CONSENT_POLICY_VERSION='draft-2026-11-05';
export const maxGreetingBytes=5*1024*1024;
const greetingExtensions:Record<string,string>={mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',ogg:'audio/ogg',webm:'audio/webm'};
/** Canonical MIME type of an uploaded greeting file, or null if it is not a supported audio file. Browsers
 * report WAV as audio/x-wav and sometimes give no type at all, so fall back to the extension. */
export function greetingMime(file:{type:string;name:string}):string|null{
  let m=file.type.split(';')[0].trim().toLowerCase();
  if(m==='audio/x-wav'||m==='audio/wave')m='audio/wav';
  if(m==='audio/x-m4a')m='audio/mp4';
  if(m&&m!=='application/octet-stream')return validAudioMime(m)?m:null;
  return greetingExtensions[file.name.split('.').pop()?.toLowerCase()??'']??null;
}
