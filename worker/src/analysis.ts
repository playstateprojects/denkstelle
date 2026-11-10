/** The transcript analysis step, shared by the ingest pipeline and the /admin prompt tester. */
import {z} from 'zod';
import {modelDef,llmComplete,parseJson,LlmError,type Env} from './models.ts';
import type {Prompts} from './prompts.ts';

export const Extraction=z.object({
  title:z.string().default(''),
  summary:z.string(),
  statements:z.array(z.object({text:z.string().min(8),segment_indexes:z.array(z.number().int().nonnegative()).min(1),themes:z.array(z.string()).default([])})).max(25),
  highlights:z.array(z.object({start_segment:z.number().int().nonnegative(),end_segment:z.number().int().nonnegative(),title:z.string(),reason:z.string()})).max(6)
});
export type Extracted=z.infer<typeof Extraction>;

export function analysisUser(i:{title:string;question:string;speakerName?:string;texts:string[]}):string{
 const name=i.speakerName?.trim().slice(0,100);
 const transcript=i.texts.map((t,n)=>`[${n}] ${t}`).join('\n');
 return `PROJECT: ${i.title}\nQUESTION: ${i.question}\n${name?`SPEAKER NAME: ${name}\n`:''}TRANSCRIPT WITH SEGMENT INDICES:\n${transcript}\nReturn JSON.`;
}
/** Failures carry the model's raw text, so the tester can show what came back. */
export class AnalysisError extends LlmError{}

export async function analyze(env:Env,modelId:string,prompts:Prompts,input:{title:string;question:string;speakerName?:string;texts:string[]}):Promise<{extracted:Extracted;raw:string;ms:number}>{
 const def=modelDef(modelId);if(!def)throw new AnalysisError(`Unknown model "${modelId}"`);
 const out=await llmComplete(def,env,{system:prompts.text('analysis_system'),user:analysisUser(input),temperature:prompts.number('analysis_temperature')});
 let json:unknown;
 try{json=parseJson(out.raw)}catch{throw new AnalysisError(`${def.label} did not return valid JSON`,out.raw,out.ms)}
 const parsed=Extraction.safeParse(json);
 if(!parsed.success)throw new AnalysisError(`${def.label} JSON does not match the expected shape: ${parsed.error.issues.slice(0,4).map(x=>`${x.path.join('.')||'(root)'}: ${x.message}`).join('; ')}`,out.raw,out.ms);
 return {extracted:parsed.data,raw:out.raw,ms:out.ms};
}
