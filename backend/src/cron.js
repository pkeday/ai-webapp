const cronSecret = process.env.CRON_SECRET ?? "";
const jobName = process.env.CRON_JOB_NAME ?? "scheduled-maintenance";

function normalizeBaseUrl(value) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

const apiBaseUrl = normalizeBaseUrl(process.env.API_BASE_URL ?? "");

function log(message, extra = undefined) {
  const prefix = `[${new Date().toISOString()}] [cron:${jobName}]`;
  if (extra === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }

  console.log(`${prefix} ${message}`, extra);
}

async function triggerApiJob() {
  if (!apiBaseUrl) {
    log("API_BASE_URL not set. Running standalone cron task only.");
    return;
  }

  const headers = {
    "Content-Type": "application/json"
  };

  if (cronSecret) {
    headers["x-cron-secret"] = cronSecret;
  }

  const response = await fetch(`${apiBaseUrl}/api/jobs/daily`, {
    method: "POST",
    headers,
    body: JSON.stringify({ trigger: "render-cron" })
  });

  if (!response.ok) {
    throw new Error(`Cron API trigger failed with status ${response.status}`);
  }

  const data = await response.json();
  log("Cron API trigger succeeded", data);
}

async function main() {
  log("Cron run started");

  // Replace this section with your real recurring job logic.
  log("Executing scheduled task...");

  await triggerApiJob();

  log("Cron run finished successfully");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  log("Cron failed", { message });
  process.exit(1);
});
