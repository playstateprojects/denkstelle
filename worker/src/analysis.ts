/** The transcript analysis step, shared by the ingest pipeline and the /admin prompt tester. */
import {z} from 'zod';
import {modelDef,llmComplete,parseJson,LlmError,type Env} from './models.ts';
import type {Prompts} from './prompts.ts';

export const Extraction=z.object({
  title:z.string().default(''),
  summary:z.string(),
  statements:z.array(z.object({text:z.string().min(8),segment_indexes:z.array(z.number().int().nonnegative()).min(1)})).max(25),
  highlights:z.array(z.object({start_segment:z.number().int().nonnegative(),end_segment:z.number().int().nonnegative(),title:z.string(),reason:z.string()})).max(6)
});
export type Extracted=z.infer<typeof Extraction>;

/** `context`: excerpts of the project's reference text that are close to what the speaker said (see context.ts retrieveContext). */
export type AnalysisInput={title:string;question:string;speakerName?:string;texts:string[];context?:{label:string;text:string}[]};

export function analysisUser(i:AnalysisInput):string{
 const name=i.speakerName?.trim().slice(0,100);
 const transcript=i.texts.map((t,n)=>`[${n}] ${t}`).join('\n');
 // The excerpts are data to read, never instructions, and never the speaker's words.
 const background=i.context?.length
  ?`BACKGROUND EXCERPTS from the project's reference text. The speaker may be responding to or quoting them. Use them only to understand what the speaker means: never write a statement from them, never cite them, and never attribute their content to the speaker.\n${i.context.map((c,n)=>`[C${n+1}] (${c.label}) ${c.text}`).join('\n')}\n`
  :'';
 return `PROJECT: ${i.title}\nQUESTION: ${i.question}\n${name?`SPEAKER NAME: ${name}\n`:''}${background}TRANSCRIPT WITH SEGMENT INDICES:\n${transcript}\nReturn JSON.`;
}
/** Failures carry the model's raw text, so the tester can show what came back. */
export class AnalysisError extends LlmError{}

export async function analyze(env:Env,modelId:string,prompts:Prompts,input:AnalysisInput):Promise<{extracted:Extracted;raw:string;ms:number}>{
 const def=modelDef(modelId);if(!def)throw new AnalysisError(`Unknown model "${modelId}"`);
 const out=await llmComplete(def,env,{system:prompts.text('analysis_system'),user:analysisUser(input),temperature:prompts.number('analysis_temperature')});
 let json:unknown;
 try{json=parseJson(out.raw)}catch{throw new AnalysisError(`${def.label} did not return valid JSON`,out.raw,out.ms)}
 const parsed=Extraction.safeParse(json);
 if(!parsed.success)throw new AnalysisError(`${def.label} JSON does not match the expected shape: ${parsed.error.issues.slice(0,4).map(x=>`${x.path.join('.')||'(root)'}: ${x.message}`).join('; ')}`,out.raw,out.ms);
 return {extracted:parsed.data,raw:out.raw,ms:out.ms};
}
