import { closeDatabaseConnections, runDerivedTablesJob } from "../server.js";

const trigger = process.env.JOB_TRIGGER ?? "manual-derived-tables";

function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function parseBoolean(value, fallback) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function log(message, extra = undefined) {
  const prefix = `[${new Date().toISOString()}] [job:derived-tables]`;
  if (extra === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`, extra);
}

async function main() {
  const hasNewSourceRows = parseBoolean(process.env.JOB_HAS_NEW_SOURCE_ROWS, true);
  log("Derived tables refresh started", { trigger, hasNewSourceRows });
  const stage = await runDerivedTablesJob(trigger, hasNewSourceRows);
  const ok = stage.combinedResult.status === "fulfilled" && stage.dedupResult.status === "fulfilled";
  log("Derived tables refresh finished", {
    ok,
    combinedSkipped: stage?.combinedResult?.status === "fulfilled" ? Boolean(stage.combinedResult.value?.skipped) : null,
    dedupSkipped: stage?.dedupResult?.status === "fulfilled" ? Boolean(stage.dedupResult.value?.skipped) : null,
    dedupTouched: stage?.dedupResult?.status === "fulfilled" ? stage.dedupResult.value?.touchedCount ?? null : null
  });
  if (!ok) {
    throw new Error("Derived tables refresh failed");
  }
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("Derived tables refresh failed", { message });
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnections();
  });
