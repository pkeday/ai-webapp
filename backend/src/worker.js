const pollIntervalSeconds = Number.parseInt(process.env.WORKER_INTERVAL_SECONDS ?? "20", 10);
const heartbeatIntervalSeconds = Number.parseInt(process.env.WORKER_HEARTBEAT_SECONDS ?? "20", 10);
const requestTimeoutMs = Number.parseInt(process.env.WORKER_REQUEST_TIMEOUT_MS ?? "180000", 10);
const loopDelayMs = Number.parseInt(process.env.WORKER_LOOP_DELAY_MS ?? "200", 10);
const cronSecret = process.env.CRON_SECRET ?? "";
const enableLegacyJobEndpoints = false;
const defaultChunkSize = Number.parseInt(process.env.AI_ASYNC_CHUNK_SIZE ?? "10", 10);
const defaultMaxLoops = Number.parseInt(process.env.AI_ASYNC_MAX_LOOPS ?? "120", 10);
const configuredWorkerId = (process.env.WORKER_ID ?? "").trim();
const allowedJobTypes = (process.env.WORKER_ALLOWED_JOB_TYPES ?? "ai-classification")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);
const workerId = configuredWorkerId || `worker-${process.pid}`;

function normalizeBaseUrl(value) {
  const trimmed = String(value ?? "").trim().replace(/\/$/, "");
  if (!trimmed) {
    return "";
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const apiBaseUrl = normalizeBaseUrl(process.env.API_BASE_URL ?? "");

function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function normalizePositiveInt(value, fallback) {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function clampPositiveInt(value, fallback, min, max) {
  const normalized = normalizePositiveInt(value, fallback);
  return Math.min(max, Math.max(min, normalized));
}

function normalizeJobId(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseOptionalPositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function extractErrorMessage(error) {
  if (error instanceof Error) {
    return error.message || "Unknown error";
  }
  return String(error || "Unknown error");
}

function log(message, extra = undefined) {
  const prefix = `[${new Date().toISOString()}] [worker]`;
  if (extra === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`, extra);
}

function sleep(ms) {
  const delay = Math.max(0, normalizePositiveInt(ms, 0));
  if (delay === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function apiRequest(path, body = null) {
  if (!apiBaseUrl) {
    throw new Error("API_BASE_URL not set.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, Math.max(1000, normalizePositiveInt(requestTimeoutMs, 180000)));

  const headers = {
    "Content-Type": "application/json"
  };
  if (cronSecret) {
    headers["x-cron-secret"] = cronSecret;
  }

  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: "POST",
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal
    });

    const responseText = await response.text();
    let data = null;
    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch (_error) {
        data = { raw: responseText };
      }
    }

    if (!response.ok) {
      const errorMessage = normalizeText(data?.error || data?.message || responseText) || `HTTP ${response.status}`;
      throw new Error(`${path} failed with status ${response.status}: ${errorMessage}`);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendWorkerHeartbeat() {
  await apiRequest("/api/internal/worker-heartbeat", {
    trigger: "background-worker",
    workerId
  });
}

async function claimJob() {
  const data = await apiRequest("/api/internal/jobs/claim", {
    workerId,
    types: allowedJobTypes
  });
  return data?.job ?? null;
}

async function sendJobHeartbeat(jobId) {
  const normalizedId = normalizeJobId(jobId);
  if (!normalizedId) {
    return null;
  }
  return apiRequest(`/api/internal/jobs/${normalizedId}/heartbeat`, { workerId });
}

async function markJobComplete(jobId, result) {
  const normalizedId = normalizeJobId(jobId);
  if (!normalizedId) {
    return null;
  }
  return apiRequest(`/api/internal/jobs/${normalizedId}/complete`, { workerId, result });
}

async function markJobFailed(jobId, errorMessage, result = null) {
  const normalizedId = normalizeJobId(jobId);
  if (!normalizedId) {
    return null;
  }
  return apiRequest(`/api/internal/jobs/${normalizedId}/fail`, {
    workerId,
    error: normalizeText(errorMessage) || "Background worker failure",
    result
  });
}

function buildChunkTrigger(baseTrigger, jobId, loopIndex) {
  const seed = normalizeText(baseTrigger) || "worker-ai";
  return `${seed}:job-${jobId}:chunk-${loopIndex}`;
}

function normalizeJobPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload;
}

async function runAiClassificationChunk(body) {
  const data = await apiRequest("/api/internal/ai/run-chunk", body);
  return data && typeof data === "object" ? data : {};
}

async function processAiClassificationJob(job) {
  const jobId = normalizeJobId(job?.id);
  if (!jobId) {
    throw new Error("Invalid job ID");
  }

  const payload = normalizeJobPayload(job?.payload);
  const mode = normalizeText(payload.mode) || "ai-only";
  const trigger = normalizeText(payload.trigger) || "worker-ai";
  const forceEnabled = toBoolean(payload.forceEnabled, true);
  const chunkSize = clampPositiveInt(Number.parseInt(String(payload.chunkSize ?? ""), 10), defaultChunkSize, 1, 50);
  const maxLoops = clampPositiveInt(Number.parseInt(String(payload.maxLoops ?? ""), 10), defaultMaxLoops, 1, 500);
  const targetSuccessCount = parseOptionalPositiveInt(payload.targetSuccessCount);
  const scanRecentWhenNoTouched = toBoolean(payload.scanRecentWhenNoTouched, true);
  const recentCandidatePool = parseOptionalPositiveInt(payload.recentCandidatePool);
  const touchedDedupKeys = Array.isArray(payload.touchedDedupKeys) ? payload.touchedDedupKeys : [];

  const startedAt = new Date().toISOString();
  const aggregate = {
    mode,
    trigger,
    chunkSize,
    maxLoops,
    targetSuccessCount,
    loopsRun: 0,
    totalProcessed: 0,
    totalSuccess: 0,
    totalFailure: 0,
    finalReason: "",
    startedAt,
    completedAt: null,
    chunks: []
  };

  let lastHeartbeatAt = 0;
  const heartbeatEveryMs = Math.max(1000, normalizePositiveInt(heartbeatIntervalSeconds, 20) * 1000);
  for (let loopIndex = 1; loopIndex <= maxLoops; loopIndex += 1) {
    const now = Date.now();
    if (now - lastHeartbeatAt >= heartbeatEveryMs) {
      await sendJobHeartbeat(jobId);
      lastHeartbeatAt = now;
    }

    const chunkResponse = await runAiClassificationChunk({
      trigger: buildChunkTrigger(trigger, jobId, loopIndex),
      forceEnabled,
      maxItems: chunkSize,
      scanRecentWhenNoTouched,
      recentCandidatePool,
      touchedDedupKeys
    });

    const ai = chunkResponse?.aiClassification && typeof chunkResponse.aiClassification === "object" ? chunkResponse.aiClassification : {};
    const processedCount = normalizePositiveInt(Number.parseInt(String(ai.processedCount ?? "0"), 10), 0);
    const successCount = normalizePositiveInt(Number.parseInt(String(ai.successCount ?? "0"), 10), 0);
    const failureCount = normalizePositiveInt(Number.parseInt(String(ai.failureCount ?? "0"), 10), 0);
    const skipped = ai?.skipped === true;
    const reason = normalizeText(ai?.reason);

    aggregate.loopsRun += 1;
    aggregate.totalProcessed += processedCount;
    aggregate.totalSuccess += successCount;
    aggregate.totalFailure += failureCount;
    aggregate.chunks.push({
      loop: loopIndex,
      processedCount,
      successCount,
      failureCount,
      skipped,
      reason: reason || null
    });

    if (targetSuccessCount && aggregate.totalSuccess >= targetSuccessCount) {
      aggregate.finalReason = "target-success-count-reached";
      break;
    }

    if (processedCount === 0 || skipped) {
      aggregate.finalReason = reason || (skipped ? "chunk-skipped" : "no-new-ai-candidates");
      break;
    }

    if (loopIndex === maxLoops) {
      aggregate.finalReason = "max-loops-reached";
      break;
    }

    await sleep(loopDelayMs);
  }

  aggregate.completedAt = new Date().toISOString();
  if (!aggregate.finalReason) {
    aggregate.finalReason = "completed";
  }

  return aggregate;
}

async function processJob(job) {
  const jobId = normalizeJobId(job?.id);
  const jobType = normalizeText(job?.jobType || job?.job_type).toLowerCase();
  if (!jobId) {
    throw new Error("Claimed job without valid id");
  }
  if (!jobType) {
    throw new Error(`Job ${jobId} missing job type`);
  }

  log("Processing job", { jobId, jobType });

  if (jobType === "ai-classification") {
    return processAiClassificationJob(job);
  }

  throw new Error(`Unsupported job type: ${jobType}`);
}

async function runLoop() {
  if (!enableLegacyJobEndpoints) {
    log("Worker disabled by configuration", {
      reason: "cron-only-pipeline",
      enableAction: "Set `enableLegacyJobEndpoints = true` in backend/src/worker.js"
    });
    while (true) {
      await sleep(60_000);
    }
  }

  if (!apiBaseUrl) {
    throw new Error("API_BASE_URL is required for worker");
  }

  const idleDelayMs = Math.max(1000, normalizePositiveInt(pollIntervalSeconds, 20) * 1000);
  log("Worker started", {
    workerId,
    pollIntervalSeconds: normalizePositiveInt(pollIntervalSeconds, 20),
    heartbeatIntervalSeconds: normalizePositiveInt(heartbeatIntervalSeconds, 20),
    allowedJobTypes
  });

  while (true) {
    let claimedJob = null;
    try {
      await sendWorkerHeartbeat();
      claimedJob = await claimJob();
      if (!claimedJob) {
        await sleep(idleDelayMs);
        continue;
      }

      const result = await processJob(claimedJob);
      await markJobComplete(claimedJob.id, result);
      log("Job completed", {
        jobId: claimedJob.id,
        jobType: claimedJob.jobType ?? claimedJob.job_type,
        loopsRun: result?.loopsRun ?? null,
        totalProcessed: result?.totalProcessed ?? null,
        totalSuccess: result?.totalSuccess ?? null,
        totalFailure: result?.totalFailure ?? null,
        finalReason: result?.finalReason ?? null
      });
    } catch (error) {
      const message = extractErrorMessage(error);
      log("Worker loop error", {
        message,
        jobId: claimedJob?.id ?? null
      });

      if (claimedJob?.id) {
        try {
          await markJobFailed(claimedJob.id, message);
        } catch (markError) {
          log("Failed to mark job as failed", {
            jobId: claimedJob.id,
            message: extractErrorMessage(markError)
          });
        }
      }

      await sleep(idleDelayMs);
    }
  }
}

runLoop().catch((error) => {
  const message = extractErrorMessage(error);
  log("Fatal worker error", { message });
  process.exit(1);
});
