import postgres from 'postgres';
import {S3Client,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {modelDef,llmComplete,parseJson} from './models.ts';

const run=promisify(execFile);
// A hung call must not block the serial worker forever; the job's retry logic takes over.
const API_TIMEOUT_MS=5*60*1000;
const FFMPEG_TIMEOUT_MS=10*60*1000;

export function database(){if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL missing');return postgres(process.env.DATABASE_URL,{max:2,fetch_types:false});}
export function objectStore(){
 const {R2_ACCOUNT_ID,R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY,R2_BUCKET}=process.env;
 if(!R2_ACCOUNT_ID||!R2_ACCESS_KEY_ID||!R2_SECRET_ACCESS_KEY||!R2_BUCKET)throw new Error('Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET');
 return {bucket:R2_BUCKET,client:new S3Client({region:'auto',endpoint:`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,credentials:{accessKeyId:R2_ACCESS_KEY_ID,secretAccessKey:R2_SECRET_ACCESS_KEY}})};
}
export async function downloadObject(key:string,filename:string){const {bucket,client}=objectStore();const body=(await client.send(new GetObjectCommand({Bucket:bucket,Key:key}))).Body;
 if(!body)throw new Error(`Empty object: ${key}`);await writeFile(filename,await body.transformToByteArray());}
export async function uploadObject(key:string,filename:string,contentType:string){const {bucket,client}=objectStore();await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:await readFile(filename),ContentType:contentType}));}
export async function tempWorkspace(){const dir=join(tmpdir(),`denkstelle-${crypto.randomUUID()}`);await mkdir(dir,{recursive:true});return dir;}
export async function ffmpeg(...args:string[]){await run('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{maxBuffer:8*1024*1024,timeout:FFMPEG_TIMEOUT_MS});}
export async function cloudflareAI(model:string,input:Record<string,unknown>){
 const a=process.env.R2_ACCOUNT_ID,token=process.env.WORKERS_AI_API_TOKEN;
 if(!a||!token)throw new Error('R2_ACCOUNT_ID and WORKERS_AI_API_TOKEN required for Workers AI');
 const res=await fetch(`https://api.cloudflare.com/client/v4/accounts/${a}/ai/run/${model}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(API_TIMEOUT_MS)});
 const payload:any=await res.json().catch(()=>null);if(!res.ok||payload?.success===false)throw new Error(`Workers AI ${model}: ${res.status} ${JSON.stringify(payload).slice(0,500)}`);
 return payload?.result??payload;
}
export async function embeddings(texts:string[]):Promise<number[][]>{
 if(!texts.length)return [];
 const out:number[][]=[];for(let i=0;i<texts.length;i+=10){const result=await cloudflareAI('@cf/qwen/qwen3-embedding-0.6b',{text:texts.slice(i,i+10)});
 const data=result?.data as number[][];if(!data||data.length!==Math.min(10,texts.length-i)||data.some(x=>x.length!==1024))throw new Error('Invalid embedding response');out.push(...data);}return out;
}
export const vector=(v:number[])=>JSON.stringify(v);
export async function deepseekJson(system:string,user:string):Promise<any>{
 const def=modelDef('deepseek-flash')!;
 return parseJson((await llmComplete(def,process.env,{system,user,temperature:.15})).raw);
}
