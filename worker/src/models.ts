/** The chat models the analysis can run on, and one JSON-mode call that works for all of them.
 * Pure `fetch`: used by the processing container (process.env) and the SvelteKit admin (Worker env) alike.
 * To add a model, add a row to MODELS and set its key env var: both the pipeline and /admin pick it up.
 */
export type ModelDef={id:string;label:string;url:string;model:string;keyEnv:string};
export type Env=Record<string,string|undefined>;

// All speak the OpenAI chat-completions dialect with `response_format: json_object`.
export const MODELS:readonly ModelDef[]=[
 {id:'deepseek-flash',label:'DeepSeek Flash',url:'https://api.deepseek.com/chat/completions',model:'deepseek-flash',keyEnv:'DEEPSEEK_API_KEY'},
 {id:'mistral-large',label:'Mistral Large',url:'https://api.mistral.ai/v1/chat/completions',model:'mistral-large-latest',keyEnv:'MISTRAL_API_KEY'}
];
export const DEFAULT_MODEL=MODELS[0].id;
export const modelDef=(id:string)=>MODELS.find(m=>m.id===id);
export const modelConfigured=(def:ModelDef,env:Env)=>!!env[def.keyEnv];

const TIMEOUT_MS=5*60*1000;

export class LlmError extends Error{constructor(message:string,readonly raw?:string,readonly ms?:number){super(message)}}

/** One chat completion. Returns the model's raw text; parsing is separate so callers can show bad output. */
export async function llmComplete(def:ModelDef,env:Env,o:{system:string;user:string;temperature:number}):Promise<{raw:string;ms:number}>{
 const key=env[def.keyEnv];if(!key)throw new LlmError(`${def.keyEnv} missing`);
 const t0=Date.now();
 const r=await fetch(def.url,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
  body:JSON.stringify({model:def.model,temperature:o.temperature,response_format:{type:'json_object'},messages:[{role:'system',content:o.system},{role:'user',content:o.user}]}),
  signal:AbortSignal.timeout(TIMEOUT_MS)});
 const ms=Date.now()-t0;
 if(!r.ok)throw new LlmError(`${def.label} ${r.status}: ${(await r.text()).slice(0,300)}`,undefined,ms);
 const body:any=await r.json().catch(()=>null);
 const raw=body?.choices?.[0]?.message?.content;
 if(typeof raw!=='string')throw new LlmError(`${def.label} returned no message content`,JSON.stringify(body)?.slice(0,2000),ms);
 return {raw,ms};
}
/** JSON.parse that tolerates a ```json fence, which some models add despite json mode. */
export function parseJson(raw:string):unknown{
 const t=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
 return JSON.parse(t);
}
