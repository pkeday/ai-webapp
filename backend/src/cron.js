import { closeDatabaseConnections, runDailyPipelineJob } from "./server.js";

const jobName = "notifications-pipeline";
const trigger = "render-cron";

function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function log(message, extra = undefined) {
  const prefix = `[${new Date().toISOString()}] [cron:${jobName}]`;
  if (extra === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }

  console.log(`${prefix} ${message}`, extra);
}

function buildCronPayload() {
  const payload = { trigger };

  return payload;
}

async function main() {
  const payload = buildCronPayload();
  log("Cron run started", {
    trigger: payload.trigger,
    force: Boolean(payload.force),
    ai: payload.ai ?? null
  });

  const result = await runDailyPipelineJob(payload);
  log("Cron pipeline result", {
    ok: result.ok,
    skipped: result.skipped ?? false,
    reason: result.reason ?? null,
    nseNew: result?.nseSync?.newCount ?? null,
    bseNew: result?.bseSync?.newCount ?? null,
    dedupTouched: result?.dedupSync?.touchedCount ?? null,
    aiProcessed: result?.aiClassification?.processedCount ?? null,
    aiSuccess: result?.aiClassification?.successCount ?? null,
    aiFailed: result?.aiClassification?.failureCount ?? null,
    aiStoppedEarly: result?.aiClassification?.stoppedEarly ?? false,
    aiStopReason: result?.aiClassification?.stopReason ?? null,
    aiRemaining: result?.aiClassification?.remainingCount ?? null,
    aiPeakRssMb: result?.aiClassification?.peakRssMb ?? null,
    aiMemoryGuardMb: result?.aiClassification?.memoryGuardMb ?? null
  });

  if (!result.ok) {
    throw new Error("Daily notifications pipeline completed with errors");
  }
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("Cron failed", { message });
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnections();
  });
