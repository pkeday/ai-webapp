import { closeDatabaseConnections, runAiClassificationJob } from "../server.js";

const trigger = process.env.JOB_TRIGGER ?? "manual-ai-classification";

function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function parseOptionalBoolean(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["1", "true", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n"].includes(normalized)) {
    return false;
  }
  return null;
}

function parseOptionalPositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function parseTouchedKeys(value) {
  return normalizeText(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function log(message, extra = undefined) {
  const prefix = `[${new Date().toISOString()}] [job:ai-classification]`;
  if (extra === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`, extra);
}

async function main() {
  const forceEnabled = parseOptionalBoolean(process.env.JOB_AI_FORCE_ENABLED);
  const maxItems = parseOptionalPositiveInt(process.env.JOB_AI_MAX_ITEMS);
  const recentCandidatePool = parseOptionalPositiveInt(process.env.JOB_AI_RECENT_POOL);
  const touchedDedupKeys = parseTouchedKeys(process.env.JOB_AI_TOUCHED_DEDUP_KEYS);

  const options = {};
  if (forceEnabled !== null) {
    options.forceEnabled = forceEnabled;
  }
  if (maxItems !== null) {
    options.maxItems = maxItems;
  }
  if (recentCandidatePool !== null) {
    options.scanRecentWhenNoTouched = true;
    options.recentCandidatePool = recentCandidatePool;
  }

  const dedupResult =
    touchedDedupKeys.length > 0
      ? {
          status: "fulfilled",
          value: {
            touchedDedupKeys
          }
        }
      : null;

  log("AI classification started", {
    trigger,
    forceEnabled: forceEnabled ?? null,
    maxItems: maxItems ?? null,
    recentCandidatePool: recentCandidatePool ?? null,
    touchedKeys: touchedDedupKeys.length
  });
  const stage = await runAiClassificationJob(trigger, dedupResult, options);
  const ok = stage.status === "fulfilled";
  log("AI classification finished", {
    ok,
    skipped: stage.status === "fulfilled" ? Boolean(stage.value?.skipped) : null,
    reason: stage.status === "fulfilled" ? stage.value?.reason ?? null : null,
    processedCount: stage.status === "fulfilled" ? stage.value?.processedCount ?? null : null,
    successCount: stage.status === "fulfilled" ? stage.value?.successCount ?? null : null,
    failureCount: stage.status === "fulfilled" ? stage.value?.failureCount ?? null : null
  });
  if (!ok) {
    throw new Error(stage.reason instanceof Error ? stage.reason.message : "AI classification stage failed");
  }
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("AI classification failed", { message });
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnections();
  });
