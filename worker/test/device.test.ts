/** Pure parts of the device API: the audio-format registry, WAV validation, the simulator's encoder/resampler and
 * device credentials. No database needed. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {audioFormatFor,encodeWav,inspectWav,AudioFormatError,acceptedAudioMimes} from '../../src/lib/audio-formats.ts';
import {resample} from '../../src/lib/phone/recorder.ts';
import {newDeviceToken,looksLikeDeviceToken,sha256Hex} from '../../src/lib/device-token.ts';

const tone=(seconds:number,rate=16000)=>Float32Array.from({length:Math.round(seconds*rate)},(_,i)=>Math.sin(i/20)*0.5);

test('encodeWav output parses back with the right duration, rate and channels',()=>{
  const info=inspectWav(encodeWav(tone(2.5),16000));
  assert.equal(info.durationMs,2500);assert.equal(info.sampleRate,16000);assert.equal(info.channels,1);
});
test('a truncated WAV is rejected, so a cut-off upload never gets queued',()=>{
  const wav=encodeWav(tone(2),16000);
  assert.throws(()=>inspectWav(wav.subarray(0,wav.length-1000)),AudioFormatError);
  assert.throws(()=>inspectWav(wav.subarray(0,30)),AudioFormatError);
});
test('non-WAV bytes and unsupported encodings are rejected',()=>{
  assert.throws(()=>inspectWav(new TextEncoder().encode('ID3'.padEnd(100,'x'))),AudioFormatError);
  const wav=encodeWav(tone(1),16000);
  new DataView(wav.buffer).setUint16(20,3,true); // IEEE float, not PCM
  assert.throws(()=>inspectWav(wav),/PCM/);
});
test('chunks before data (LIST) and odd padding are skipped',()=>{
  const body=encodeWav(tone(1),16000);
  const list=new Uint8Array(8+3+1);list.set(new TextEncoder().encode('LIST'),0);new DataView(list.buffer).setUint32(4,3,true);
  const out=new Uint8Array(body.length+list.length);
  out.set(body.subarray(0,36),0);out.set(list,36);out.set(body.subarray(36),36+list.length);
  assert.equal(inspectWav(out).durationMs,1000);
});
test('registry resolves WAV spellings and rejects other types',()=>{
  for(const t of ['audio/wav','audio/x-wav','audio/wave','AUDIO/WAV; codecs=1'])assert.equal(audioFormatFor(t)?.extension,'wav',t);
  assert.equal(audioFormatFor('audio/mpeg'),null);assert.equal(audioFormatFor(null),null);
  assert.deepEqual(acceptedAudioMimes(),['audio/wav']);
});
test('resample changes length by the rate ratio and keeps a constant signal constant',()=>{
  const out=resample(new Float32Array(48000).fill(0.25),48000,16000);
  assert.equal(out.length,16000);assert.ok(out.every(x=>Math.abs(x-0.25)<1e-6));
  assert.equal(resample(new Float32Array(441),44100,16000).length,160);
  const same=new Float32Array(10);assert.equal(resample(same,16000,16000),same);
});
test('device credentials: format, uniqueness, stable hash',async()=>{
  const a=newDeviceToken(),b=newDeviceToken();
  assert.ok(looksLikeDeviceToken(a));assert.notEqual(a,b);
  assert.ok(!looksLikeDeviceToken('dk_short'));assert.ok(!looksLikeDeviceToken(a+'x'));
  assert.equal(await sha256Hex(a),await sha256Hex(a));
  assert.equal(await sha256Hex('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')),await sha256Hex('abc'));
});
