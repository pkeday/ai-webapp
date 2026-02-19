const intervalSeconds = Number.parseInt(process.env.WORKER_INTERVAL_SECONDS ?? "60", 10);
const cronSecret = process.env.CRON_SECRET ?? "";

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
  const prefix = `[${new Date().toISOString()}] [worker]`;
  if (extra === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }

  console.log(`${prefix} ${message}`, extra);
}

async function sendHeartbeat() {
  if (!apiBaseUrl) {
    log("API_BASE_URL not set. Skipping heartbeat API call.");
    return;
  }

  const headers = {
    "Content-Type": "application/json"
  };

  if (cronSecret) {
    headers["x-cron-secret"] = cronSecret;
  }

  const response = await fetch(`${apiBaseUrl}/api/internal/worker-heartbeat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ trigger: "worker-loop" })
  });

  if (!response.ok) {
    throw new Error(`Heartbeat failed with status ${response.status}`);
  }

  const data = await response.json();
  log("Heartbeat sent", data);
}

async function runLoop() {
  log(`Started. Interval: ${intervalSeconds}s`);

  while (true) {
    try {
      await sendHeartbeat();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      log("Heartbeat error", { message });
    }

    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

runLoop().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  log("Fatal worker error", { message });
  process.exit(1);
});
