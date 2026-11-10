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
