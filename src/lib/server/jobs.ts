/** Wake the processing worker. The job row in `processing_jobs` is the source of truth; this message only says
 * "go look". If sending fails (or the binding is absent in local dev) the job stays queued and the processor's
 * 5-minute cron sweep picks it up, so a failure here must never fail the user's request.
 */
export async function notifyJobs(platform: Readonly<App.Platform> | undefined, kind: 'upload' | 'approve' | 'reel') {
  const queue = platform?.env?.JOBS;
  if (!queue) return;
  try {
    await queue.send({ kind });
  } catch (e) {
    console.error('[jobs] wake-up message failed; the cron sweep will pick the job up', e);
  }
}
