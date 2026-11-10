/** denkstelle-processor: wakes the processing container when there is work.
 *
 *   SvelteKit Worker --JOBS queue--> queue() --POST /drain--> Processor container (FFmpeg, Whisper, DeepSeek)
 *   cron (5 min)  --> scheduled(): requeue stuck jobs, re-poke if anything has been waiting too long
 *
 * Postgres (processing_jobs) is the source of truth. A queue message only means "go look". Duplicates, lost
 * messages and retries are therefore harmless: claiming a job is atomic and the sweep re-pokes anything overdue.
 */
import {Container, getContainer} from '@cloudflare/containers';
import postgres from 'postgres';
import {overdueCount, reapStuck} from '../../worker/src/queue.ts';

interface Env {
  PROCESSOR: DurableObjectNamespace<Processor>;
  JOBS: Queue<WakeMessage>;
  HYPERDRIVE: Hyperdrive;
  // Secrets, forwarded to the container (set with `npm run processor:secrets`).
  DATABASE_URL: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  WORKERS_AI_API_TOKEN: string;
  DEEPSEEK_API_KEY: string;
}
type WakeMessage = {kind: 'upload' | 'approve' | 'retry' | 'sweep' | 'more'};
type DrainResult = {processed: number; failed: number; retried: number; more: boolean};

export class Processor extends Container<Env> {
  defaultPort = 8080;
  // Idle time before the instance stops billing memory/disk. The Worker's open /drain request counts as activity,
  // and onActivityExpired below double-checks before stopping.
  sleepAfter = '3m';
  enableInternet = true; // R2 (S3 API), Workers AI REST, DeepSeek and Postgres are all reached over the internet.

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      DATABASE_URL: env.DATABASE_URL,
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET: env.R2_BUCKET,
      WORKERS_AI_API_TOKEN: env.WORKERS_AI_API_TOKEN,
      DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
    };
  }

  // Code running inside the container does not count as activity, so never stop it mid-job.
  override async onActivityExpired(): Promise<void> {
    try {
      const status = (await (await this.containerFetch('http://container/status')).json()) as {busy?: boolean};
      if (status.busy) {
        this.renewActivityTimeout();
        return;
      }
    } catch (err) {
      console.error('[processor] status check failed, stopping container', err);
    }
    await this.stop();
  }

  override onError(error: unknown): void {
    console.error('[processor] container error', error);
  }
}

async function drain(env: Env): Promise<DrainResult> {
  const res = await getContainer(env.PROCESSOR, 'main').fetch(new Request('http://container/drain', {method: 'POST'}));
  if (!res.ok) throw new Error(`container /drain responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as DrainResult;
}

export default {
  async queue(batch: MessageBatch<WakeMessage>, env: Env): Promise<void> {
    // Every message means the same thing, so a whole batch is a single drain.
    try {
      const result = await drain(env);
      console.log('[processor] drained', JSON.stringify(result));
      batch.ackAll();
      // Stopped early (time budget): carry on in a fresh invocation.
      if (result.more) await env.JOBS.send({kind: 'more'}, {delaySeconds: 5});
      // A failed job was put back with a backoff (60s+). Nothing else wakes us for it before the next sweep.
      if (result.retried > 0) await env.JOBS.send({kind: 'retry'}, {delaySeconds: 65});
    } catch (err) {
      console.error('[processor] drain failed, will retry', err);
      batch.retryAll({delaySeconds: 60});
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const sql = postgres(env.DATABASE_URL, {max: 1, fetch_types: false});
        try {
          const reaped = await reapStuck(sql);
          const overdue = await overdueCount(sql);
          console.log(`[processor] sweep: reaped ${reaped}, overdue ${overdue}`);
          if (reaped || overdue) await env.JOBS.send({kind: 'sweep'});
        } catch (err) {
          console.error('[processor] sweep failed', err);
        } finally {
          await sql.end({timeout: 1});
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env, WakeMessage>;
