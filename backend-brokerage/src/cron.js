const apiBaseUrl = (process.env.API_BASE_URL || process.env.PUBLIC_API_BASE_URL || "http://localhost:10001").replace(
  /\/$/,
  ""
);
const cronSecret = process.env.CRON_SECRET || "";
const trigger = process.env.CRON_TRIGGER || "brokerage-cron-script";

async function main() {
  const response = await fetch(`${apiBaseUrl}/api/jobs/daily`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cronSecret ? { "x-cron-secret": cronSecret } : {})
    },
    body: JSON.stringify({ trigger })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Cron trigger failed (${response.status})`);
  }

  const summary = payload.scheduleSummary || {};
  console.log(
    JSON.stringify(
      {
        ok: true,
        runCount: payload.runCount,
        lastCronRunAt: payload.lastCronRunAt,
        dueUsers: summary.dueUsers ?? 0,
        successfulRuns: summary.successfulRuns ?? 0,
        failedRuns: summary.failedRuns ?? 0,
        archivedCount: summary.archivedCount ?? 0
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
