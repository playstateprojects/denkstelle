/** Run `npm run process:once` to drain the job queue from a trusted machine with ffmpeg and R2 S3 credentials.
 * In production the same code runs inside the Cloudflare Container (see processor/ and worker/), woken by a queue message.
 * This script is the manual escape hatch and the way to process locally. The work itself lives in worker/src.
 */
import {database} from '../worker/src/utils.ts';
import {drainQueue} from '../worker/src/drain.ts';

const sql=database();
try{
  const result=await drainQueue(sql);
  console.log(result.processed||result.failed||result.retried?`Done: ${JSON.stringify(result)}`:'No queued jobs');
  if(result.failed)process.exitCode=1;
}finally{await sql.end();}
