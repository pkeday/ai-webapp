import { closeDatabaseConnections, runSourceIngestionJob } from "../server.js";

const trigger = process.env.JOB_TRIGGER ?? "manual-source-ingestion";

function log(message, extra = undefined) {
  const prefix = `[${new Date().toISOString()}] [job:source-ingestion]`;
  if (extra === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`, extra);
}

async function main() {
  log("Source ingestion started", { trigger });
  const stage = await runSourceIngestionJob(trigger);
  const ok = stage.nseResult.status === "fulfilled" && stage.bseResult.status === "fulfilled";
  log("Source ingestion finished", {
    ok,
    nseNew: stage?.nseResult?.status === "fulfilled" ? stage.nseResult.value?.newCount ?? 0 : null,
    bseNew: stage?.bseResult?.status === "fulfilled" ? stage.bseResult.value?.newCount ?? 0 : null,
    hasNewSourceRows: stage.hasNewSourceRows
  });
  if (!ok) {
    throw new Error("Source ingestion failed");
  }
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("Source ingestion failed", { message });
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnections();
  });
