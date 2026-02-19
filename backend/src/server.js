import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fetchNseAnnouncements, deriveAnnouncementKey, getDefaultDateRange } from "./nseAnnouncements.js";
import { fetchBseAnnouncements, deriveBseAnnouncementKey, getDefaultBseDateRange } from "./bseAnnouncements.js";

const port = Number.parseInt(process.env.PORT ?? "10000", 10);
const appName = process.env.APP_NAME ?? "ai-webapp-api";
const appEnv = process.env.APP_ENV ?? "development";
const corsOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const cronSecret = process.env.CRON_SECRET ?? "";

const nseIndex = process.env.NSE_INDEX ?? "equities";
const nseStoragePath = resolve(process.cwd(), process.env.NSE_STORAGE_FILE ?? "data/nse_announcements.json");
const nseLookbackDays = Number.parseInt(process.env.NSE_LOOKBACK_DAYS ?? "1", 10);
const nseTimeoutMs = Number.parseInt(process.env.NSE_REQUEST_TIMEOUT_MS ?? "30000", 10);
const nseMaxStored = Number.parseInt(process.env.NSE_MAX_STORED ?? "5000", 10);

const bseStoragePath = resolve(process.cwd(), process.env.BSE_STORAGE_FILE ?? "data/bse_announcements.json");
const bseLookbackDays = Number.parseInt(process.env.BSE_LOOKBACK_DAYS ?? "1", 10);
const bseTimeoutMs = Number.parseInt(process.env.BSE_REQUEST_TIMEOUT_MS ?? "30000", 10);
const bseMaxStored = Number.parseInt(process.env.BSE_MAX_STORED ?? "5000", 10);
const bsePageSize = Number.parseInt(process.env.BSE_PAGE_SIZE ?? "100", 10);
const bsePageDelayMs = Number.parseInt(process.env.BSE_PAGE_DELAY_MS ?? "500", 10);

const notes = [];
let noteId = 1;
let cronRunCount = 0;
let lastCronRunAt = null;
let workerHeartbeatCount = 0;
let lastWorkerHeartbeatAt = null;

const stores = {
  NSE: {
    exchange: "NSE",
    storagePath: nseStoragePath,
    maxStored: nseMaxStored,
    announcements: [],
    keys: new Set(),
    loaded: false,
    lastSyncAt: null,
    lastSyncStats: null,
    syncInFlight: null
  },
  BSE: {
    exchange: "BSE",
    storagePath: bseStoragePath,
    maxStored: bseMaxStored,
    announcements: [],
    keys: new Set(),
    loaded: false,
    lastSyncAt: null,
    lastSyncStats: null,
    syncInFlight: null
  }
};

function getAllowedOrigin(originHeader) {
  if (corsOrigins.length === 0) {
    return "*";
  }

  if (originHeader && corsOrigins.includes(originHeader)) {
    return originHeader;
  }

  return null;
}

function applyCorsHeaders(req, res) {
  const allowedOrigin = getAllowedOrigin(req.headers.origin);

  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-cron-secret");
}

function sendJson(req, res, statusCode, payload) {
  applyCorsHeaders(req, res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function log(message, extra = undefined) {
  const prefix = `[${new Date().toISOString()}] [api]`;
  if (extra === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }

  console.log(`${prefix} ${message}`, extra);
}

function normalizePositiveInt(value, fallback) {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function getAnnouncementKey(exchange, announcement) {
  const explicitKey = typeof announcement?.announcementKey === "string" ? announcement.announcementKey.trim() : "";
  if (explicitKey) {
    return explicitKey;
  }

  if (exchange === "BSE") {
    return deriveBseAnnouncementKey(announcement);
  }

  return deriveAnnouncementKey(announcement);
}

function dedupeAnnouncements(exchange, list) {
  const deduped = [];
  const seen = new Set();

  for (const item of list) {
    const key = getAnnouncementKey(exchange, item);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      ...item,
      exchange,
      announcementKey: key
    });
  }

  return deduped;
}

async function loadStore(exchange) {
  const store = stores[exchange];
  if (store.loaded) {
    return;
  }

  try {
    const text = await readFile(store.storagePath, "utf8");
    const parsed = JSON.parse(text);
    const savedAnnouncements = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.announcements)
        ? parsed.announcements
        : [];

    store.announcements = dedupeAnnouncements(exchange, savedAnnouncements);
    store.keys.clear();
    for (const item of store.announcements) {
      store.keys.add(item.announcementKey);
    }

    if (typeof parsed?.lastSyncAt === "string") {
      store.lastSyncAt = parsed.lastSyncAt;
    } else if (exchange === "NSE" && typeof parsed?.lastNseSyncAt === "string") {
      store.lastSyncAt = parsed.lastNseSyncAt;
    } else if (exchange === "BSE" && typeof parsed?.lastBseSyncAt === "string") {
      store.lastSyncAt = parsed.lastBseSyncAt;
    }

    if (parsed?.lastSyncStats && typeof parsed.lastSyncStats === "object") {
      store.lastSyncStats = parsed.lastSyncStats;
    } else if (exchange === "NSE" && parsed?.lastNseSyncStats && typeof parsed.lastNseSyncStats === "object") {
      store.lastSyncStats = parsed.lastNseSyncStats;
    } else if (exchange === "BSE" && parsed?.lastBseSyncStats && typeof parsed.lastBseSyncStats === "object") {
      store.lastSyncStats = parsed.lastBseSyncStats;
    }

    log(`Loaded ${exchange} announcement store`, {
      count: store.announcements.length,
      path: store.storagePath
    });
  } catch (error) {
    const code = error?.code;
    if (code === "ENOENT") {
      log(`${exchange} announcement store not found. Starting fresh.`, { path: store.storagePath });
    } else {
      const message = error instanceof Error ? error.message : "Unknown error";
      log(`Failed to load ${exchange} announcement store. Starting fresh.`, { message, path: store.storagePath });
    }

    store.announcements = [];
    store.keys.clear();
    store.lastSyncAt = null;
    store.lastSyncStats = null;
  }

  store.loaded = true;
}

async function persistStore(exchange) {
  const store = stores[exchange];
  await mkdir(dirname(store.storagePath), { recursive: true });
  await writeFile(
    store.storagePath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        exchange,
        lastSyncAt: store.lastSyncAt,
        lastSyncStats: store.lastSyncStats,
        total: store.announcements.length,
        announcements: store.announcements
      },
      null,
      2
    ),
    "utf8"
  );
}

function trimStore(exchange) {
  const store = stores[exchange];
  const maxStored = normalizePositiveInt(store.maxStored, 5000);

  if (store.announcements.length <= maxStored) {
    return 0;
  }

  const removed = store.announcements.slice(maxStored);
  store.announcements = store.announcements.slice(0, maxStored);

  for (const item of removed) {
    if (item?.announcementKey) {
      store.keys.delete(item.announcementKey);
    }
  }

  return removed.length;
}

async function syncNseAnnouncements(trigger = "manual") {
  const store = stores.NSE;

  if (store.syncInFlight) {
    return store.syncInFlight;
  }

  store.syncInFlight = (async () => {
    await loadStore("NSE");

    const safeLookback = Number.isFinite(nseLookbackDays) ? Math.max(0, nseLookbackDays) : 1;
    const { fromDate, toDate } = getDefaultDateRange(safeLookback);
    const fetched = await fetchNseAnnouncements({
      fromDate,
      toDate,
      index: nseIndex,
      timeoutMs: normalizePositiveInt(nseTimeoutMs, 30_000)
    });

    const insertedAt = new Date().toISOString();
    const newAnnouncements = [];

    for (const announcement of fetched) {
      const key = deriveAnnouncementKey(announcement);
      if (!key || store.keys.has(key)) {
        continue;
      }

      store.keys.add(key);
      newAnnouncements.push({
        ...announcement,
        exchange: "NSE",
        announcementKey: key,
        insertedAt
      });
    }

    if (newAnnouncements.length > 0) {
      store.announcements = [...newAnnouncements, ...store.announcements];
    }

    const trimmedCount = trimStore("NSE");
    store.lastSyncAt = new Date().toISOString();
    store.lastSyncStats = {
      exchange: "NSE",
      trigger,
      index: nseIndex,
      fromDate,
      toDate,
      fetchedCount: fetched.length,
      newCount: newAnnouncements.length,
      trimmedCount,
      totalStored: store.announcements.length,
      syncedAt: store.lastSyncAt
    };

    await persistStore("NSE");
    return store.lastSyncStats;
  })();

  try {
    return await store.syncInFlight;
  } finally {
    store.syncInFlight = null;
  }
}

async function syncBseAnnouncements(trigger = "manual") {
  const store = stores.BSE;

  if (store.syncInFlight) {
    return store.syncInFlight;
  }

  store.syncInFlight = (async () => {
    await loadStore("BSE");

    const safeLookback = Number.isFinite(bseLookbackDays) ? Math.max(0, bseLookbackDays) : 1;
    const { fromDate, toDate } = getDefaultBseDateRange(safeLookback);
    const fetched = await fetchBseAnnouncements({
      fromDate,
      toDate,
      pageSize: normalizePositiveInt(bsePageSize, 100),
      timeoutMs: normalizePositiveInt(bseTimeoutMs, 30_000),
      pageDelayMs: Math.max(0, Number.isFinite(bsePageDelayMs) ? Math.floor(bsePageDelayMs) : 500)
    });

    const insertedAt = new Date().toISOString();
    const newAnnouncements = [];

    for (const announcement of fetched) {
      const key = deriveBseAnnouncementKey(announcement);
      if (!key || store.keys.has(key)) {
        continue;
      }

      store.keys.add(key);
      newAnnouncements.push({
        ...announcement,
        exchange: "BSE",
        announcementKey: key,
        insertedAt
      });
    }

    if (newAnnouncements.length > 0) {
      store.announcements = [...newAnnouncements, ...store.announcements];
    }

    const trimmedCount = trimStore("BSE");
    store.lastSyncAt = new Date().toISOString();
    store.lastSyncStats = {
      exchange: "BSE",
      trigger,
      fromDate,
      toDate,
      pageSize: normalizePositiveInt(bsePageSize, 100),
      fetchedCount: fetched.length,
      newCount: newAnnouncements.length,
      trimmedCount,
      totalStored: store.announcements.length,
      syncedAt: store.lastSyncAt
    };

    await persistStore("BSE");
    return store.lastSyncStats;
  })();

  try {
    return await store.syncInFlight;
  } finally {
    store.syncInFlight = null;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > 1_000_000) {
      throw new Error("Payload too large");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function handleHealth(req, res) {
  sendJson(req, res, 200, {
    ok: true,
    service: appName,
    env: appEnv,
    time: new Date().toISOString()
  });
}

function handleGetNotes(req, res) {
  sendJson(req, res, 200, {
    notes,
    total: notes.length
  });
}

async function handleCreateNote(req, res) {
  const body = await readJsonBody(req);
  const text = String(body.text ?? "").trim();

  if (!text) {
    sendJson(req, res, 400, { error: "Field 'text' is required." });
    return;
  }

  const note = {
    id: noteId,
    text,
    createdAt: new Date().toISOString()
  };

  noteId += 1;
  notes.unshift(note);

  sendJson(req, res, 201, {
    note,
    total: notes.length
  });
}

function matchSymbolFilter(item, exchange, symbolFilter) {
  if (!symbolFilter) {
    return true;
  }

  const query = symbolFilter.toUpperCase();

  if (exchange === "BSE") {
    const scripCode = String(item?.scrip_code ?? "").toUpperCase();
    const companyName = String(item?.company_name ?? "").toUpperCase();
    return scripCode === query || companyName.includes(query);
  }

  const symbol = String(item?.symbol ?? "").toUpperCase();
  const companyName = String(item?.sm_name ?? "").toUpperCase();
  return symbol === query || companyName.includes(query);
}

async function handleGetAnnouncements(req, res, requestUrl) {
  await Promise.all([loadStore("NSE"), loadStore("BSE")]);

  const requestedLimit = Number.parseInt(requestUrl.searchParams.get("limit") ?? "100", 10);
  const limit = Math.min(Math.max(normalizePositiveInt(requestedLimit, 100), 1), 500);
  const exchangeQuery = String(requestUrl.searchParams.get("exchange") ?? "NSE").trim().toUpperCase();
  const symbolFilter = String(requestUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();

  const selectedExchange = exchangeQuery === "BSE" ? "BSE" : exchangeQuery === "ALL" ? "ALL" : "NSE";

  const sourceAnnouncements =
    selectedExchange === "ALL"
      ? [...stores.NSE.announcements, ...stores.BSE.announcements]
      : [...stores[selectedExchange].announcements];

  const filtered = sourceAnnouncements.filter((item) => {
    const exchange = String(item?.exchange ?? selectedExchange).toUpperCase();
    return matchSymbolFilter(item, exchange, symbolFilter);
  });

  const lastSyncAt =
    selectedExchange === "ALL"
      ? { NSE: stores.NSE.lastSyncAt, BSE: stores.BSE.lastSyncAt }
      : stores[selectedExchange].lastSyncAt;

  const lastSyncStats =
    selectedExchange === "ALL"
      ? { NSE: stores.NSE.lastSyncStats, BSE: stores.BSE.lastSyncStats }
      : stores[selectedExchange].lastSyncStats;

  sendJson(req, res, 200, {
    exchange: selectedExchange,
    announcements: filtered.slice(0, limit),
    total: filtered.length,
    limit,
    lastSyncAt,
    lastSyncStats,
    lastNseSyncAt: stores.NSE.lastSyncAt,
    lastNseSyncStats: stores.NSE.lastSyncStats,
    lastBseSyncAt: stores.BSE.lastSyncAt,
    lastBseSyncStats: stores.BSE.lastSyncStats
  });
}

async function handleCronRun(req, res) {
  if (cronSecret) {
    const providedSecret = req.headers["x-cron-secret"];
    if (providedSecret !== cronSecret) {
      sendJson(req, res, 401, { error: "Invalid cron secret." });
      return;
    }
  }

  const body = await readJsonBody(req);
  const trigger = String(body.trigger ?? "unknown");

  cronRunCount += 1;
  lastCronRunAt = new Date().toISOString();

  log("Cron run received", {
    runCount: cronRunCount,
    trigger
  });

  const [nseResult, bseResult] = await Promise.allSettled([
    syncNseAnnouncements(trigger),
    syncBseAnnouncements(trigger)
  ]);

  const responsePayload = {
    ok: nseResult.status === "fulfilled" && bseResult.status === "fulfilled",
    runCount: cronRunCount,
    lastCronRunAt,
    nseSync:
      nseResult.status === "fulfilled"
        ? nseResult.value
        : { error: nseResult.reason instanceof Error ? nseResult.reason.message : "Unknown NSE sync error" },
    bseSync:
      bseResult.status === "fulfilled"
        ? bseResult.value
        : { error: bseResult.reason instanceof Error ? bseResult.reason.message : "Unknown BSE sync error" }
  };

  if (responsePayload.ok) {
    sendJson(req, res, 200, responsePayload);
    return;
  }

  log("Cron sync finished with errors", responsePayload);
  sendJson(req, res, 502, responsePayload);
}

async function handleWorkerHeartbeat(req, res) {
  if (cronSecret) {
    const providedSecret = req.headers["x-cron-secret"];
    if (providedSecret !== cronSecret) {
      sendJson(req, res, 401, { error: "Invalid heartbeat secret." });
      return;
    }
  }

  workerHeartbeatCount += 1;
  lastWorkerHeartbeatAt = new Date().toISOString();

  sendJson(req, res, 200, {
    ok: true,
    workerHeartbeatCount,
    lastWorkerHeartbeatAt
  });
}

async function handleStatus(req, res) {
  await Promise.all([loadStore("NSE"), loadStore("BSE")]);

  sendJson(req, res, 200, {
    service: appName,
    env: appEnv,
    serverTime: new Date().toISOString(),
    notesCount: notes.length,
    cronRunCount,
    lastCronRunAt,
    workerHeartbeatCount,
    lastWorkerHeartbeatAt,
    nseAnnouncementsCount: stores.NSE.announcements.length,
    bseAnnouncementsCount: stores.BSE.announcements.length,
    lastNseSyncAt: stores.NSE.lastSyncAt,
    lastNseSyncStats: stores.NSE.lastSyncStats,
    lastBseSyncAt: stores.BSE.lastSyncAt,
    lastBseSyncStats: stores.BSE.lastSyncStats
  });
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (method === "OPTIONS") {
    applyCorsHeaders(req, res);
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    if (method === "GET" && requestUrl.pathname === "/") {
      sendJson(req, res, 200, {
        message: "API is running",
        docs: [
          "GET /health",
          "GET /api/health",
          "GET /api/status",
          "GET/POST /api/notes",
          "GET /api/notifications/announcements?exchange=NSE|BSE|ALL&limit=100&symbol=TCS",
          "POST /api/jobs/daily"
        ]
      });
      return;
    }

    if (method === "GET" && (requestUrl.pathname === "/health" || requestUrl.pathname === "/api/health")) {
      handleHealth(req, res);
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/api/status") {
      await handleStatus(req, res);
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/api/notes") {
      handleGetNotes(req, res);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/notes") {
      await handleCreateNote(req, res);
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/api/notifications/announcements") {
      await handleGetAnnouncements(req, res, requestUrl);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/jobs/daily") {
      await handleCronRun(req, res);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/internal/worker-heartbeat") {
      await handleWorkerHeartbeat(req, res);
      return;
    }

    sendJson(req, res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("Request failed", { method, path: requestUrl.pathname, message });
    sendJson(req, res, 400, { error: message });
  }
});

Promise.all([loadStore("NSE"), loadStore("BSE")]).catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  log("Announcement stores warm-up failed", { message });
});

server.listen(port, "0.0.0.0", () => {
  log(`Listening on port ${port}`);
});

process.on("SIGTERM", () => {
  log("SIGTERM received, shutting down");
  server.close(() => process.exit(0));
});
