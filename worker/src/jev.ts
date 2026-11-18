/** TypeSafe's Jev: a System One model that answers typed questions about state with calibrated probabilities.
 * This file only talks to the API. Which questions to ask and what to do with the answers lives in the caller
 * (theme-match.ts), so code makes the decisions and Jev supplies judgements.
 * Pure `fetch`, like models.ts.
 */
export const JEV_MODEL='jev-latest';
const ENDPOINT='https://api.typesafe.ai/v1/systemone';
const TIMEOUT_MS=60_000;

/** A yes/no question. The id it is sent under is not shown to the model; `instructions` and `criteria` are. */
export type Noul={type:'noul';instructions:string;criteria?:{true:string;false:string}};

/** Asks every question over the same state in one request. Returns P(yes) per question id.
 * Any API or shape problem throws: a failed call is never an answer, and must not be read as "no". */
export async function askNouls(env:{TYPESAFE_API_KEY?:string},state:Record<string,unknown>,questions:Record<string,Noul>):Promise<{answers:Record<string,number>;tokens:number}>{
 if(!env.TYPESAFE_API_KEY)throw new Error('TYPESAFE_API_KEY is not set');
 const res=await fetch(ENDPOINT,{method:'POST',headers:{Authorization:`Bearer ${env.TYPESAFE_API_KEY}`,'Content-Type':'application/json'},
  body:JSON.stringify({model:JEV_MODEL,state,questions}),signal:AbortSignal.timeout(TIMEOUT_MS)});
 const body:any=await res.json().catch(()=>null);
 if(!res.ok)throw new Error(`Jev ${res.status}: ${JSON.stringify(body?.detail??body).slice(0,300)}`);
 const answers:Record<string,number>={};
 for(const id of Object.keys(questions)){
  const v=body?.answers?.[id]?.noul;
  if(typeof v!=='number'||!(v>=0&&v<=1))throw new Error(`Jev returned no probability for "${id}"`);
  answers[id]=v;
 }
 return {answers,tokens:body?.usage?.input_tokens??0};
}
