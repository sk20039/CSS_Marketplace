// Background auto-release job. Runs on a configurable cron schedule (default:
// every minute, fine for dev/demo) and delegates to the SAME runReleaseCheck()
// function backing POST /admin/run-release-check - no duplicated release logic.

const cron = require('node-cron');
const { runReleaseCheck } = require('./orderService');

// Default: every minute. Override via RELEASE_CHECK_CRON, e.g. "*/10 * * * * *"
// for every 10 seconds (node-cron supports optional seconds field), or
// "0 * * * *" for hourly in a production-like setting.
const CRON_SCHEDULE = process.env.RELEASE_CHECK_CRON || '* * * * *';

let task = null;

function startScheduler() {
  if (task) return task;
  task = cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const result = await runReleaseCheck();
      if (result.candidateCount > 0) {
        console.log(
          `[scheduler] release sweep: ${result.releasedOrderIds.length} released, ` +
            `${result.failed.length} failed (of ${result.candidateCount} candidates)`
        );
      }
    } catch (err) {
      console.error('[scheduler] release sweep failed:', err);
    }
  });
  console.log(`[scheduler] auto-release job scheduled: "${CRON_SCHEDULE}"`);
  return task;
}

function stopScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { startScheduler, stopScheduler };
