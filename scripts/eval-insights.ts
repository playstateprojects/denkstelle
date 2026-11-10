/** Run the pairwise relation classifier over hand-labelled pairs and report how it does.
 *   npm run eval:insights -- [--pairs eval/pairs.jsonl] [--model mistral-large] [--swap] [--out eval/results]
 * One JSON object per line; see eval/pairs.example.jsonl. Needs the model's API key (e.g. MISTRAL_API_KEY).
 * This only evaluates the classifier. Retrieval (nearest vs nearest+counterclaim) is the next step.
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {MODELS,DEFAULT_MODEL,modelDef,modelConfigured,llmComplete,parseJson} from '../worker/src/models.ts';
import {SYSTEM_PROMPT,EVAL_PROMPT_VERSION,RELATIONS,buildUserPrompt,parseClassification,score,formatReport,type LabelledPair,type Prediction} from '../worker/src/insight-eval.ts';

const arg=(n:string)=>{const i=process.argv.indexOf(`--${n}`);return i>=0?process.argv[i+1]:undefined};
const file=arg('pairs')??'eval/pairs.jsonl',modelId=arg('model')??DEFAULT_MODEL,swap=process.argv.includes('--swap'),outDir=arg('out')??'eval/results';
const def=modelDef(modelId);
if(!def)throw new Error(`unknown model ${modelId}; choose one of ${MODELS.map(m=>m.id).join(', ')}`);
if(!modelConfigured(def,process.env))throw new Error(`${def.keyEnv} is not set`);

const pairs:LabelledPair[]=(await readFile(file,'utf8')).split('\n').filter(l=>l.trim()&&!l.startsWith('//')).map((l,i)=>{
 const p=JSON.parse(l);
 if(!p.id||!p.from||!p.to||!RELATIONS.includes(p.gold))throw new Error(`${file} line ${i+1}: needs id, from, to and a valid gold relation`);
 return p;
});
if(new Set(pairs.map(p=>p.id)).size!==pairs.length)throw new Error('duplicate pair ids');

async function classify(from:string,to:string,fromContext?:string,toContext?:string){
 try{
  const {raw}=await llmComplete(def!,process.env,{system:SYSTEM_PROMPT,user:buildUserPrompt({from,to,fromContext,toContext}),temperature:0});
  return parseClassification(parseJson(raw));
 }catch(e){console.error('  failed:',(e as Error).message.slice(0,200));return null}
}

const preds:Prediction[]=[],rows:unknown[]=[];
for(const p of pairs){
 const a=await classify(p.from,p.to,p.fromContext,p.toContext);
 const b=swap?await classify(p.to,p.from,p.toContext,p.fromContext):undefined;
 preds.push({id:p.id,gold:p.gold,pred:a?.relation??null,swapPred:b===undefined?undefined:b?.relation??null});
 rows.push({...p,pred:a,swapped:b});
 console.log(`${p.id.padEnd(14)} gold=${p.gold.padEnd(20)} pred=${a?.relation??'FAILED'}`);
}
const title=`${def.id} (${def.model}) prompt ${EVAL_PROMPT_VERSION}, ${new Date().toISOString().slice(0,10)}`;
const report=formatReport(score(preds),title);
console.log('\n'+report);
await mkdir(outDir,{recursive:true});
const stem=`${outDir}/${def.id}-${EVAL_PROMPT_VERSION}-${Date.now()}`;
await writeFile(`${stem}.txt`,report+'\n');await writeFile(`${stem}.jsonl`,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
console.log(`\nSaved ${stem}.{txt,jsonl}`);
