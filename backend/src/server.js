import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fetchNseAnnouncements, deriveAnnouncementKey, getDefaultDateRange } from "./nseAnnouncements.js";
import {
  fetchBseAnnouncements,
  deriveBseAnnouncementKey,
  getDefaultBseDateRange,
  fetchBseIsinMap,
  enrichBseAnnouncementsWithIsin
} from "./bseAnnouncements.js";

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
const combinedStoragePath = resolve(process.cwd(), process.env.COMBINED_STORAGE_FILE ?? "data/combined_announcements.json");
const combinedMaxStored = Number.parseInt(process.env.COMBINED_MAX_STORED ?? "10000", 10);

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
  },
  COMBINED: {
    exchange: "COMBINED",
    storagePath: combinedStoragePath,
    maxStored: combinedMaxStored,
    announcements: [],
    keys: new Set(),
    loaded: false,
    lastSyncAt: null,
    lastSyncStats: null,
    syncInFlight: null,
    sourceFingerprint: ""
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

function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function normalizeComparableText(value) {
  const normalized = normalizeText(value).toUpperCase();
  if (!normalized) {
    return "";
  }

  return normalized.replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeIsin(value) {
  const normalized = normalizeText(value).toUpperCase();
  return normalized || null;
}

function parseTimestampToMillis(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractDateKeyFromRaw(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const parsedMillis = parseTimestampToMillis(normalized);
  if (parsedMillis !== null) {
    return new Date(parsedMillis).toISOString().slice(0, 10);
  }

  const ddMmYyyyMatch = normalized.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (ddMmYyyyMatch) {
    return `${ddMmYyyyMatch[3]}-${ddMmYyyyMatch[2]}-${ddMmYyyyMatch[1]}`;
  }

  const yyyyMmDdMatch = normalized.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (yyyyMmDdMatch) {
    return `${yyyyMmDdMatch[1]}-${yyyyMmDdMatch[2]}-${yyyyMmDdMatch[3]}`;
  }

  return null;
}

function getExchangeValue(value) {
  const normalized = normalizeText(value).toUpperCase();
  return normalized || "NSE";
}

function getAnnouncementTimestampRaw(item, exchange) {
  if (exchange === "BSE") {
    return normalizeText(item?.datetime || item?.news_date || item?.insertedAt || item?.scraped_at || "-");
  }

  return normalizeText(item?.an_dt || item?.dt || item?.exchdisstime || item?.insertedAt || "-");
}

function getAnnouncementDateKey(item, exchange) {
  return extractDateKeyFromRaw(getAnnouncementTimestampRaw(item, exchange));
}

function getAnnouncementAttachmentUrl(item, exchange) {
  if (exchange === "BSE") {
    return normalizeText(item?.attachment_url || item?.attachment_url_fallback || "");
  }

  return normalizeText(item?.attchmntfile || "");
}

function getAttachmentFileFromUrl(urlValue) {
  const normalized = normalizeText(urlValue);
  if (!normalized) {
    return "";
  }

  const withoutQuery = normalized.split("?")[0];
  const parts = withoutQuery.split("/").filter(Boolean);
  return normalizeText(parts[parts.length - 1]);
}

function getAnnouncementAttachmentKey(item, exchange) {
  if (exchange === "BSE") {
    const direct = normalizeText(item?.attachment_file);
    if (direct) {
      return direct.toUpperCase();
    }
  }

  const fromUrl = getAttachmentFileFromUrl(getAnnouncementAttachmentUrl(item, exchange));
  return fromUrl ? fromUrl.toUpperCase() : "";
}

function getAnnouncementSubject(item, exchange) {
  if (exchange === "BSE") {
    return normalizeComparableText(item?.subject || item?.news_body || item?.category || item?.subcategory);
  }

  return normalizeComparableText(item?.desc || item?.attchmnttext);
}

function getAnnouncementSymbol(item, exchange) {
  if (exchange === "BSE") {
    return normalizeText(item?.scrip_code || "-");
  }

  return normalizeText(item?.symbol || "-");
}

function getAnnouncementCompany(item, exchange) {
  if (exchange === "BSE") {
    return normalizeText(item?.company_name || "-");
  }

  return normalizeText(item?.sm_name || "-");
}

function getAnnouncementType(item, exchange) {
  if (exchange === "BSE") {
    return normalizeText(item?.category || item?.subcategory || item?.subject || "-");
  }

  return normalizeText(item?.desc || "-");
}

function getAnnouncementIsin(item, exchange) {
  if (exchange === "BSE") {
    return normalizeIsin(item?.isin);
  }

  return normalizeIsin(item?.sm_isin);
}

function mergeSortedUnique(values) {
  const unique = Array.from(new Set(values.filter(Boolean)));
  return unique.sort();
}

function getAnnouncementKey(exchange, announcement) {
  const explicitKey = typeof announcement?.announcementKey === "string" ? announcement.announcementKey.trim() : "";
  if (explicitKey) {
    return explicitKey;
  }

  if (exchange === "COMBINED") {
    const mergedKey =
      typeof announcement?.mergedAnnouncementKey === "string" ? announcement.mergedAnnouncementKey.trim() : "";
    return mergedKey || null;
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
    const normalizedExchange = exchange === "COMBINED" ? getExchangeValue(item?.exchange ?? "BSE+NSE") : exchange;
    deduped.push({
      ...item,
      exchange: normalizedExchange,
      announcementKey: key
    });
  }

  return deduped;
}

function deriveCombinedDedupeKey(item, exchange) {
  const isin = getAnnouncementIsin(item, exchange);
  if (!isin) {
    return null;
  }

  const dateKey = getAnnouncementDateKey(item, exchange);
  const attachmentKey = getAnnouncementAttachmentKey(item, exchange);
  const subjectKey = getAnnouncementSubject(item, exchange);

  if (dateKey && attachmentKey) {
    return `ISIN:${isin}|DATE:${dateKey}|ATTACH:${attachmentKey}`;
  }

  if (dateKey && subjectKey) {
    return `ISIN:${isin}|DATE:${dateKey}|SUBJECT:${subjectKey}`;
  }

  if (attachmentKey) {
    return `ISIN:${isin}|ATTACH:${attachmentKey}`;
  }

  if (subjectKey) {
    return `ISIN:${isin}|SUBJECT:${subjectKey}`;
  }

  return null;
}

function getSourceAnnouncementKey(item, exchange) {
  const baseKey = getAnnouncementKey(exchange, item);
  if (baseKey) {
    return `${exchange}:${baseKey}`;
  }

  const timestamp = getAnnouncementTimestampRaw(item, exchange);
  const symbol = getAnnouncementSymbol(item, exchange);
  const subject = getAnnouncementSubject(item, exchange);
  if (!timestamp && !symbol && !subject) {
    return null;
  }

  return `${exchange}:FALLBACK:${timestamp}|${symbol}|${subject}`;
}

function buildCombinedSourceFingerprint() {
  return [
    stores.NSE.lastSyncAt ?? "none",
    stores.BSE.lastSyncAt ?? "none",
    String(stores.NSE.announcements.length),
    String(stores.BSE.announcements.length)
  ].join("|");
}

function buildNseListingByIsin() {
  const nseListingByIsin = new Map();

  // NSE store is newest-first, so first seen mapping is the freshest.
  for (const item of stores.NSE.announcements) {
    const isin = getAnnouncementIsin(item, "NSE");
    if (!isin || nseListingByIsin.has(isin)) {
      continue;
    }

    const symbol = getAnnouncementSymbol(item, "NSE");
    const company = getAnnouncementCompany(item, "NSE");

    nseListingByIsin.set(isin, {
      symbol: symbol || null,
      company: company || null
    });
  }

  return nseListingByIsin;
}

function buildCombinedAnnouncements() {
  const sourceItems = [...stores.NSE.announcements, ...stores.BSE.announcements];
  const nseListingByIsin = buildNseListingByIsin();
  const sourceSeen = new Set();
  const crossExchangeMap = new Map();
  const combined = [];

  let sourceDedupedCount = 0;
  let crossExchangeMergedCount = 0;
  let missingIsinCount = 0;
  let withIsinCount = 0;

  for (const item of sourceItems) {
    const exchange = getExchangeValue(item?.exchange ?? "NSE");
    if (exchange !== "NSE" && exchange !== "BSE") {
      continue;
    }

    const sourceKey = getSourceAnnouncementKey(item, exchange);
    if (!sourceKey || sourceSeen.has(sourceKey)) {
      sourceDedupedCount += 1;
      continue;
    }

    sourceSeen.add(sourceKey);

    const isin = getAnnouncementIsin(item, exchange);
    if (isin) {
      withIsinCount += 1;
    } else {
      missingIsinCount += 1;
    }

    const timestamp = getAnnouncementTimestampRaw(item, exchange);
    const symbol = getAnnouncementSymbol(item, exchange);
    const company = getAnnouncementCompany(item, exchange);
    const type = getAnnouncementType(item, exchange);
    const attachmentUrl = getAnnouncementAttachmentUrl(item, exchange) || null;
    const sourceAnnouncementKey = getAnnouncementKey(exchange, item);
    const sortTimestampMs = parseTimestampToMillis(timestamp) ?? parseTimestampToMillis(item?.insertedAt) ?? 0;
    const nseListing = isin ? nseListingByIsin.get(isin) ?? null : null;
    const displaySymbol = nseListing?.symbol || symbol || "-";
    const displayCompany = nseListing?.company || company || "-";

    const sourceAnnouncement = {
      sourceKey,
      exchange,
      announcementKey: sourceAnnouncementKey,
      timestamp,
      symbol,
      company,
      displaySymbol,
      displayCompany,
      type,
      attachmentUrl,
      isin
    };

    const dedupeKey = deriveCombinedDedupeKey(item, exchange);
    const existing = dedupeKey ? crossExchangeMap.get(dedupeKey) : null;

    if (existing && !existing.exchanges.includes(exchange)) {
      existing.sourceAnnouncements.push(sourceAnnouncement);
      existing.exchanges = mergeSortedUnique([...existing.exchanges, exchange]);
      existing.exchange = existing.exchanges.length > 1 ? "BSE+NSE" : existing.exchanges[0];
      existing.mergedFromCount = existing.sourceAnnouncements.length;
      existing.attachment_url = existing.attachment_url || attachmentUrl;
      existing.isin = existing.isin || isin;
      existing.hasNseListing = existing.hasNseListing || Boolean(nseListing);

      if (sortTimestampMs > existing.sortTimestampMs) {
        existing.sortTimestampMs = sortTimestampMs;
        existing.timestamp = timestamp;
        existing.symbol = displaySymbol;
        existing.company = displayCompany;
        existing.type = type;
        if (attachmentUrl) {
          existing.attachment_url = attachmentUrl;
        }
      }

      if (nseListing) {
        existing.symbol = nseListing.symbol || existing.symbol;
        existing.company = nseListing.company || existing.company;
      }

      crossExchangeMergedCount += 1;
      continue;
    }

    const mergedAnnouncementKey = dedupeKey && !crossExchangeMap.has(dedupeKey) ? dedupeKey : `SOURCE:${sourceKey}`;
    const record = {
      exchange,
      exchanges: [exchange],
      mergedFromCount: 1,
      mergedAnnouncementKey,
      announcementKey: mergedAnnouncementKey,
      dedupeStrategy: dedupeKey ? "isin+date+(attachment|subject)" : "source-key-fallback",
      isin,
      timestamp: timestamp || "-",
      symbol: displaySymbol,
      company: displayCompany,
      hasNseListing: Boolean(nseListing),
      type: type || "-",
      attachment_url: attachmentUrl,
      sourceAnnouncements: [sourceAnnouncement],
      insertedAt: item?.insertedAt ?? item?.scraped_at ?? new Date().toISOString(),
      sortTimestampMs
    };

    combined.push(record);

    if (dedupeKey && !crossExchangeMap.has(dedupeKey)) {
      crossExchangeMap.set(dedupeKey, record);
    }
  }

  combined.sort((left, right) => {
    const sortDiff = (right.sortTimestampMs ?? 0) - (left.sortTimestampMs ?? 0);
    if (sortDiff !== 0) {
      return sortDiff;
    }

    return String(right.insertedAt ?? "").localeCompare(String(left.insertedAt ?? ""));
  });

  const mergedRecordCount = combined.reduce((count, item) => count + (item.mergedFromCount > 1 ? 1 : 0), 0);

  return {
    announcements: combined,
    stats: {
      inputCount: sourceItems.length,
      uniqueSourceCount: sourceSeen.size,
      sourceDedupedCount,
      crossExchangeMergedCount,
      mergedRecordCount,
      combinedCount: combined.length,
      withIsinCount,
      missingIsinCount
    }
  };
}

async function refreshCombinedAnnouncements(trigger = "manual", force = false) {
  const store = stores.COMBINED;

  if (store.syncInFlight) {
    return store.syncInFlight;
  }

  store.syncInFlight = (async () => {
    await Promise.all([loadStore("NSE"), loadStore("BSE")]);

    const fingerprint = buildCombinedSourceFingerprint();
    if (!force && store.loaded && store.sourceFingerprint === fingerprint) {
      return store.lastSyncStats ?? {
        exchange: "COMBINED",
        trigger,
        dedupeRule: "ISIN + date + (attachment or subject)",
        totalStored: store.announcements.length,
        syncedAt: store.lastSyncAt
      };
    }

    const result = buildCombinedAnnouncements();
    store.announcements = result.announcements;
    store.keys = new Set(store.announcements.map((item) => item.mergedAnnouncementKey));

    const trimmedCount = trimStore("COMBINED");
    store.lastSyncAt = new Date().toISOString();
    store.lastSyncStats = {
      exchange: "COMBINED",
      trigger,
      dedupeRule: "ISIN + date + (attachment or subject)",
      inputCount: result.stats.inputCount,
      uniqueSourceCount: result.stats.uniqueSourceCount,
      sourceDedupedCount: result.stats.sourceDedupedCount,
      crossExchangeMergedCount: result.stats.crossExchangeMergedCount,
      mergedRecordCount: result.stats.mergedRecordCount,
      withIsinCount: result.stats.withIsinCount,
      missingIsinCount: result.stats.missingIsinCount,
      totalStored: store.announcements.length,
      trimmedCount,
      syncedAt: store.lastSyncAt
    };
    store.sourceFingerprint = fingerprint;
    store.loaded = true;

    await persistStore("COMBINED");
    return store.lastSyncStats;
  })();

  try {
    return await store.syncInFlight;
  } finally {
    store.syncInFlight = null;
  }
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
    } else if (exchange === "COMBINED" && typeof parsed?.lastCombinedSyncAt === "string") {
      store.lastSyncAt = parsed.lastCombinedSyncAt;
    }

    if (parsed?.lastSyncStats && typeof parsed.lastSyncStats === "object") {
      store.lastSyncStats = parsed.lastSyncStats;
    } else if (exchange === "NSE" && parsed?.lastNseSyncStats && typeof parsed.lastNseSyncStats === "object") {
      store.lastSyncStats = parsed.lastNseSyncStats;
    } else if (exchange === "BSE" && parsed?.lastBseSyncStats && typeof parsed.lastBseSyncStats === "object") {
      store.lastSyncStats = parsed.lastBseSyncStats;
    } else if (exchange === "COMBINED" && parsed?.lastCombinedSyncStats && typeof parsed.lastCombinedSyncStats === "object") {
      store.lastSyncStats = parsed.lastCombinedSyncStats;
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
  const legacySyncFields =
    exchange === "NSE"
      ? {
          lastNseSyncAt: store.lastSyncAt,
          lastNseSyncStats: store.lastSyncStats
        }
      : exchange === "BSE"
        ? {
            lastBseSyncAt: store.lastSyncAt,
            lastBseSyncStats: store.lastSyncStats
          }
        : exchange === "COMBINED"
          ? {
              lastCombinedSyncAt: store.lastSyncAt,
              lastCombinedSyncStats: store.lastSyncStats
            }
          : {};

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
        announcements: store.announcements,
        ...legacySyncFields
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
    const effectiveTimeoutMs = normalizePositiveInt(bseTimeoutMs, 30_000);
    const { fromDate, toDate } = getDefaultBseDateRange(safeLookback);
    const fetched = await fetchBseAnnouncements({
      fromDate,
      toDate,
      pageSize: normalizePositiveInt(bsePageSize, 100),
      timeoutMs: effectiveTimeoutMs,
      pageDelayMs: Math.max(0, Number.isFinite(bsePageDelayMs) ? Math.floor(bsePageDelayMs) : 500)
    });
    let fetchedWithIsin = fetched;
    let isinMapSize = 0;
    let fetchedWithIsinCount = 0;
    let storedWithIsinCount = 0;

    try {
      const isinByScripCode = await fetchBseIsinMap({
        timeoutMs: effectiveTimeoutMs
      });
      isinMapSize = isinByScripCode.size;

      const enrichedFetched = enrichBseAnnouncementsWithIsin(fetched, isinByScripCode);
      fetchedWithIsin = enrichedFetched.announcements;
      fetchedWithIsinCount = enrichedFetched.withIsinCount;

      const enrichedStored = enrichBseAnnouncementsWithIsin(store.announcements, isinByScripCode);
      store.announcements = enrichedStored.announcements;
      storedWithIsinCount = enrichedStored.withIsinCount;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown BSE ISIN map error";
      log("BSE ISIN enrichment skipped", { message });

      const enrichedFetched = enrichBseAnnouncementsWithIsin(fetched, null);
      fetchedWithIsin = enrichedFetched.announcements;
      fetchedWithIsinCount = enrichedFetched.withIsinCount;

      const enrichedStored = enrichBseAnnouncementsWithIsin(store.announcements, null);
      store.announcements = enrichedStored.announcements;
      storedWithIsinCount = enrichedStored.withIsinCount;
    }

    const insertedAt = new Date().toISOString();
    const newAnnouncements = [];

    for (const announcement of fetchedWithIsin) {
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
      fetchedCount: fetchedWithIsin.length,
      newCount: newAnnouncements.length,
      isinMapSize,
      fetchedWithIsinCount,
      fetchedMissingIsinCount: Math.max(0, fetchedWithIsin.length - fetchedWithIsinCount),
      storedWithIsinCount,
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

  if (exchange === "BSE+NSE" || exchange === "COMBINED") {
    const symbol = String(item?.symbol ?? "").toUpperCase();
    const companyName = String(item?.company ?? "").toUpperCase();
    const isin = String(item?.isin ?? "").toUpperCase();

    if (symbol === query || companyName.includes(query) || isin === query) {
      return true;
    }

    const sourceAnnouncements = Array.isArray(item?.sourceAnnouncements) ? item.sourceAnnouncements : [];
    return sourceAnnouncements.some((source) => {
      const sourceSymbol = String(source?.symbol ?? "").toUpperCase();
      const sourceCompany = String(source?.company ?? "").toUpperCase();
      const sourceIsin = String(source?.isin ?? "").toUpperCase();
      return sourceSymbol === query || sourceCompany.includes(query) || sourceIsin === query;
    });
  }

  if (exchange === "BSE") {
    const scripCode = String(item?.scrip_code ?? "").toUpperCase();
    const companyName = String(item?.company_name ?? "").toUpperCase();
    const isin = String(item?.isin ?? "").toUpperCase();
    return scripCode === query || companyName.includes(query) || isin === query;
  }

  const symbol = String(item?.symbol ?? "").toUpperCase();
  const companyName = String(item?.sm_name ?? "").toUpperCase();
  const isin = String(item?.sm_isin ?? "").toUpperCase();
  return symbol === query || companyName.includes(query) || isin === query;
}

async function handleGetAnnouncements(req, res, requestUrl) {
  await Promise.all([loadStore("NSE"), loadStore("BSE")]);

  const requestedLimit = Number.parseInt(requestUrl.searchParams.get("limit") ?? "100", 10);
  const limit = Math.min(Math.max(normalizePositiveInt(requestedLimit, 100), 1), 500);
  const exchangeQuery = String(requestUrl.searchParams.get("exchange") ?? "NSE")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
  const symbolFilter = String(requestUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();

  const selectedExchange =
    exchangeQuery === "BSE"
      ? "BSE"
      : exchangeQuery === "ALL"
        ? "ALL"
        : exchangeQuery === "BSE+NSE" || exchangeQuery === "COMBINED"
          ? "BSE+NSE"
          : "NSE";

  if (selectedExchange === "BSE+NSE") {
    await refreshCombinedAnnouncements("api-request");
  }

  const sourceAnnouncements =
    selectedExchange === "ALL"
      ? [...stores.NSE.announcements, ...stores.BSE.announcements]
      : selectedExchange === "BSE+NSE"
        ? [...stores.COMBINED.announcements]
        : [...stores[selectedExchange].announcements];

  const filtered = sourceAnnouncements.filter((item) => {
    const filterExchange =
      selectedExchange === "BSE+NSE" ? "COMBINED" : getExchangeValue(item?.exchange ?? selectedExchange);
    return matchSymbolFilter(item, filterExchange, symbolFilter);
  });

  const lastSyncAt =
    selectedExchange === "ALL"
      ? { NSE: stores.NSE.lastSyncAt, BSE: stores.BSE.lastSyncAt }
      : selectedExchange === "BSE+NSE"
        ? stores.COMBINED.lastSyncAt
        : stores[selectedExchange].lastSyncAt;

  const lastSyncStats =
    selectedExchange === "ALL"
      ? { NSE: stores.NSE.lastSyncStats, BSE: stores.BSE.lastSyncStats }
      : selectedExchange === "BSE+NSE"
        ? stores.COMBINED.lastSyncStats
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
    lastBseSyncStats: stores.BSE.lastSyncStats,
    lastCombinedSyncAt: stores.COMBINED.lastSyncAt,
    lastCombinedSyncStats: stores.COMBINED.lastSyncStats
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
  const combinedResult = await refreshCombinedAnnouncements(trigger)
    .then((value) => ({ status: "fulfilled", value }))
    .catch((reason) => ({ status: "rejected", reason }));

  const responsePayload = {
    ok:
      nseResult.status === "fulfilled" &&
      bseResult.status === "fulfilled" &&
      combinedResult.status === "fulfilled",
    runCount: cronRunCount,
    lastCronRunAt,
    nseSync:
      nseResult.status === "fulfilled"
        ? nseResult.value
        : { error: nseResult.reason instanceof Error ? nseResult.reason.message : "Unknown NSE sync error" },
    bseSync:
      bseResult.status === "fulfilled"
        ? bseResult.value
        : { error: bseResult.reason instanceof Error ? bseResult.reason.message : "Unknown BSE sync error" },
    combinedSync:
      combinedResult.status === "fulfilled"
        ? combinedResult.value
        : { error: combinedResult.reason instanceof Error ? combinedResult.reason.message : "Unknown combined sync error" }
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
  await refreshCombinedAnnouncements("status");

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
    combinedAnnouncementsCount: stores.COMBINED.announcements.length,
    lastNseSyncAt: stores.NSE.lastSyncAt,
    lastNseSyncStats: stores.NSE.lastSyncStats,
    lastBseSyncAt: stores.BSE.lastSyncAt,
    lastBseSyncStats: stores.BSE.lastSyncStats,
    lastCombinedSyncAt: stores.COMBINED.lastSyncAt,
    lastCombinedSyncStats: stores.COMBINED.lastSyncStats
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
          "GET /api/notifications/announcements?exchange=NSE|BSE|BSE+NSE|ALL&limit=100&symbol=TCS",
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

Promise.all([loadStore("NSE"), loadStore("BSE")])
  .then(() => refreshCombinedAnnouncements("startup", true))
  .catch((error) => {
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
