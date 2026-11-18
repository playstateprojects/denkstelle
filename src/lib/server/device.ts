/** Device API core, shared by every client: the Raspberry Pi handset (Bearer credential) and the browser simulator
 * (the admin's session). Routes in src/routes/api/device/* are thin wrappers around these functions.
 */
import {json} from '@sveltejs/kit';
import type {RequestEvent} from '@sveltejs/kit';
import type postgres from 'postgres';
import {audioFormatFor,acceptedAudioMimes,AudioFormatError} from '$lib/audio-formats';
import {looksLikeDeviceToken,sha256Hex} from '$lib/device-token';
import {approvedAdmin} from './db';
import {mediaBucket,CONSENT_POLICY_VERSION} from './media';
import {notifyJobs} from './jobs';

export const DEVICE_MAX_SECONDS=180;
/** 3 minutes of 48 kHz 16-bit stereo is ~35 MB; allow headroom, well under the 128 MB Worker request limit. */
export const DEVICE_MAX_BYTES=40*1024*1024;
const MIN_DURATION_MS=1000;
/** Clock drift and the last buffer: a handset may overshoot the limit a little. */
const DURATION_TOLERANCE_MS=3000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SIMULATOR_HEADER='x-denkstelle-simulator';

/** An error with a stable machine-readable code. `retryable` tells a handset whether trying again can help. */
export class DeviceApiError extends Error{
  constructor(readonly status:number,readonly code:string,message:string,readonly retryable=false){super(message)}
}
export function errorResponse(e:unknown):Response{
  if(e instanceof DeviceApiError)return json({error:e.code,message:e.message,retryable:e.retryable},{status:e.status,headers:e.status===401?{'WWW-Authenticate':'Bearer'}:undefined});
  console.error('[device api]',e);
  return json({error:'internal_error',message:'Something went wrong on the server',retryable:true},{status:500});
}

export type DeviceProject={id:string;slug:string;title:string;question:string;status:string;capture_mode:string;phone_greeting_url:string|null;phone_greeting_key:string|null;phone_greeting_updated_at:Date|null};
export type Device={id:string;name:string;kind:'handset'|'simulator';config:Record<string,unknown>};
export type DeviceContext={device:Device;project:DeviceProject};

const PROJECT_COLUMNS=`p.id,p.slug,p.title,p.question,p.status,p.capture_mode,p.phone_greeting_url,p.phone_greeting_key,p.phone_greeting_updated_at`;

/** Resolves who is calling. Bearer credentials identify a physical device; a signed-in admin plus the simulator
 * header identifies the browser simulator. The custom header makes a cross-site request require a CORS preflight,
 * which this app never grants, so a third-party page cannot ride on an admin's cookie. */
export async function authenticateDevice(sql:postgres.Sql,event:Pick<RequestEvent,'request'|'locals'|'platform'>):Promise<DeviceContext>{
  const {request,locals,platform}=event;
  const auth=request.headers.get('authorization');
  let ctx:DeviceContext|null=null;
  if(auth){
    const token=/^Bearer\s+(\S+)$/i.exec(auth)?.[1]??'';
    if(!looksLikeDeviceToken(token))throw new DeviceApiError(401,'invalid_credential','Invalid device credential');
    const rows=await sql<(Device&{project_id:string}&DeviceProject)[]>`
      select d.id,d.name,d.kind,d.config,p.id as project_id,p.slug,p.title,p.question,p.status,p.capture_mode,p.phone_greeting_url,p.phone_greeting_key,p.phone_greeting_updated_at
      from devices d join projects p on p.id=d.project_id
      where d.token_hash=${await sha256Hex(token)} and d.revoked_at is null limit 1`;
    if(!rows.length)throw new DeviceApiError(401,'invalid_credential','Unknown or revoked device credential');
    const r=rows[0];
    ctx={device:{id:r.id,name:r.name,kind:r.kind,config:r.config},project:{id:r.project_id,slug:r.slug,title:r.title,question:r.question,status:r.status,capture_mode:r.capture_mode,phone_greeting_url:r.phone_greeting_url,phone_greeting_key:r.phone_greeting_key,phone_greeting_updated_at:r.phone_greeting_updated_at}};
  }else{
    const projectId=request.headers.get(SIMULATOR_HEADER)??'';
    if(!projectId)throw new DeviceApiError(401,'missing_credential','Authorization: Bearer <device credential> required');
    if(!locals.user)throw new DeviceApiError(401,'not_signed_in','Sign in to use the simulator');
    if(!approvedAdmin(locals.user.email,platform))throw new DeviceApiError(403,'forbidden','No access to this workspace');
    if(!UUID.test(projectId))throw new DeviceApiError(400,'invalid_project','Invalid project ID');
    const rows=await sql<DeviceProject[]>`select ${sql.unsafe(PROJECT_COLUMNS)} from projects p
      join organization_members m on m.organization_id=p.organization_id where p.id=${projectId} and m.user_id=${locals.user.id} limit 1`;
    if(!rows.length)throw new DeviceApiError(404,'project_not_found','Project not found');
    const label=`Browser simulator (${locals.user.email})`;
    await sql`insert into devices(project_id,name,kind,owner_user_id) values(${projectId},${label},'simulator',${locals.user.id}) on conflict (owner_user_id,project_id) where kind='simulator' do nothing`;
    const dev=await sql<Device[]>`select id,name,kind,config from devices where kind='simulator' and owner_user_id=${locals.user.id} and project_id=${projectId} and revoked_at is null limit 1`;
    if(!dev.length)throw new DeviceApiError(403,'device_revoked','This simulator has been revoked');
    ctx={device:dev[0],project:rows[0]};
  }
  // Same rules as the public recording page: the project must be open and take audio.
  if(ctx.project.status!=='open')throw new DeviceApiError(409,'project_closed','This project is not open for recordings');
  if(ctx.project.capture_mode==='video')throw new DeviceApiError(409,'project_not_accepting_audio','This project only accepts video recordings; set its recording mode to audio or either');
  await sql`update devices set last_seen_at=now() where id=${ctx.device.id}`;
  return ctx;
}

export function maxSecondsFor(device:Device){
  const c=Number(device.config?.maxDurationSeconds);
  return Number.isFinite(c)&&c>=5?Math.min(DEVICE_MAX_SECONDS,Math.floor(c)):DEVICE_MAX_SECONDS;
}

export function deviceConfig({device,project}:DeviceContext,origin:string){
  // An uploaded file (served from private R2 by the app) wins over an external URL set with `npm run devices -- greeting`.
  const g=project.phone_greeting_key?`/api/public/greeting/${project.id}?v=${project.phone_greeting_updated_at?.getTime()??0}`:project.phone_greeting_url;
  return {
    project:{id:project.id,slug:project.slug,title:project.title,question:project.question},
    // null means "no prerecorded audio": a client may read `question` aloud instead (the simulator does).
    greeting:{url:g?new URL(g,origin).href:null,text:project.question},
    beep:{frequencyHz:880,durationMs:300},
    recording:{maxDurationSeconds:maxSecondsFor(device),maxBytes:DEVICE_MAX_BYTES,acceptedMimeTypes:acceptedAudioMimes(),minDurationMs:MIN_DURATION_MS,
      upload:{method:'POST',path:'/api/device/recordings',headers:['Authorization','Content-Type','X-Recording-Id','X-Content-SHA256','X-Consent']}},
    consent:{required:'capture_analysis',header:'X-Consent',policyVersion:CONSENT_POLICY_VERSION},
    device:{id:device.id,name:device.name,kind:device.kind,config:device.config}
  };
}

type Existing={id:string;status:string;checksum_sha256:string|null};
const receiptBody=(recordingId:string,e:{id:string;status:string},duplicate:boolean)=>({recordingId,sourceId:e.id,received:true,duplicate,processing:e.status});

/** Accepts one complete recording. Idempotent on (device, X-Recording-Id): a retry of an already-received
 * recording returns the original receipt and never queues a second job. The processing job is created only after
 * the checksum matched, the audio parsed as complete, and the object is verified in R2. */
export async function receiveRecording(sql:postgres.Sql,{device,project}:DeviceContext,request:Request,platform:Readonly<App.Platform>|undefined):Promise<Response>{
  const recordingId=(request.headers.get('x-recording-id')??'').trim().toLowerCase();
  if(!UUID.test(recordingId))throw new DeviceApiError(400,'invalid_recording_id','X-Recording-Id must be a UUID generated by the device');
  const format=audioFormatFor(request.headers.get('content-type'));
  if(!format)throw new DeviceApiError(415,'unsupported_media_type',`Unsupported audio format. Accepted: ${acceptedAudioMimes().join(', ')}`);
  const claimed=(request.headers.get('x-content-sha256')??'').trim().toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(claimed))throw new DeviceApiError(400,'missing_checksum','X-Content-SHA256 (hex SHA-256 of the body) is required');
  const consent=(request.headers.get('x-consent')??'').split(',').map(s=>s.trim());
  if(!consent.includes('capture_analysis'))throw new DeviceApiError(400,'consent_required','X-Consent: capture_analysis is required; the caller must have obtained recording consent');
  const declared=Number(request.headers.get('content-length')??'0');
  if(declared>DEVICE_MAX_BYTES)throw new DeviceApiError(413,'too_large','Recording too large');

  const lookup=()=>sql<Existing[]>`select id,status,checksum_sha256 from sources where device_id=${device.id} and client_recording_id=${recordingId} limit 1`;
  const settled=(e:Existing)=>{
    if(e.checksum_sha256&&e.checksum_sha256!==claimed)throw new DeviceApiError(409,'recording_id_conflict','This recording ID was already used for different audio');
    return json(receiptBody(recordingId,e,true),{status:200});
  };
  let existing=(await lookup())[0];
  if(existing&&existing.status!=='awaiting_upload')return settled(existing);

  const bytes=new Uint8Array(await request.arrayBuffer());
  if(!bytes.length)throw new DeviceApiError(400,'empty_body','Empty upload');
  if(bytes.length>DEVICE_MAX_BYTES)throw new DeviceApiError(413,'too_large','Recording too large');
  if(await sha256Hex(bytes)!==claimed)throw new DeviceApiError(422,'checksum_mismatch','Body does not match X-Content-SHA256; the upload was corrupted or cut short',true);
  let info;
  try{info=format.inspect(bytes)}
  catch(e){if(e instanceof AudioFormatError)throw new DeviceApiError(422,'invalid_audio',e.message);throw e}
  const maxMs=maxSecondsFor(device)*1000;
  if(info.durationMs<MIN_DURATION_MS)throw new DeviceApiError(422,'recording_too_short','Recording is shorter than one second');
  if(info.durationMs>maxMs+DURATION_TOLERANCE_MS)throw new DeviceApiError(422,'recording_too_long',`Recording is longer than ${maxMs/1000} seconds`);

  const created=await sql<{id:string}[]>`
    insert into sources(project_id,kind,role,title,device_id,client_recording_id)
    values(${project.id},'audio','contribution','Denkstelle Telefon',${device.id},${recordingId})
    on conflict (device_id,client_recording_id) do nothing returning id`;
  if(created.length)existing={id:created[0].id,status:'awaiting_upload',checksum_sha256:null};
  else{
    // A concurrent retry created it first.
    existing=(await lookup())[0];
    if(!existing)throw new DeviceApiError(503,'try_again','Please retry',true);
    if(existing.status!=='awaiting_upload')return settled(existing);
  }
  const sourceId=existing.id;
  const key=`projects/${project.id}/sources/${sourceId}/original.${format.extension}`;
  const bucket=mediaBucket(platform);
  try{
    await bucket.put(key,bytes.buffer as ArrayBuffer,{httpMetadata:{contentType:format.mime},customMetadata:{sourceId,deviceId:device.id}});
    const stored=await bucket.head(key);
    if(!stored||stored.size!==bytes.length)throw new DeviceApiError(502,'storage_verification_failed','Stored object does not match the upload',true);
  }catch(e){
    if(e instanceof DeviceApiError)throw e;
    console.error('[device upload] storage failed',e);
    throw new DeviceApiError(503,'storage_unavailable','Could not store the recording; retry the same upload',true);
  }
  const queued=await sql.begin(async tx=>{
    // Only the request that flips awaiting_upload -> uploaded enqueues, so concurrent retries cannot double-process.
    const r=await tx`update sources set media_key=${key},mime_type=${format.mime},size_bytes=${bytes.length},duration_ms=${info.durationMs},checksum_sha256=${claimed},status='uploaded',updated_at=now()
      where id=${sourceId} and status='awaiting_upload' returning id`;
    if(!r.length)return false;
    for(const purpose of ['capture_analysis','public_excerpt','social_media','email_receipt'])
      await tx`insert into source_permissions(source_id,purpose,allowed,policy_version) values(${sourceId},${purpose},${purpose==='capture_analysis'},${CONSENT_POLICY_VERSION}) on conflict do nothing`;
    await tx`insert into processing_jobs(source_id,kind,status) values(${sourceId},'transcribe_and_ingest','queued')`;
    return true;
  });
  if(queued)await notifyJobs(platform,'upload');
  const [row]=await sql<{status:string}[]>`select status from sources where id=${sourceId}`;
  return json(receiptBody(recordingId,{id:sourceId,status:row?.status??'uploaded'},!queued),{status:queued?201:200});
}

/** Lets a device confirm a recording it is unsure about, e.g. after a timeout on the POST. */
export async function recordingStatus(sql:postgres.Sql,{device}:DeviceContext,recordingId:string):Promise<Response>{
  const id=recordingId.toLowerCase();
  if(!UUID.test(id))throw new DeviceApiError(400,'invalid_recording_id','Recording ID must be a UUID');
  const rows=await sql<{id:string;status:string}[]>`select id,status from sources where device_id=${device.id} and client_recording_id=${id} limit 1`;
  const r=rows[0];
  // An unfinished (awaiting_upload) row means the server never accepted the audio: the device must upload again.
  if(!r||r.status==='awaiting_upload')throw new DeviceApiError(404,'not_received','Recording has not been received');
  return json({recordingId:id,sourceId:r.id,received:true,processing:r.status});
}
