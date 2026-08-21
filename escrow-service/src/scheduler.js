// Background jobs:
//   1. Auto-release sweep — runs on a configurable cron schedule (default: every
//      minute) and delegates to runReleaseCheck() — same function backing
//      POST /admin/run-release-check, no duplicated release logic.
//   2. Stale-transition recovery — runs once on startup (to catch anything that
//      got stuck before the last restart) and then on each cron tick alongside
//      the release sweep.

const cron = require('node-cron');
const { runReleaseCheck } = require('./orderService');
const { runRecovery } = require('./recoveryService');

// Default: every minute. Override via RELEASE_CHECK_CRON, e.g. "*/10 * * * * *"
// for every 10 seconds (node-cron supports optional seconds field), or
// "0 * * * *" for hourly in a production-like setting.
const CRON_SCHEDULE = process.env.RELEASE_CHECK_CRON || '* * * * *';

let task = null;

function startScheduler() {
  if (task) return task;

  // Run recovery once immediately after startup to resolve any orders that were
  // stuck in a transient status when the previous process exited.
  runRecovery().catch((err) => console.error('[recovery] startup sweep failed:', err));

  task = cron.schedule(CRON_SCHEDULE, async () => {
    // Recovery sweep first so stale transients are resolved before the
    // release sweep might try to act on the same orders.
    try {
      const recResult = await runRecovery();
      if (!recResult.skipped && recResult.candidateCount > 0) {
        console.log(
          `[scheduler] recovery: ${recResult.recoveredOrderIds.length} recovered, ` +
            `${recResult.ambiguous.length} ambiguous, ${recResult.failed.length} failed`
        );
      }
    } catch (err) {
      console.error('[scheduler] recovery sweep failed:', err);
    }

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

  console.log(`[scheduler] auto-release + recovery jobs scheduled: "${CRON_SCHEDULE}"`);
  return task;
}

function stopScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { startScheduler, stopScheduler };
