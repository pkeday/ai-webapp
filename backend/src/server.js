import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
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
const dedupStoragePath = resolve(process.cwd(), process.env.DEDUP_STORAGE_FILE ?? "data/dedup_announcements.json");
const dedupMaxStored = Number.parseInt(process.env.DEDUP_MAX_STORED ?? "10000", 10);
const dedupIncrementalLookbackHours = Number.parseInt(process.env.DEDUP_INCREMENTAL_LOOKBACK_HOURS ?? "48", 10);
const dedupIncrementalMinCandidates = Number.parseInt(process.env.DEDUP_INCREMENTAL_MIN_CANDIDATES ?? "400", 10);
const dedupIncrementalMaxCandidates = Number.parseInt(process.env.DEDUP_INCREMENTAL_MAX_CANDIDATES ?? "2500", 10);
const pdfHashTimeoutMs = Number.parseInt(process.env.PDF_HASH_TIMEOUT_MS ?? "20000", 10);
const pdfHashConcurrency = Number.parseInt(process.env.PDF_HASH_CONCURRENCY ?? "4", 10);
const aiLabelsStoragePath = resolve(process.cwd(), process.env.AI_LABELS_STORAGE_FILE ?? "data/announcement_ai_labels.json");
const aiCriteriaVersion = process.env.AI_CRITERIA_VERSION ?? "v1";
const aiClassifierEnabled = normalizeText(process.env.AI_CLASSIFIER_ENABLED ?? "false").toLowerCase() === "true";
const aiMaxItemsPerCron = Number.parseInt(process.env.AI_MAX_ITEMS_PER_CRON ?? "120", 10);
const aiConcurrency = Number.parseInt(process.env.AI_CLASSIFICATION_CONCURRENCY ?? "2", 10);
const aiPdfFetchTimeoutMs = Number.parseInt(process.env.AI_PDF_FETCH_TIMEOUT_MS ?? "30000", 10);
const aiPrimaryMaxPages = Number.parseInt(process.env.AI_PRIMARY_MAX_PAGES ?? "4", 10);
const aiEscalationMaxPages = Number.parseInt(process.env.AI_ESCALATION_MAX_PAGES ?? "12", 10);
const aiEscalationConfidenceThreshold = Number.parseFloat(process.env.AI_ESCALATION_CONFIDENCE_THRESHOLD ?? "0.8");
const aiMinReadableChars = Number.parseInt(process.env.AI_MIN_READABLE_CHARS ?? "700", 10);
const aiFailureRetryHours = Number.parseInt(process.env.AI_FAILURE_RETRY_HOURS ?? "24", 10);
const aiOpenAiApiKey = normalizeApiKeySecret(process.env.OPENAI_API_KEY ?? "");
const aiOpenAiBaseUrl = process.env.OPENAI_BASE_URL?.trim().replace(/\/$/, "") || "https://api.openai.com/v1";
const aiOpenAiStage1Model = "gpt-5-nano";
const aiOpenAiStage2Model = "gpt-5-mini";
const aiGeminiApiKey = normalizeApiKeySecret(process.env.GEMINI_API_KEY ?? "");
const aiGeminiBaseUrl = process.env.GEMINI_BASE_URL?.trim().replace(/\/$/, "") || "https://generativelanguage.googleapis.com/v1beta";
const aiGeminiStage1Model = process.env.AI_GEMINI_STAGE1_MODEL ?? "gemini-2.5-flash-lite";
const aiGeminiStage2Model = process.env.AI_GEMINI_STAGE2_MODEL ?? "gemini-2.5-flash";
const aiAnthropicApiKey = normalizeApiKeySecret(process.env.CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "");
const aiAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL?.trim().replace(/\/$/, "") || "https://api.anthropic.com/v1";
const aiAnthropicStage1Model = process.env.AI_ANTHROPIC_STAGE1_MODEL ?? "claude-3-5-haiku-latest";
const aiAnthropicStage2Model = process.env.AI_ANTHROPIC_STAGE2_MODEL ?? "claude-3-5-sonnet-latest";

const notes = [];
let noteId = 1;
let cronRunCount = 0;
let lastCronRunAt = null;
let aiOnlyRunCount = 0;
let lastAiOnlyRunAt = null;
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
  },
  DEDUP: {
    exchange: "DEDUP",
    storagePath: dedupStoragePath,
    maxStored: dedupMaxStored,
    announcements: [],
    keys: new Set(),
    loaded: false,
    lastSyncAt: null,
    lastSyncStats: null,
    syncInFlight: null,
    sourceFingerprint: ""
  }
};

const aiClassificationCategories = [
  "earnings_results_boardmeeting",
  "results_intimation_date",
  "earning_call_registration",
  "earning_call_audio_recording",
  "earning_call_transcript",
  "analyst_meeting",
  "participating_in_conference",
  "investor_day",
  "agm_announcement",
  "board_meeting",
  "board_meeting_intimation",
  "press_release",
  "auditors_report",
  "annual_report",
  "earning_presentation",
  "ma",
  "divestment",
  "contract_awarded",
  "fund_raising",
  "change_in_management",
  "credit_rating",
  "trading_stopping",
  "investor_conference",
  "not_eligible",
  "newspaper_announcement",
  "agm_outcome",
  "postal_ballot",
  "esops",
  "insider_trading",
  "share_pledge",
  "business_update",
  "surveillance_reply",
  "record_date_intimation",
  "share_transfer_relodgement_report",
  "certificate_under_regulation_74_5",
  "non_applicability_regulation_27_2",
  "others"
];

const aiCategoryDefinitions = {
  earnings_results_boardmeeting: "Filed financial results with actual statements approved by board.",
  results_intimation_date: "Notice of board meeting date to consider/approve results.",
  earning_call_registration: "Earnings/results discussion call or meeting schedule.",
  earning_call_audio_recording: "Audio recording link/publication of earnings call.",
  earning_call_transcript: "Transcript publication of earnings call.",
  analyst_meeting: "1x1/small investor or analyst interaction, non-conference.",
  participating_in_conference: "Named institution-hosted conference participation.",
  investor_day: "Company-hosted investor day event.",
  agm_announcement: "AGM/EGM notice announcing date/time/venue.",
  board_meeting: "Board meeting outcome not primarily quarterly results filing.",
  board_meeting_intimation: "Board meeting intimation not about results approval.",
  press_release: "Document explicitly identified as press release.",
  auditors_report: "Auditor report/certificate on financial statements/results.",
  annual_report: "Comprehensive annual report publication.",
  earning_presentation: "Investor presentation focused on financial results/business highlights.",
  ma: "Acquisition/merger/amalgamation or control increase.",
  divestment: "Sale/disposal/dilution resulting in reduced/lost control.",
  contract_awarded: "Order win/tender/contract award disclosure.",
  fund_raising: "Capital raise/security issuance-related disclosure.",
  change_in_management: "Management/promoter/KMP changes of listed company itself.",
  credit_rating: "Credit rating action/update.",
  trading_stopping: "Trading halt/window closure/suspension related note.",
  investor_conference: "Institution-hosted multi-company investor conference.",
  not_eligible: "Ineligibility/non-eligibility disclosure.",
  newspaper_announcement: "Newspaper publication/advertisement disclosure.",
  agm_outcome: "AGM/EGM outcome and voting result publication.",
  postal_ballot: "Postal ballot process or results disclosure.",
  esops: "ESOP/SAR/share-based employee benefit disclosure.",
  insider_trading: "Insider trade transaction disclosures.",
  share_pledge: "Pledge/unpledge of promoter/KMP shares.",
  business_update: "Operational/strategic business update.",
  surveillance_reply: "Reply to exchange surveillance/price-volume query.",
  record_date_intimation: "Record date/book closure intimation.",
  share_transfer_relodgement_report: "Physical share transfer relodgement report.",
  certificate_under_regulation_74_5: "Compliance certificate under Regulation 74(5).",
  non_applicability_regulation_27_2: "Non-applicability declaration under Regulation 27(2).",
  others: "Use only when no listed category is defensible."
};

const aiCategoryGuidanceText = aiClassificationCategories
  .map((category) => `- ${category}: ${aiCategoryDefinitions[category] || "Use only when applicable."}`)
  .join("\n");

const aiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "confidence", "reason", "needs_escalation"],
  properties: {
    category: {
      type: "string",
      enum: aiClassificationCategories
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    },
    reason: {
      type: "string",
      minLength: 4,
      maxLength: 600
    },
    needs_escalation: {
      type: "boolean"
    }
  }
};

const aiSystemPrompt = [
  "You are a strict corporate announcement classifier for Indian listed-company disclosures.",
  "Return ONLY valid JSON matching the required schema.",
  "Use only categories from the provided enum; never invent a category.",
  "Prefer specific categories over others. Use others only as last resort.",
  "Priority rules:",
  "1) Newspaper publication mentions always map to newspaper_announcement.",
  "2) Earnings-call scheduling/interaction about discussing results maps to earning_call_registration.",
  "3) Board meeting notice for approving results maps to results_intimation_date.",
  "4) Regulatory filing with approved financial statements maps to earnings_results_boardmeeting.",
  "5) 1x1, one-on-one, or investor meet without institutional host/conference name maps to analyst_meeting.",
  "6) External service-provider legal/name changes map to others (not change_in_management).",
  "7) If control is gained use ma; if control is reduced/lost use divestment.",
  "Allowed categories and concise guidance:",
  aiCategoryGuidanceText,
  "Set needs_escalation true when confidence is below 0.8 or evidence is weak."
].join("\n");

const aiLabelStore = {
  loaded: false,
  syncInFlight: null,
  records: [],
  byKey: new Map(),
  byInputHash: new Map(),
  lastSyncAt: null
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

function normalizeApiKeySecret(value) {
  let normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  if (/^bearer\s+/i.test(normalized)) {
    normalized = normalized.replace(/^bearer\s+/i, "").trim();
  }

  if (normalized.includes("*")) {
    return "";
  }

  return normalized;
}

function sanitizeSensitiveText(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }

  return text
    .replace(/sk-[A-Za-z0-9_\-]{10,}/g, "[REDACTED_OPENAI_KEY]")
    .replace(/sk-ant-[A-Za-z0-9_\-]{10,}/g, "[REDACTED_ANTHROPIC_KEY]")
    .replace(/AIza[A-Za-z0-9_\-]{10,}/g, "[REDACTED_GEMINI_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Bearer [REDACTED_TOKEN]");
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

  if (exchange === "COMBINED" || exchange === "DEDUP") {
    const dedupKey =
      typeof announcement?.dedupAnnouncementKey === "string" ? announcement.dedupAnnouncementKey.trim() : "";
    const mergedKey =
      typeof announcement?.mergedAnnouncementKey === "string" ? announcement.mergedAnnouncementKey.trim() : "";
    return dedupKey || mergedKey || null;
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
    const normalizedExchange =
      exchange === "COMBINED"
        ? getExchangeValue(item?.exchange ?? "NSE+BSE")
        : exchange === "DEDUP"
          ? getExchangeValue(item?.exchange ?? "DEDUP")
          : exchange;
    deduped.push({
      ...item,
      exchange: normalizedExchange,
      announcementKey: key
    });
  }

  return deduped;
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

function buildStoreFingerprint(exchange, sampleSize = 20) {
  const store = stores[exchange];
  const list = Array.isArray(store?.announcements) ? store.announcements : [];
  const safeSampleSize = Math.max(1, Math.min(sampleSize, list.length));
  const sampledKeys = [];

  for (let index = 0; index < safeSampleSize; index += 1) {
    const key = getAnnouncementKey(exchange, list[index]) ?? `INDEX:${index}`;
    sampledKeys.push(key);
  }

  return `${exchange}|COUNT:${list.length}|HEAD:${sampledKeys.join(",")}`;
}

function buildCombinedSourceFingerprint() {
  return [buildStoreFingerprint("NSE"), buildStoreFingerprint("BSE")].join("|");
}

function buildDedupSourceFingerprint() {
  return buildStoreFingerprint("COMBINED");
}

function selectDedupSourceCandidates() {
  const source = Array.isArray(stores.COMBINED.announcements) ? stores.COMBINED.announcements : [];
  const safeMinCandidates = normalizePositiveInt(dedupIncrementalMinCandidates, 400);
  const safeMaxCandidates = Math.max(safeMinCandidates, normalizePositiveInt(dedupIncrementalMaxCandidates, 2500));
  const safeLookbackHours = normalizePositiveInt(dedupIncrementalLookbackHours, 48);
  const cutoffMs = Date.now() - safeLookbackHours * 60 * 60 * 1000;
  const candidates = [];

  for (const item of source) {
    const storedSortMs = Number(item?.sortTimestampMs ?? 0);
    const timestampMs = parseTimestampToMillis(item?.timestamp) ?? 0;
    const insertedAtMs = parseTimestampToMillis(item?.insertedAt) ?? 0;
    const effectiveTimestampMs = Math.max(0, storedSortMs, timestampMs, insertedAtMs);
    const includeByLookback = effectiveTimestampMs >= cutoffMs;

    if (candidates.length < safeMinCandidates || includeByLookback) {
      candidates.push(item);
    } else {
      break;
    }

    if (candidates.length >= safeMaxCandidates) {
      break;
    }
  }

  if (candidates.length === 0) {
    return source.slice(0, safeMaxCandidates);
  }

  return candidates;
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

function normalizeSourceAnnouncement(item, fallbackExchange = "NSE") {
  const exchange = getExchangeValue(item?.exchange ?? fallbackExchange);
  const announcementKey = normalizeText(item?.announcementKey);
  const timestamp = normalizeText(item?.timestamp ?? "-") || "-";
  const symbol = normalizeText(item?.symbol ?? "-") || "-";
  const company = normalizeText(item?.company ?? "-") || "-";
  const type = normalizeText(item?.type ?? "-") || "-";
  const attachmentUrl = normalizeText(item?.attachmentUrl ?? item?.attachment_url ?? "");
  const isin = normalizeIsin(item?.isin);
  const fallbackSourceKey = `${exchange}:${announcementKey || `${timestamp}|${symbol}|${type}`}`;
  const sourceKey = normalizeText(item?.sourceKey) || fallbackSourceKey;

  return {
    sourceKey,
    exchange,
    announcementKey: announcementKey || null,
    timestamp,
    symbol,
    company,
    type,
    attachmentUrl: attachmentUrl || null,
    isin
  };
}

function dedupeSourceAnnouncements(list, fallbackExchange = "NSE") {
  const source = Array.isArray(list) ? list : [];
  const deduped = [];
  const seen = new Set();

  for (const item of source) {
    const normalized = normalizeSourceAnnouncement(item, fallbackExchange);
    if (!normalized.sourceKey || seen.has(normalized.sourceKey)) {
      continue;
    }

    seen.add(normalized.sourceKey);
    deduped.push(normalized);
  }

  return deduped;
}

function mergeSourceAnnouncementLists(currentList, incomingList, fallbackExchange = "NSE") {
  return dedupeSourceAnnouncements([...(Array.isArray(currentList) ? currentList : []), ...(Array.isArray(incomingList) ? incomingList : [])], fallbackExchange);
}

async function mapWithConcurrency(items, maxConcurrency, mapper) {
  const source = Array.isArray(items) ? items : [];
  if (source.length === 0) {
    return [];
  }

  const safeConcurrency = Math.max(1, Math.min(source.length, normalizePositiveInt(maxConcurrency, 4)));
  const results = new Array(source.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const currentIndex = cursor;
      cursor += 1;
      if (currentIndex >= source.length) {
        return;
      }

      results[currentIndex] = await mapper(source[currentIndex], currentIndex);
    }
  };

  await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));
  return results;
}

function isAiClassificationEnabled() {
  return aiClassifierEnabled && hasAiProviderKey();
}

function hasAiProviderKey() {
  return Boolean(aiOpenAiApiKey || aiGeminiApiKey || aiAnthropicApiKey);
}

function normalizeAnnouncementKey(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function buildAiInputHash(announcement, criteriaVersion = aiCriteriaVersion) {
  const key = normalizeAnnouncementKey(
    announcement?.dedupAnnouncementKey ?? announcement?.mergedAnnouncementKey ?? announcement?.announcementKey
  );
  const payload = {
    criteriaVersion: normalizeText(criteriaVersion),
    key: key ?? "",
    isin: normalizeIsin(announcement?.isin) ?? "",
    pdfHash: normalizeText(announcement?.pdf_hash),
    attachmentUrl: normalizeText(announcement?.attachment_url),
    symbol: normalizeText(announcement?.symbol),
    company: normalizeText(announcement?.company),
    type: normalizeText(announcement?.type),
    timestamp: normalizeText(announcement?.timestamp)
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function indexAiLabelStore() {
  aiLabelStore.byKey = new Map();
  aiLabelStore.byInputHash = new Map();

  for (const record of aiLabelStore.records) {
    const key = normalizeAnnouncementKey(record?.dedupAnnouncementKey);
    const criteriaVersion = normalizeText(record?.criteriaVersion);
    const inputHash = normalizeText(record?.inputHash);
    if (!key) {
      continue;
    }

    if (criteriaVersion === aiCriteriaVersion) {
      aiLabelStore.byKey.set(key, record);
    }

    if (criteriaVersion === aiCriteriaVersion && record?.status === "SUCCESS" && inputHash) {
      aiLabelStore.byInputHash.set(inputHash, record);
    }
  }
}

async function loadAiLabelStore() {
  if (aiLabelStore.loaded) {
    return;
  }

  if (aiLabelStore.syncInFlight) {
    await aiLabelStore.syncInFlight;
    return;
  }

  aiLabelStore.syncInFlight = (async () => {
    try {
      const text = await readFile(aiLabelsStoragePath, "utf8");
      const parsed = JSON.parse(text);
      const records = Array.isArray(parsed?.records) ? parsed.records : Array.isArray(parsed) ? parsed : [];
      aiLabelStore.records = records
        .map((record) => ({
          dedupAnnouncementKey: normalizeAnnouncementKey(record?.dedupAnnouncementKey),
          criteriaVersion: normalizeText(record?.criteriaVersion),
          inputHash: normalizeText(record?.inputHash),
          status: normalizeText(record?.status).toUpperCase() || "UNKNOWN",
          label: normalizeText(record?.label),
          confidence: Number(record?.confidence ?? 0),
          reason: normalizeText(record?.reason),
          provider: normalizeText(record?.provider),
          model: normalizeText(record?.model),
          attempt: normalizePositiveInt(Number(record?.attempt ?? 1), 1),
          totalPages: normalizePositiveInt(Number(record?.totalPages ?? 1), 1),
          pagesProcessed: normalizePositiveInt(Number(record?.pagesProcessed ?? 1), 1),
          machineReadable: Boolean(record?.machineReadable),
          sourceAttachmentUrl: normalizeText(record?.sourceAttachmentUrl),
          sourcePdfHash: normalizeText(record?.sourcePdfHash),
          updatedAt: normalizeText(record?.updatedAt || record?.classifiedAt || new Date().toISOString()),
          error: normalizeText(record?.error),
          promptVersion: normalizeText(record?.promptVersion || aiCriteriaVersion)
        }))
        .filter((record) => Boolean(record.dedupAnnouncementKey));
      aiLabelStore.lastSyncAt =
        typeof parsed?.lastSyncAt === "string" ? parsed.lastSyncAt : typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null;
      indexAiLabelStore();
      log("Loaded AI classification store", { count: aiLabelStore.records.length, path: aiLabelsStoragePath });
    } catch (error) {
      if (error?.code === "ENOENT") {
        log("AI classification store not found. Starting fresh.", { path: aiLabelsStoragePath });
      } else {
        const message = error instanceof Error ? error.message : "Unknown AI store load error";
        log("Failed to load AI classification store. Starting fresh.", { message, path: aiLabelsStoragePath });
      }

      aiLabelStore.records = [];
      aiLabelStore.lastSyncAt = null;
      indexAiLabelStore();
    }

    aiLabelStore.loaded = true;
  })();

  try {
    await aiLabelStore.syncInFlight;
  } finally {
    aiLabelStore.syncInFlight = null;
  }
}

async function persistAiLabelStore() {
  await mkdir(dirname(aiLabelsStoragePath), { recursive: true });
  aiLabelStore.lastSyncAt = new Date().toISOString();
  await writeFile(
    aiLabelsStoragePath,
    JSON.stringify(
      {
        updatedAt: aiLabelStore.lastSyncAt,
        criteriaVersion: aiCriteriaVersion,
        total: aiLabelStore.records.length,
        records: aiLabelStore.records
      },
      null,
      2
    ),
    "utf8"
  );
}

function getAiLabelRecordForKey(dedupAnnouncementKey) {
  const key = normalizeAnnouncementKey(dedupAnnouncementKey);
  if (!key) {
    return null;
  }
  return aiLabelStore.byKey.get(key) ?? null;
}

function upsertAiLabelRecord(record) {
  const key = normalizeAnnouncementKey(record?.dedupAnnouncementKey);
  if (!key) {
    return;
  }

  const existingIndex = aiLabelStore.records.findIndex(
    (item) => normalizeAnnouncementKey(item?.dedupAnnouncementKey) === key && normalizeText(item?.criteriaVersion) === aiCriteriaVersion
  );

  const normalizedRecord = {
    ...record,
    dedupAnnouncementKey: key,
    criteriaVersion: aiCriteriaVersion,
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    aiLabelStore.records[existingIndex] = normalizedRecord;
  } else {
    aiLabelStore.records.push(normalizedRecord);
  }

  aiLabelStore.byKey.set(key, normalizedRecord);
  if (normalizedRecord.status === "SUCCESS" && normalizedRecord.inputHash) {
    aiLabelStore.byInputHash.set(normalizedRecord.inputHash, normalizedRecord);
  }
}

async function fetchBinary(url, timeoutMs) {
  const normalizedUrl = normalizeText(url);
  if (!normalizedUrl) {
    throw new Error("Missing URL");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizePositiveInt(timeoutMs, 30_000));

  try {
    const response = await fetch(normalizedUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timeout);
  }
}

async function slicePdfToFirstPages(pdfBuffer, maxPages) {
  const sourceDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const totalPages = sourceDoc.getPageCount();
  const safeMaxPages = Math.max(1, normalizePositiveInt(maxPages, 4));
  const pagesToKeep = Math.min(totalPages, safeMaxPages);

  if (pagesToKeep >= totalPages) {
    return {
      totalPages,
      pagesProcessed: totalPages,
      bytes: pdfBuffer
    };
  }

  const targetDoc = await PDFDocument.create();
  const pageIndexes = Array.from({ length: pagesToKeep }, (_, index) => index);
  const copiedPages = await targetDoc.copyPages(sourceDoc, pageIndexes);
  for (const page of copiedPages) {
    targetDoc.addPage(page);
  }

  const truncatedBytes = await targetDoc.save();
  return {
    totalPages,
    pagesProcessed: pagesToKeep,
    bytes: Buffer.from(truncatedBytes)
  };
}

async function extractTextFromPdfPages(pdfBuffer, maxPages) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: pdfjsLib.VerbosityLevel?.ERRORS ?? 0
  });
  const document = await loadingTask.promise;
  const totalPages = document.numPages;
  const pagesToProcess = Math.max(1, Math.min(totalPages, normalizePositiveInt(maxPages, 4)));
  const pageTexts = [];

  for (let pageNumber = 1; pageNumber <= pagesToProcess; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => normalizeText(item?.str))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pageTexts.push(pageText);
  }

  const combinedText = pageTexts.join("\n\n").trim();
  return {
    totalPages,
    pagesProcessed: pagesToProcess,
    text: combinedText,
    textLength: combinedText.length
  };
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  if (numeric < 0) {
    return 0;
  }

  if (numeric > 1) {
    return 1;
  }

  return numeric;
}

function extractFirstJsonObject(text) {
  const raw = normalizeText(text);
  if (!raw) {
    return null;
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeAiModelOutput(output) {
  const category = normalizeText(output?.category);
  const reason = normalizeText(output?.reason);
  const confidence = clampConfidence(output?.confidence);
  const needsEscalation = Boolean(output?.needs_escalation) || confidence < clampConfidence(aiEscalationConfidenceThreshold);

  if (!aiClassificationCategories.includes(category)) {
    throw new Error(`Invalid category '${category || "unknown"}'`);
  }

  if (!reason) {
    throw new Error("Missing classification reason");
  }

  return {
    category,
    confidence,
    reason,
    needsEscalation
  };
}

function buildClassificationUserPrompt(announcement, criteriaVersion, textSnippet) {
  const symbol = normalizeText(announcement?.symbol) || "-";
  const company = normalizeText(announcement?.company) || "-";
  const type = normalizeText(announcement?.type) || "-";
  const timestamp = normalizeText(announcement?.timestamp) || "-";
  const isin = normalizeIsin(announcement?.isin) || "-";
  const sourceExchange = normalizeText(announcement?.exchange) || "DEDUP";
  const sourceKey = normalizeAnnouncementKey(
    announcement?.dedupAnnouncementKey ?? announcement?.mergedAnnouncementKey ?? announcement?.announcementKey
  );
  const excerpt = normalizeText(textSnippet).slice(0, 80_000);

  return [
    `criteria_version: ${criteriaVersion}`,
    `source_key: ${sourceKey ?? "-"}`,
    `exchange: ${sourceExchange}`,
    `symbol: ${symbol}`,
    `company: ${company}`,
    `isin: ${isin}`,
    `announced_type: ${type}`,
    `timestamp: ${timestamp}`,
    "",
    "Classify this announcement using only the allowed categories.",
    "Document text excerpt:",
    excerpt || "(No machine-readable text extracted)"
  ].join("\n");
}

async function classifyWithOpenAi(model, prompt, apiKey, baseUrl) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: aiSystemPrompt
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: prompt
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "announcement_classification",
          schema: aiJsonSchema,
          strict: true
        }
      }
    })
  });

  if (!response.ok) {
    const body = sanitizeSensitiveText(await response.text());
    throw new Error(`OpenAI HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  const outputText =
    normalizeText(payload?.output_text) ||
    normalizeText(
      payload?.output?.flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
        ?.map((contentItem) => contentItem?.text ?? "")
        ?.join(" ")
    );
  const parsed = extractFirstJsonObject(outputText);
  if (!parsed) {
    throw new Error("OpenAI response did not return JSON");
  }

  return normalizeAiModelOutput(parsed);
}

async function classifyWithAnthropic(model, prompt, apiKey, baseUrl) {
  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 450,
      temperature: 0,
      system: aiSystemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const body = sanitizeSensitiveText(await response.text());
    throw new Error(`Anthropic HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  const outputText = normalizeText(
    payload?.content
      ?.map((part) => normalizeText(part?.text))
      .filter(Boolean)
      .join(" ")
  );
  const parsed = extractFirstJsonObject(outputText);
  if (!parsed) {
    throw new Error("Anthropic response did not return JSON");
  }

  return normalizeAiModelOutput(parsed);
}

async function classifyWithGeminiPdf(model, prompt, pdfBytes, apiKey, baseUrl) {
  const response = await fetch(`${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text: aiSystemPrompt
          }
        ]
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: prompt
            },
            {
              inlineData: {
                mimeType: "application/pdf",
                data: pdfBytes.toString("base64")
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: aiJsonSchema
      }
    })
  });

  if (!response.ok) {
    const body = sanitizeSensitiveText(await response.text());
    throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  const outputText = normalizeText(
    payload?.candidates?.[0]?.content?.parts
      ?.map((part) => normalizeText(part?.text))
      .filter(Boolean)
      .join(" ")
  );
  const parsed = extractFirstJsonObject(outputText);
  if (!parsed) {
    throw new Error("Gemini response did not return JSON");
  }

  return normalizeAiModelOutput(parsed);
}

async function classifyDedupAnnouncement(announcement) {
  const dedupAnnouncementKey = normalizeAnnouncementKey(
    announcement?.dedupAnnouncementKey ?? announcement?.mergedAnnouncementKey ?? announcement?.announcementKey
  );
  if (!dedupAnnouncementKey) {
    throw new Error("Missing dedup announcement key");
  }

  const attachmentUrl = normalizeText(announcement?.attachment_url);
  if (!attachmentUrl) {
    throw new Error("Missing attachment URL");
  }

  const pdfBuffer = await fetchBinary(attachmentUrl, aiPdfFetchTimeoutMs);
  const stage1Pdf = await slicePdfToFirstPages(pdfBuffer, aiPrimaryMaxPages);
  const stage1Text = await extractTextFromPdfPages(stage1Pdf.bytes, stage1Pdf.pagesProcessed);
  const machineReadable = stage1Text.textLength >= normalizePositiveInt(aiMinReadableChars, 700);
  const criteriaVersion = aiCriteriaVersion;
  const inputHash = buildAiInputHash(announcement, criteriaVersion);

  const stage1Prompt = buildClassificationUserPrompt(announcement, criteriaVersion, stage1Text.text);
  const stage1Errors = [];
  const captureProviderError = (provider, error, targetList) => {
    const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown error"));
    targetList.push(`${provider}: ${message.slice(0, 220)}`);
  };
  const classifyWithStage1Chain = async () => {
    if (machineReadable) {
      if (aiOpenAiApiKey) {
        try {
          return {
            ...(await classifyWithOpenAi(aiOpenAiStage1Model, stage1Prompt, aiOpenAiApiKey, aiOpenAiBaseUrl)),
            provider: "openai",
            model: aiOpenAiStage1Model
          };
        } catch (error) {
          captureProviderError("openai", error, stage1Errors);
        }
      }

      if (aiAnthropicApiKey) {
        try {
          return {
            ...(await classifyWithAnthropic(aiAnthropicStage1Model, stage1Prompt, aiAnthropicApiKey, aiAnthropicBaseUrl)),
            provider: "anthropic",
            model: aiAnthropicStage1Model
          };
        } catch (error) {
          captureProviderError("anthropic", error, stage1Errors);
        }
      }
    }

    if (aiGeminiApiKey) {
      try {
        return {
          ...(await classifyWithGeminiPdf(aiGeminiStage1Model, stage1Prompt, stage1Pdf.bytes, aiGeminiApiKey, aiGeminiBaseUrl)),
          provider: "gemini",
          model: aiGeminiStage1Model
        };
      } catch (error) {
        captureProviderError("gemini", error, stage1Errors);
      }
    }

    if (!machineReadable) {
      if (aiAnthropicApiKey) {
        try {
          return {
            ...(await classifyWithAnthropic(aiAnthropicStage1Model, stage1Prompt, aiAnthropicApiKey, aiAnthropicBaseUrl)),
            provider: "anthropic",
            model: aiAnthropicStage1Model
          };
        } catch (error) {
          captureProviderError("anthropic", error, stage1Errors);
        }
      }

      if (aiOpenAiApiKey) {
        try {
          return {
            ...(await classifyWithOpenAi(aiOpenAiStage1Model, stage1Prompt, aiOpenAiApiKey, aiOpenAiBaseUrl)),
            provider: "openai",
            model: aiOpenAiStage1Model
          };
        } catch (error) {
          captureProviderError("openai", error, stage1Errors);
        }
      }
    }

    throw new Error(
      stage1Errors.length > 0
        ? `Stage 1 classification failed: ${stage1Errors.join(" | ")}`
        : "No AI provider key configured"
    );
  };
  const stage1 = await classifyWithStage1Chain();

  let finalResult = stage1;
  let pagesProcessed = stage1Pdf.pagesProcessed;
  const confidenceThreshold = clampConfidence(aiEscalationConfidenceThreshold);
  const shouldEscalate = stage1.needsEscalation || stage1.confidence < confidenceThreshold;

  if (shouldEscalate) {
    const stage2Pdf = await slicePdfToFirstPages(pdfBuffer, aiEscalationMaxPages);
    pagesProcessed = stage2Pdf.pagesProcessed;
    const stage2Text = machineReadable ? await extractTextFromPdfPages(stage2Pdf.bytes, stage2Pdf.pagesProcessed) : null;
    const stage2Prompt = buildClassificationUserPrompt(
      announcement,
      criteriaVersion,
      machineReadable ? stage2Text?.text ?? stage1Text.text : stage1Text.text
    );

    const stage2Errors = [];
    const classifyWithStage2Chain = async () => {
      if (machineReadable) {
        if (aiOpenAiApiKey) {
          try {
            return {
              ...(await classifyWithOpenAi(aiOpenAiStage2Model, stage2Prompt, aiOpenAiApiKey, aiOpenAiBaseUrl)),
              provider: "openai",
              model: aiOpenAiStage2Model
            };
          } catch (error) {
            captureProviderError("openai", error, stage2Errors);
          }
        }

        if (aiAnthropicApiKey) {
          try {
            return {
              ...(await classifyWithAnthropic(aiAnthropicStage2Model, stage2Prompt, aiAnthropicApiKey, aiAnthropicBaseUrl)),
              provider: "anthropic",
              model: aiAnthropicStage2Model
            };
          } catch (error) {
            captureProviderError("anthropic", error, stage2Errors);
          }
        }
      }

      if (aiGeminiApiKey) {
        try {
          return {
            ...(await classifyWithGeminiPdf(aiGeminiStage2Model, stage2Prompt, stage2Pdf.bytes, aiGeminiApiKey, aiGeminiBaseUrl)),
            provider: "gemini",
            model: aiGeminiStage2Model
          };
        } catch (error) {
          captureProviderError("gemini", error, stage2Errors);
        }
      }

      if (!machineReadable) {
        if (aiAnthropicApiKey) {
          try {
            return {
              ...(await classifyWithAnthropic(aiAnthropicStage2Model, stage2Prompt, aiAnthropicApiKey, aiAnthropicBaseUrl)),
              provider: "anthropic",
              model: aiAnthropicStage2Model
            };
          } catch (error) {
            captureProviderError("anthropic", error, stage2Errors);
          }
        }

        if (aiOpenAiApiKey) {
          try {
            return {
              ...(await classifyWithOpenAi(aiOpenAiStage2Model, stage2Prompt, aiOpenAiApiKey, aiOpenAiBaseUrl)),
              provider: "openai",
              model: aiOpenAiStage2Model
            };
          } catch (error) {
            captureProviderError("openai", error, stage2Errors);
          }
        }
      }

      throw new Error(
        stage2Errors.length > 0
          ? `Stage 2 classification failed: ${stage2Errors.join(" | ")}`
          : "No AI provider key configured for escalation"
      );
    };

    finalResult = await classifyWithStage2Chain();
  }

  return {
    dedupAnnouncementKey,
    inputHash,
    status: "SUCCESS",
    label: finalResult.category,
    confidence: finalResult.confidence,
    reason: finalResult.reason,
    provider: finalResult.provider,
    model: finalResult.model,
    attempt: shouldEscalate ? 2 : 1,
    totalPages: stage1Pdf.totalPages,
    pagesProcessed,
    machineReadable,
    sourceAttachmentUrl: attachmentUrl,
    sourcePdfHash: normalizeText(announcement?.pdf_hash),
    promptVersion: aiCriteriaVersion,
    error: ""
  };
}

async function runAiClassificationCron(trigger, touchedDedupKeys = [], options = {}) {
  const forceEnabled = options?.forceEnabled === true;
  const maxItemsOverrideRaw = Number.parseInt(String(options?.maxItems ?? ""), 10);
  const maxItemsOverride = Number.isFinite(maxItemsOverrideRaw) && maxItemsOverrideRaw > 0 ? maxItemsOverrideRaw : null;
  const scanRecentWhenNoTouched = options?.scanRecentWhenNoTouched === true;
  await loadAiLabelStore();

  if (!aiClassifierEnabled && !forceEnabled) {
    return {
      trigger,
      skipped: true,
      reason: "ai-classifier-disabled",
      criteriaVersion: aiCriteriaVersion,
      forceEnabled,
      processedCount: 0,
      successCount: 0,
      failureCount: 0
    };
  }

  if (!hasAiProviderKey()) {
    return {
      trigger,
      skipped: true,
      reason: "missing-provider-keys",
      criteriaVersion: aiCriteriaVersion,
      forceEnabled,
      processedCount: 0,
      successCount: 0,
      failureCount: 0
    };
  }

  const uniqueKeys = Array.from(
    new Set((Array.isArray(touchedDedupKeys) ? touchedDedupKeys : []).map((value) => normalizeAnnouncementKey(value)).filter(Boolean))
  );
  const dedupByKey = new Map();
  for (const item of stores.DEDUP.announcements) {
    const key = normalizeAnnouncementKey(item?.dedupAnnouncementKey ?? item?.mergedAnnouncementKey ?? item?.announcementKey);
    if (key) {
      dedupByKey.set(key, item);
    }
  }

  let candidates = uniqueKeys
    .map((key) => dedupByKey.get(key))
    .filter(Boolean);

  const maxItems = maxItemsOverride ?? normalizePositiveInt(aiMaxItemsPerCron, 120);
  if (candidates.length === 0 && aiLabelStore.records.length === 0) {
    // Bootstrap mode for first-time setup.
    candidates = stores.DEDUP.announcements.slice(0, maxItems);
  } else if (candidates.length === 0 && scanRecentWhenNoTouched) {
    const recentCandidatePoolRaw = Number.parseInt(String(options?.recentCandidatePool ?? ""), 10);
    const defaultRecentCandidatePool = Math.max(maxItems * 25, 500);
    const recentCandidatePool = Number.isFinite(recentCandidatePoolRaw) && recentCandidatePoolRaw > 0
      ? recentCandidatePoolRaw
      : defaultRecentCandidatePool;
    candidates = stores.DEDUP.announcements.slice(0, recentCandidatePool);
  }

  const queue = [];
  let skippedExistingCount = 0;
  const failureRetryWindowMs = normalizePositiveInt(aiFailureRetryHours, 24) * 60 * 60 * 1000;

  for (const item of candidates) {
    const dedupAnnouncementKey = normalizeAnnouncementKey(
      item?.dedupAnnouncementKey ?? item?.mergedAnnouncementKey ?? item?.announcementKey
    );
    if (!dedupAnnouncementKey) {
      continue;
    }

    const inputHash = buildAiInputHash(item, aiCriteriaVersion);
    const existingRecord = getAiLabelRecordForKey(dedupAnnouncementKey);
    if (
      existingRecord &&
      existingRecord.status === "SUCCESS" &&
      normalizeText(existingRecord.criteriaVersion) === aiCriteriaVersion &&
      normalizeText(existingRecord.inputHash) === inputHash
    ) {
      skippedExistingCount += 1;
      continue;
    }

    if (
      !forceEnabled &&
      existingRecord &&
      existingRecord.status === "FAILED" &&
      normalizeText(existingRecord.criteriaVersion) === aiCriteriaVersion &&
      normalizeText(existingRecord.inputHash) === inputHash
    ) {
      const failedAtMs = parseTimestampToMillis(existingRecord.updatedAt);
      if (failedAtMs && Date.now() - failedAtMs < failureRetryWindowMs) {
        skippedExistingCount += 1;
        continue;
      }
    }

    const hashRecord = aiLabelStore.byInputHash.get(inputHash);
    if (hashRecord && hashRecord.status === "SUCCESS") {
      upsertAiLabelRecord({
        ...hashRecord,
        dedupAnnouncementKey,
        inputHash
      });
      skippedExistingCount += 1;
      continue;
    }

    queue.push(item);
    if (queue.length >= maxItems) {
      break;
    }
  }

  if (queue.length === 0) {
    await persistAiLabelStore();
    return {
      trigger,
      skipped: true,
      reason: "no-new-ai-candidates",
      criteriaVersion: aiCriteriaVersion,
      forceEnabled,
      maxItems,
      candidateCount: candidates.length,
      skippedExistingCount,
      processedCount: 0,
      successCount: 0,
      failureCount: 0
    };
  }

  const results = await mapWithConcurrency(queue, normalizePositiveInt(aiConcurrency, 2), async (announcement) => {
    const dedupAnnouncementKey = normalizeAnnouncementKey(
      announcement?.dedupAnnouncementKey ?? announcement?.mergedAnnouncementKey ?? announcement?.announcementKey
    );
    const inputHash = buildAiInputHash(announcement, aiCriteriaVersion);

    try {
      const result = await classifyDedupAnnouncement(announcement);
      upsertAiLabelRecord(result);
      return { key: dedupAnnouncementKey, ok: true, provider: result.provider, model: result.model };
    } catch (error) {
      const message = sanitizeSensitiveText(error instanceof Error ? error.message : "Unknown AI classification error");
      upsertAiLabelRecord({
        dedupAnnouncementKey,
        inputHash,
        status: "FAILED",
        label: "",
        confidence: 0,
        reason: "",
        provider: "",
        model: "",
        attempt: 1,
        totalPages: 1,
        pagesProcessed: 1,
        machineReadable: false,
        sourceAttachmentUrl: normalizeText(announcement?.attachment_url),
        sourcePdfHash: normalizeText(announcement?.pdf_hash),
        promptVersion: aiCriteriaVersion,
        error: message
      });
      return { key: dedupAnnouncementKey, ok: false, error: message };
    }
  });

  await persistAiLabelStore();

  const successCount = results.filter((result) => result.ok).length;
  const failureCount = results.length - successCount;
  const failedSamples = results
    .filter((result) => !result.ok)
    .slice(0, 3)
    .map((result) => ({
      key: result.key,
      error: sanitizeSensitiveText(result.error || "Unknown classification failure")
    }));

  return {
    trigger,
    criteriaVersion: aiCriteriaVersion,
    forceEnabled,
    maxItems,
    candidateCount: candidates.length,
    queuedCount: queue.length,
    skippedExistingCount,
    processedCount: results.length,
    successCount,
    failureCount,
    failedKeys: results.filter((result) => !result.ok).map((result) => result.key).filter(Boolean),
    failedSamples
  };
}

function enrichDedupAnnouncementWithAi(announcement) {
  const key = normalizeAnnouncementKey(
    announcement?.dedupAnnouncementKey ?? announcement?.mergedAnnouncementKey ?? announcement?.announcementKey
  );
  if (!key) {
    return announcement;
  }

  const aiRecord = getAiLabelRecordForKey(key);
  if (!aiRecord) {
    return {
      ...announcement,
      ai_label: null,
      ai_confidence: null,
      ai_reason: null,
      ai_error: null,
      ai_status: "MISSING"
    };
  }

  const aiStatus = normalizeText(aiRecord.status).toUpperCase();
  const isSuccess = aiStatus === "SUCCESS";
  const isFailed = aiStatus === "FAILED";
  const successReason = isSuccess ? aiRecord.reason || null : null;
  const failureReason = isFailed ? aiRecord.error || null : null;

  return {
    ...announcement,
    ai_label: isSuccess ? aiRecord.label || null : null,
    ai_confidence: isSuccess ? clampConfidence(aiRecord.confidence) : null,
    ai_reason: successReason || failureReason,
    ai_error: failureReason,
    ai_status: aiStatus || "UNKNOWN",
    ai_provider: aiRecord.provider || null,
    ai_model: aiRecord.model || null
  };
}

async function fetchPdfHashFromUrl(url) {
  const normalizedUrl = normalizeText(url);
  if (!normalizedUrl) {
    return null;
  }

  const timeoutMs = normalizePositiveInt(pdfHashTimeoutMs, 20_000);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(normalizedUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: "application/pdf,*/*"
      }
    });

    if (!response.ok) {
      return null;
    }

    const fileData = Buffer.from(await response.arrayBuffer());
    if (fileData.length === 0) {
      return null;
    }

    return createHash("sha256").update(fileData).digest("hex");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown PDF hash error";
    log("PDF hash fetch skipped", { message, url: normalizedUrl });
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function shouldPreferDedupCandidate(existingRecord, candidate) {
  const existingPrimaryExchange = getExchangeValue(existingRecord?.primaryExchange ?? existingRecord?.exchange);
  const candidateExchange = getExchangeValue(candidate?.exchange);

  if (candidateExchange === "NSE" && existingPrimaryExchange !== "NSE") {
    return true;
  }

  if (candidateExchange !== "NSE" && existingPrimaryExchange === "NSE") {
    return false;
  }

  const candidateSort = Number(candidate?.sortTimestampMs ?? 0);
  const existingSort = Number(existingRecord?.sortTimestampMs ?? 0);
  if (candidateSort !== existingSort) {
    return candidateSort > existingSort;
  }

  return String(candidate?.insertedAt ?? "").localeCompare(String(existingRecord?.insertedAt ?? "")) > 0;
}

function buildKnownPdfHashByUrl() {
  const knownPdfHashByUrl = new Map();
  const existingDedup = Array.isArray(stores.DEDUP?.announcements) ? stores.DEDUP.announcements : [];

  for (const item of existingDedup) {
    const hash = normalizeText(item?.pdf_hash);
    if (!hash) {
      continue;
    }

    const urls = [item?.attachment_url];
    const sourceAnnouncements = Array.isArray(item?.sourceAnnouncements) ? item.sourceAnnouncements : [];
    for (const source of sourceAnnouncements) {
      urls.push(source?.attachmentUrl ?? source?.attachment_url);
    }

    for (const url of urls) {
      const normalizedUrl = normalizeText(url);
      if (normalizedUrl && !knownPdfHashByUrl.has(normalizedUrl)) {
        knownPdfHashByUrl.set(normalizedUrl, hash);
      }
    }
  }

  return knownPdfHashByUrl;
}

function buildCombinedAnnouncements() {
  const sourceItems = [...stores.NSE.announcements, ...stores.BSE.announcements];
  const nseListingByIsin = buildNseListingByIsin();
  const sourceSeen = new Set();
  const combined = [];

  let sourceDedupedCount = 0;
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

    const mergedAnnouncementKey = `SOURCE:${sourceKey}`;
    const record = {
      exchange,
      exchanges: [exchange],
      mergedFromCount: 1,
      mergedAnnouncementKey,
      announcementKey: mergedAnnouncementKey,
      dedupeStrategy: "none",
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
      crossExchangeMergedCount: 0,
      mergedRecordCount: 0,
      combinedCount: combined.length,
      withIsinCount,
      missingIsinCount
    }
  };
}

async function buildDedupAnnouncements(options = {}) {
  const sourceItems = Array.isArray(options?.sourceItems) ? [...options.sourceItems] : [...stores.COMBINED.announcements];
  const baseAnnouncements = Array.isArray(options?.baseAnnouncements) ? options.baseAnnouncements : [];
  const nseListingByIsin = buildNseListingByIsin();
  const pdfHashCache = new Map();
  const knownPdfHashByUrl = buildKnownPdfHashByUrl();
  const preloadedPdfHashCount = knownPdfHashByUrl.size;

  const resolvePdfHash = async (attachmentUrl) => {
    const normalized = normalizeText(attachmentUrl);
    if (!normalized) {
      return null;
    }

    const knownHash = knownPdfHashByUrl.get(normalized);
    if (knownHash) {
      return knownHash;
    }

    if (!pdfHashCache.has(normalized)) {
      pdfHashCache.set(
        normalized,
        fetchPdfHashFromUrl(normalized).then((hash) => {
          if (hash) {
            knownPdfHashByUrl.set(normalized, hash);
          }
          return hash;
        })
      );
    }

    return pdfHashCache.get(normalized);
  };

  let withIsinCount = 0;
  let missingIsinCount = 0;
  let withPdfHashCount = 0;
  let missingPdfHashCount = 0;
  const dedupMap = new Map();
  const dedupAnnouncements = [];

  for (const existingItem of baseAnnouncements) {
    const baseKey = normalizeText(
      existingItem?.dedupAnnouncementKey ?? existingItem?.mergedAnnouncementKey ?? existingItem?.announcementKey
    );
    if (!baseKey || dedupMap.has(baseKey)) {
      continue;
    }

    const rawFallbackExchange = getExchangeValue(existingItem?.primaryExchange ?? existingItem?.exchange ?? "NSE");
    const fallbackExchange = rawFallbackExchange === "BSE" ? "BSE" : "NSE";
    const normalizedSourceAnnouncements = dedupeSourceAnnouncements(existingItem?.sourceAnnouncements, fallbackExchange);
    const fallbackSourceAnnouncement = normalizeSourceAnnouncement(
      {
        sourceKey: normalizeText(existingItem?.sourceKey ?? baseKey),
        exchange: fallbackExchange,
        announcementKey: normalizeText(existingItem?.announcementKey ?? baseKey),
        timestamp: normalizeText(existingItem?.timestamp),
        symbol: normalizeText(existingItem?.symbol),
        company: normalizeText(existingItem?.company),
        type: normalizeText(existingItem?.type),
        attachmentUrl: normalizeText(existingItem?.attachment_url),
        isin: normalizeIsin(existingItem?.isin)
      },
      fallbackExchange
    );
    const sourceAnnouncements =
      normalizedSourceAnnouncements.length > 0 ? normalizedSourceAnnouncements : [fallbackSourceAnnouncement];
    const baseExchangeCandidates = [
      ...(Array.isArray(existingItem?.exchanges) ? existingItem.exchanges : []),
      existingItem?.exchange,
      ...sourceAnnouncements.map((sourceAnnouncement) => sourceAnnouncement.exchange)
    ];
    const exchanges = mergeSortedUnique(
      baseExchangeCandidates
        .map((candidate) => getExchangeValue(candidate))
        .flatMap((exchange) => {
          if (exchange === "NSE+BSE" || exchange === "BSE+NSE" || exchange === "COMBINED") {
            return ["NSE", "BSE"];
          }

          return exchange === "NSE" || exchange === "BSE" ? [exchange] : [];
        })
    );
    const isin = normalizeIsin(existingItem?.isin);
    const timestamp = normalizeText(existingItem?.timestamp ?? "-") || "-";
    const type = normalizeText(existingItem?.type ?? "-") || "-";
    const symbol = normalizeText(existingItem?.symbol ?? "-") || "-";
    const company = normalizeText(existingItem?.company ?? "-") || "-";
    const attachmentUrl = normalizeText(existingItem?.attachment_url) || null;
    const sortTimestampMs =
      parseTimestampToMillis(timestamp) ??
      parseTimestampToMillis(existingItem?.insertedAt) ??
      Number(existingItem?.sortTimestampMs ?? 0);
    const normalizedRecord = {
      ...existingItem,
      exchange: exchanges.length > 1 ? "NSE+BSE" : exchanges[0] ?? fallbackExchange,
      exchanges: exchanges.length > 0 ? exchanges : [fallbackExchange],
      mergedFromCount: sourceAnnouncements.length,
      dedupAnnouncementKey: baseKey,
      mergedAnnouncementKey: baseKey,
      announcementKey: baseKey,
      dedupeStrategy:
        normalizeText(existingItem?.dedupeStrategy) || (isin && normalizeText(existingItem?.pdf_hash) ? "isin+pdf-hash" : "source-key-fallback"),
      isin,
      pdf_hash: normalizeText(existingItem?.pdf_hash) || null,
      timestamp,
      symbol,
      company,
      type,
      attachment_url: attachmentUrl,
      sourceAnnouncements,
      insertedAt: existingItem?.insertedAt ?? new Date().toISOString(),
      sortTimestampMs: Number.isFinite(sortTimestampMs) ? sortTimestampMs : 0,
      primaryExchange: fallbackExchange
    };

    const nseListing = normalizedRecord.isin ? nseListingByIsin.get(normalizedRecord.isin) ?? null : null;
    if (nseListing) {
      normalizedRecord.symbol = nseListing.symbol || normalizedRecord.symbol;
      normalizedRecord.company = nseListing.company || normalizedRecord.company;
      normalizedRecord.hasNseListing = true;
    } else {
      normalizedRecord.hasNseListing = Boolean(existingItem?.hasNseListing);
    }

    dedupMap.set(baseKey, normalizedRecord);
    dedupAnnouncements.push(normalizedRecord);
  }

  const normalizedSourceItems = await mapWithConcurrency(sourceItems, pdfHashConcurrency, async (item, index) => {
    const exchange = getExchangeValue(item?.exchange ?? "NSE");
    const sourceAnnouncements = dedupeSourceAnnouncements(item?.sourceAnnouncements, exchange);
    const primarySource = sourceAnnouncements[0] ?? normalizeSourceAnnouncement(
      {
        sourceKey: normalizeText(item?.sourceKey),
        exchange,
        announcementKey: normalizeText(item?.sourceAnnouncementKey ?? item?.announcementKey ?? item?.mergedAnnouncementKey),
        timestamp: normalizeText(item?.timestamp),
        symbol: normalizeText(item?.symbol),
        company: normalizeText(item?.company),
        type: normalizeText(item?.type),
        attachmentUrl: normalizeText(item?.attachment_url),
        isin: normalizeIsin(item?.isin)
      },
      exchange
    );
    const sourceKey =
      normalizeText(primarySource?.sourceKey) ||
      `${exchange}:${normalizeText(item?.announcementKey ?? item?.mergedAnnouncementKey ?? String(index))}`;
    const isin = normalizeIsin(item?.isin ?? primarySource?.isin);
    if (isin) {
      withIsinCount += 1;
    } else {
      missingIsinCount += 1;
    }

    const attachmentUrl = normalizeText(item?.attachment_url ?? primarySource?.attachmentUrl);
    const pdfHash = await resolvePdfHash(attachmentUrl);
    if (pdfHash) {
      withPdfHashCount += 1;
    } else {
      missingPdfHashCount += 1;
    }

    const nseListing = isin ? nseListingByIsin.get(isin) ?? null : null;
    const displaySymbol = nseListing?.symbol || normalizeText(item?.symbol ?? (primarySource?.symbol || "-")) || "-";
    const displayCompany = nseListing?.company || normalizeText(item?.company ?? (primarySource?.company || "-")) || "-";
    const timestamp = normalizeText(item?.timestamp ?? (primarySource?.timestamp || "-")) || "-";
    const type = normalizeText(item?.type ?? (primarySource?.type || "-")) || "-";
    const sortTimestampMs = parseTimestampToMillis(timestamp) ?? parseTimestampToMillis(item?.insertedAt) ?? 0;

    return {
      exchange,
      sourceKey,
      sourceAnnouncements: sourceAnnouncements.length > 0 ? sourceAnnouncements : [primarySource],
      isin,
      pdfHash,
      attachmentUrl: attachmentUrl || null,
      symbol: displaySymbol,
      company: displayCompany,
      type,
      timestamp,
      hasNseListing: Boolean(nseListing),
      insertedAt: item?.insertedAt ?? new Date().toISOString(),
      sortTimestampMs
    };
  });

  let sourceDedupedCount = 0;
  const touchedDedupKeys = new Set();

  for (const item of normalizedSourceItems) {
    const dedupeKey = item.isin && item.pdfHash ? `ISIN:${item.isin}|PDF:${item.pdfHash}` : `SOURCE:${item.sourceKey}`;
    touchedDedupKeys.add(dedupeKey);
    const existing = dedupMap.get(dedupeKey);

    if (!existing) {
      const record = {
        exchange: item.exchange,
        exchanges: [item.exchange],
        mergedFromCount: 1,
        dedupAnnouncementKey: dedupeKey,
        mergedAnnouncementKey: dedupeKey,
        announcementKey: dedupeKey,
        dedupeStrategy: item.isin && item.pdfHash ? "isin+pdf-hash" : "source-key-fallback",
        isin: item.isin,
        pdf_hash: item.pdfHash,
        timestamp: item.timestamp,
        symbol: item.symbol,
        company: item.company,
        hasNseListing: item.hasNseListing,
        type: item.type,
        attachment_url: item.attachmentUrl,
        sourceAnnouncements: item.sourceAnnouncements,
        insertedAt: item.insertedAt,
        sortTimestampMs: item.sortTimestampMs,
        primaryExchange: item.exchange
      };

      dedupMap.set(dedupeKey, record);
      dedupAnnouncements.push(record);
      continue;
    }

    sourceDedupedCount += 1;
    existing.sourceAnnouncements = mergeSourceAnnouncementLists(existing.sourceAnnouncements, item.sourceAnnouncements, item.exchange);
    existing.exchanges = mergeSortedUnique([...existing.exchanges, item.exchange]);
    existing.exchange = existing.exchanges.length > 1 ? "NSE+BSE" : existing.exchanges[0];
    existing.mergedFromCount = existing.sourceAnnouncements.length;
    existing.isin = existing.isin ?? item.isin;
    existing.pdf_hash = existing.pdf_hash ?? item.pdfHash;
    existing.attachment_url = existing.attachment_url || item.attachmentUrl;
    existing.hasNseListing = existing.hasNseListing || item.hasNseListing;

    if (shouldPreferDedupCandidate(existing, item)) {
      existing.timestamp = item.timestamp;
      existing.symbol = item.symbol;
      existing.company = item.company;
      existing.type = item.type;
      if (item.attachmentUrl) {
        existing.attachment_url = item.attachmentUrl;
      }
      existing.insertedAt = item.insertedAt;
      existing.sortTimestampMs = item.sortTimestampMs;
      existing.primaryExchange = item.exchange;
    }

    const nseListing = existing.isin ? nseListingByIsin.get(existing.isin) ?? null : null;
    if (nseListing) {
      existing.symbol = nseListing.symbol || existing.symbol;
      existing.company = nseListing.company || existing.company;
      existing.hasNseListing = true;
    }
  }

  dedupAnnouncements.sort((left, right) => {
    const sortDiff = (right.sortTimestampMs ?? 0) - (left.sortTimestampMs ?? 0);
    if (sortDiff !== 0) {
      return sortDiff;
    }

    return String(right.insertedAt ?? "").localeCompare(String(left.insertedAt ?? ""));
  });

  const mergedRecordCount = dedupAnnouncements.reduce((count, item) => count + (item.mergedFromCount > 1 ? 1 : 0), 0);

  return {
    announcements: dedupAnnouncements,
    touchedDedupKeys: Array.from(touchedDedupKeys),
    stats: {
      inputCount: sourceItems.length,
      baselineCount: baseAnnouncements.length,
      dedupCount: sourceDedupedCount,
      mergedRecordCount,
      dedupedCount: dedupAnnouncements.length,
      touchedCount: touchedDedupKeys.size,
      withIsinCount,
      missingIsinCount,
      withPdfHashCount,
      missingPdfHashCount,
      hashedUrlCount: pdfHashCache.size,
      preloadedPdfHashCount
    }
  };
}

async function refreshCombinedAnnouncements(trigger = "manual", force = false) {
  const store = stores.COMBINED;

  if (store.syncInFlight) {
    if (!force) {
      return store.syncInFlight;
    }

    try {
      await store.syncInFlight;
    } catch {
      // Swallow in-flight error and continue with a forced refresh.
    }
  }

  store.syncInFlight = (async () => {
    await Promise.all([loadStore("NSE"), loadStore("BSE")]);

    const fingerprint = buildCombinedSourceFingerprint();
    const sourceNseSyncAt = stores.NSE.lastSyncAt ?? null;
    const sourceBseSyncAt = stores.BSE.lastSyncAt ?? null;
    const combinedSourceNseSyncAt =
      typeof store.lastSyncStats?.sourceNseSyncAt === "string" ? store.lastSyncStats.sourceNseSyncAt : null;
    const combinedSourceBseSyncAt =
      typeof store.lastSyncStats?.sourceBseSyncAt === "string" ? store.lastSyncStats.sourceBseSyncAt : null;
    const sourceUnchanged = store.sourceFingerprint === fingerprint;
    if (!force && store.loaded && sourceUnchanged) {
      if (store.lastSyncStats && typeof store.lastSyncStats === "object") {
        return {
          ...store.lastSyncStats,
          trigger,
          skipped: true,
          totalStored: store.announcements.length,
          syncedAt: store.lastSyncAt
        };
      }

      return {
        exchange: "COMBINED",
        trigger,
        dedupeRule: "None (NSE+BSE raw union)",
        skipped: true,
        totalStored: store.announcements.length,
        syncedAt: store.lastSyncAt
      };
    }

    const result = buildCombinedAnnouncements();
    store.announcements = result.announcements;
    store.keys = new Set(store.announcements.map((item) => getAnnouncementKey("COMBINED", item)).filter(Boolean));

    const trimmedCount = trimStore("COMBINED");
    store.lastSyncAt = new Date().toISOString();
    store.lastSyncStats = {
      exchange: "COMBINED",
      trigger,
      dedupeRule: "None (NSE+BSE raw union)",
      inputCount: result.stats.inputCount,
      uniqueSourceCount: result.stats.uniqueSourceCount,
      sourceDedupedCount: result.stats.sourceDedupedCount,
      crossExchangeMergedCount: result.stats.crossExchangeMergedCount,
      mergedRecordCount: result.stats.mergedRecordCount,
      withIsinCount: result.stats.withIsinCount,
      missingIsinCount: result.stats.missingIsinCount,
      sourceNseSyncAt,
      sourceBseSyncAt,
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

async function refreshDedupAnnouncements(trigger = "manual", force = false) {
  const store = stores.DEDUP;

  if (store.syncInFlight) {
    if (!force) {
      return store.syncInFlight;
    }

    try {
      await store.syncInFlight;
    } catch {
      // Swallow in-flight error and continue with a forced refresh.
    }
  }

  store.syncInFlight = (async () => {
    await Promise.all([loadStore("NSE"), loadStore("BSE"), loadStore("COMBINED")]);
    await refreshCombinedAnnouncements(trigger);

    const fingerprint = buildDedupSourceFingerprint();
    const sourceCombinedSyncAt = stores.COMBINED.lastSyncAt ?? null;
    const dedupSourceSyncAt =
      typeof store.lastSyncStats?.sourceCombinedSyncAt === "string" ? store.lastSyncStats.sourceCombinedSyncAt : null;
    const sourceUnchanged = store.sourceFingerprint === fingerprint;
    if (!force && store.loaded && sourceUnchanged) {
      if (store.lastSyncStats && typeof store.lastSyncStats === "object") {
        return {
          ...store.lastSyncStats,
          trigger,
          skipped: true,
          touchedDedupKeys: [],
          sourceCombinedSyncAt: sourceCombinedSyncAt ?? dedupSourceSyncAt ?? null,
          totalStored: store.announcements.length,
          syncedAt: store.lastSyncAt
        };
      }

      return {
        exchange: "DEDUP",
        trigger,
        dedupeRule: "ISIN + PDF hash",
        skipped: true,
        touchedDedupKeys: [],
        sourceCombinedSyncAt: sourceCombinedSyncAt ?? dedupSourceSyncAt ?? null,
        totalStored: store.announcements.length,
        syncedAt: store.lastSyncAt
      };
    }

    const incrementalMode = !force && Array.isArray(store.announcements) && store.announcements.length > 0;
    const sourceCandidates = incrementalMode ? selectDedupSourceCandidates() : [...stores.COMBINED.announcements];
    const result = await buildDedupAnnouncements({
      sourceItems: sourceCandidates,
      baseAnnouncements: incrementalMode ? store.announcements : []
    });
    store.announcements = result.announcements;
    store.keys = new Set(store.announcements.map((item) => getAnnouncementKey("DEDUP", item)).filter(Boolean));

    const trimmedCount = trimStore("DEDUP");
    const safeLookbackHours = normalizePositiveInt(dedupIncrementalLookbackHours, 48);
    const safeMinCandidates = normalizePositiveInt(dedupIncrementalMinCandidates, 400);
    const safeMaxCandidates = Math.max(safeMinCandidates, normalizePositiveInt(dedupIncrementalMaxCandidates, 2500));
    store.lastSyncAt = new Date().toISOString();
    store.lastSyncStats = {
      exchange: "DEDUP",
      trigger,
      dedupeRule: "ISIN + PDF hash",
      mode: incrementalMode ? "incremental" : "full",
      incrementalLookbackHours: safeLookbackHours,
      incrementalMinCandidates: safeMinCandidates,
      incrementalMaxCandidates: safeMaxCandidates,
      candidateSourceCount: sourceCandidates.length,
      inputCount: result.stats.inputCount,
      baselineCount: result.stats.baselineCount,
      touchedCount: result.stats.touchedCount,
      dedupCount: result.stats.dedupCount,
      mergedRecordCount: result.stats.mergedRecordCount,
      dedupedCount: result.stats.dedupedCount,
      withIsinCount: result.stats.withIsinCount,
      missingIsinCount: result.stats.missingIsinCount,
      withPdfHashCount: result.stats.withPdfHashCount,
      missingPdfHashCount: result.stats.missingPdfHashCount,
      hashedUrlCount: result.stats.hashedUrlCount,
      preloadedPdfHashCount: result.stats.preloadedPdfHashCount,
      sourceCombinedSyncAt,
      totalStored: store.announcements.length,
      trimmedCount,
      syncedAt: store.lastSyncAt
    };
    store.sourceFingerprint = fingerprint;
    store.loaded = true;

    await persistStore("DEDUP");
    return {
      ...store.lastSyncStats,
      touchedDedupKeys: Array.isArray(result.touchedDedupKeys) ? result.touchedDedupKeys : []
    };
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
    } else if (exchange === "DEDUP" && typeof parsed?.lastDedupSyncAt === "string") {
      store.lastSyncAt = parsed.lastDedupSyncAt;
    }

    if (parsed?.lastSyncStats && typeof parsed.lastSyncStats === "object") {
      store.lastSyncStats = parsed.lastSyncStats;
    } else if (exchange === "NSE" && parsed?.lastNseSyncStats && typeof parsed.lastNseSyncStats === "object") {
      store.lastSyncStats = parsed.lastNseSyncStats;
    } else if (exchange === "BSE" && parsed?.lastBseSyncStats && typeof parsed.lastBseSyncStats === "object") {
      store.lastSyncStats = parsed.lastBseSyncStats;
    } else if (exchange === "COMBINED" && parsed?.lastCombinedSyncStats && typeof parsed.lastCombinedSyncStats === "object") {
      store.lastSyncStats = parsed.lastCombinedSyncStats;
    } else if (exchange === "DEDUP" && parsed?.lastDedupSyncStats && typeof parsed.lastDedupSyncStats === "object") {
      store.lastSyncStats = parsed.lastDedupSyncStats;
    }

    if (typeof parsed?.sourceFingerprint === "string") {
      store.sourceFingerprint = parsed.sourceFingerprint;
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
          : exchange === "DEDUP"
            ? {
                lastDedupSyncAt: store.lastSyncAt,
                lastDedupSyncStats: store.lastSyncStats
              }
          : {};

  await mkdir(dirname(store.storagePath), { recursive: true });
  await writeFile(
    store.storagePath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        exchange,
        sourceFingerprint: typeof store.sourceFingerprint === "string" ? store.sourceFingerprint : null,
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

function requireCronSecret(req, res, failureMessage = "Invalid cron secret.") {
  if (!cronSecret) {
    return true;
  }

  const providedSecret = req.headers["x-cron-secret"];
  if (providedSecret === cronSecret) {
    return true;
  }

  sendJson(req, res, 401, { error: failureMessage });
  return false;
}

function serializeSettledResult(settledResult) {
  if (!settledResult || typeof settledResult !== "object") {
    return null;
  }

  if (settledResult.status === "fulfilled") {
    return settledResult.value;
  }

  return {
    error: settledResult.reason instanceof Error ? settledResult.reason.message : "Unknown error"
  };
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

  if (exchange === "NSE+BSE" || exchange === "BSE+NSE" || exchange === "COMBINED" || exchange === "DEDUP") {
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
  await Promise.all([loadStore("NSE"), loadStore("BSE"), loadStore("COMBINED"), loadStore("DEDUP"), loadAiLabelStore()]);

  const requestedLimit = Number.parseInt(requestUrl.searchParams.get("limit") ?? "100", 10);
  const limit = Math.min(Math.max(normalizePositiveInt(requestedLimit, 100), 1), 500);
  const requestedOffset = Number.parseInt(requestUrl.searchParams.get("offset") ?? "0", 10);
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0);
  const exchangeQuery = String(requestUrl.searchParams.get("exchange") ?? "NSE")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
  const symbolFilter = String(requestUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();

  const selectedExchange =
    exchangeQuery === "BSE"
      ? "BSE"
      : exchangeQuery === "DEDUP"
        ? "DEDUP"
      : exchangeQuery === "ALL"
        ? "ALL"
        : exchangeQuery === "BSE+NSE" ||
            exchangeQuery === "NSE+BSE" ||
            exchangeQuery === "BSENSE" ||
            exchangeQuery === "NSEBSE" ||
            exchangeQuery === "COMBINED"
          ? "NSE+BSE"
          : "NSE";

  const sourceAnnouncements =
    selectedExchange === "ALL"
      ? [...stores.NSE.announcements, ...stores.BSE.announcements]
      : selectedExchange === "NSE+BSE"
        ? [...stores.COMBINED.announcements]
        : selectedExchange === "DEDUP"
          ? [...stores.DEDUP.announcements]
        : [...stores[selectedExchange].announcements];

  const filtered = sourceAnnouncements.filter((item) => {
    const filterExchange =
      selectedExchange === "NSE+BSE"
        ? "COMBINED"
        : selectedExchange === "DEDUP"
          ? "DEDUP"
          : getExchangeValue(item?.exchange ?? selectedExchange);
    return matchSymbolFilter(item, filterExchange, symbolFilter);
  });

  const lastSyncAt =
    selectedExchange === "ALL"
      ? { NSE: stores.NSE.lastSyncAt, BSE: stores.BSE.lastSyncAt }
      : selectedExchange === "NSE+BSE"
        ? stores.COMBINED.lastSyncAt
        : selectedExchange === "DEDUP"
          ? stores.DEDUP.lastSyncAt
        : stores[selectedExchange].lastSyncAt;

  const lastSyncStats =
    selectedExchange === "ALL"
      ? { NSE: stores.NSE.lastSyncStats, BSE: stores.BSE.lastSyncStats }
      : selectedExchange === "NSE+BSE"
        ? stores.COMBINED.lastSyncStats
        : selectedExchange === "DEDUP"
          ? stores.DEDUP.lastSyncStats
        : stores[selectedExchange].lastSyncStats;

  const slicedAnnouncements = filtered.slice(offset, offset + limit);
  const announcements =
    selectedExchange === "DEDUP" ? slicedAnnouncements.map((item) => enrichDedupAnnouncementWithAi(item)) : slicedAnnouncements;

  sendJson(req, res, 200, {
    exchange: selectedExchange,
    announcements,
    total: filtered.length,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    totalPages: Math.max(1, Math.ceil(filtered.length / limit)),
    lastSyncAt,
    lastSyncStats,
    lastNseSyncAt: stores.NSE.lastSyncAt,
    lastNseSyncStats: stores.NSE.lastSyncStats,
    lastBseSyncAt: stores.BSE.lastSyncAt,
    lastBseSyncStats: stores.BSE.lastSyncStats,
    lastCombinedSyncAt: stores.COMBINED.lastSyncAt,
    lastCombinedSyncStats: stores.COMBINED.lastSyncStats,
    lastDedupSyncAt: stores.DEDUP.lastSyncAt,
    lastDedupSyncStats: stores.DEDUP.lastSyncStats
  });
}

async function handleCronRun(req, res) {
  if (!requireCronSecret(req, res, "Invalid cron secret.")) {
    return;
  }

  const body = await readJsonBody(req);
  const trigger = String(body.trigger ?? "unknown");
  const aiRequest = body?.ai && typeof body.ai === "object" ? body.ai : null;
  const aiForceEnabled = Boolean(aiRequest?.enabled);
  const aiMaxItemsRequestRaw = Number.parseInt(String(aiRequest?.maxItems ?? ""), 10);
  const aiMaxItemsRequest = Number.isFinite(aiMaxItemsRequestRaw) && aiMaxItemsRequestRaw > 0 ? aiMaxItemsRequestRaw : null;

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
  const nseNewCount = nseResult.status === "fulfilled" ? Number(nseResult.value?.newCount ?? 0) : 0;
  const bseNewCount = bseResult.status === "fulfilled" ? Number(bseResult.value?.newCount ?? 0) : 0;
  const hasNewSourceRows = nseNewCount > 0 || bseNewCount > 0;
  const shouldRefreshDerived =
    hasNewSourceRows || stores.COMBINED.announcements.length === 0 || stores.DEDUP.announcements.length === 0;

  const combinedResult = shouldRefreshDerived
    ? await refreshCombinedAnnouncements(trigger)
        .then((value) => ({ status: "fulfilled", value }))
        .catch((reason) => ({ status: "rejected", reason }))
    : {
        status: "fulfilled",
        value: {
          exchange: "COMBINED",
          trigger,
          dedupeRule: "None (NSE+BSE raw union)",
          skipped: true,
          reason: "no-new-source-data",
          totalStored: stores.COMBINED.announcements.length,
          syncedAt: stores.COMBINED.lastSyncAt
        }
      };
  const dedupResult = shouldRefreshDerived
    ? await refreshDedupAnnouncements(trigger)
        .then((value) => ({ status: "fulfilled", value }))
        .catch((reason) => ({ status: "rejected", reason }))
    : {
        status: "fulfilled",
        value: {
          exchange: "DEDUP",
          trigger,
          dedupeRule: "ISIN + PDF hash",
          skipped: true,
          reason: "no-new-source-data",
          sourceCombinedSyncAt: stores.COMBINED.lastSyncAt ?? null,
          totalStored: stores.DEDUP.announcements.length,
          syncedAt: stores.DEDUP.lastSyncAt
        }
      };

  const aiClassificationResult =
    dedupResult.status === "fulfilled"
      ? await runAiClassificationCron(trigger, dedupResult.value?.touchedDedupKeys, {
          forceEnabled: aiForceEnabled,
          maxItems: aiMaxItemsRequest
        })
          .then((value) => ({ status: "fulfilled", value }))
          .catch((reason) => ({ status: "rejected", reason }))
      : {
          status: "fulfilled",
          value: {
            trigger,
            skipped: true,
            reason: "dedup-sync-failed",
            processedCount: 0,
            successCount: 0,
            failureCount: 0
          }
        };

  const responsePayload = {
    ok:
      nseResult.status === "fulfilled" &&
      bseResult.status === "fulfilled" &&
      combinedResult.status === "fulfilled" &&
      dedupResult.status === "fulfilled" &&
      aiClassificationResult.status === "fulfilled",
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
        : { error: combinedResult.reason instanceof Error ? combinedResult.reason.message : "Unknown combined sync error" },
    dedupSync:
      dedupResult.status === "fulfilled"
        ? dedupResult.value
        : { error: dedupResult.reason instanceof Error ? dedupResult.reason.message : "Unknown dedup sync error" },
    aiClassification:
      aiClassificationResult.status === "fulfilled"
        ? aiClassificationResult.value
        : {
            error:
              aiClassificationResult.reason instanceof Error
                ? aiClassificationResult.reason.message
                : "Unknown AI classification error"
          }
  };

  if (responsePayload.ok) {
    sendJson(req, res, 200, responsePayload);
    return;
  }

  log("Cron sync finished with errors", responsePayload);
  sendJson(req, res, 502, responsePayload);
}

async function handleAiOnlyRun(req, res) {
  if (!requireCronSecret(req, res, "Invalid AI job secret.")) {
    return;
  }

  const body = await readJsonBody(req);
  const trigger = String(body.trigger ?? "unknown");
  const aiRequest = body?.ai && typeof body.ai === "object" ? body.ai : null;
  const aiForceEnabled = aiRequest?.enabled === undefined ? true : Boolean(aiRequest?.enabled);
  const aiMaxItemsRequestRaw = Number.parseInt(String(aiRequest?.maxItems ?? ""), 10);
  const aiMaxItemsRequest = Number.isFinite(aiMaxItemsRequestRaw) && aiMaxItemsRequestRaw > 0 ? aiMaxItemsRequestRaw : null;
  const aiRecentPoolRaw = Number.parseInt(String(aiRequest?.recentCandidatePool ?? ""), 10);
  const aiRecentPool = Number.isFinite(aiRecentPoolRaw) && aiRecentPoolRaw > 0 ? aiRecentPoolRaw : null;
  const effectiveTrigger = trigger || "manual-ai-only";

  aiOnlyRunCount += 1;
  lastAiOnlyRunAt = new Date().toISOString();

  log("AI-only run received", {
    runCount: aiOnlyRunCount,
    trigger: effectiveTrigger,
    maxItems: aiMaxItemsRequest,
    forceEnabled: aiForceEnabled
  });

  await Promise.all([loadStore("NSE"), loadStore("BSE"), loadStore("COMBINED"), loadStore("DEDUP"), loadAiLabelStore()]);

  let combinedPrep = null;
  let dedupPrep = null;

  if (stores.COMBINED.announcements.length === 0 && (stores.NSE.announcements.length > 0 || stores.BSE.announcements.length > 0)) {
    combinedPrep = await refreshCombinedAnnouncements(`${effectiveTrigger}-ai-only-prepare`)
      .then((value) => ({ status: "fulfilled", value }))
      .catch((reason) => ({ status: "rejected", reason }));
  }

  if (stores.DEDUP.announcements.length === 0 && stores.COMBINED.announcements.length > 0) {
    dedupPrep = await refreshDedupAnnouncements(`${effectiveTrigger}-ai-only-prepare`)
      .then((value) => ({ status: "fulfilled", value }))
      .catch((reason) => ({ status: "rejected", reason }));
  }

  const aiClassificationResult =
    await runAiClassificationCron(effectiveTrigger, [], {
      forceEnabled: aiForceEnabled,
      maxItems: aiMaxItemsRequest,
      scanRecentWhenNoTouched: true,
      recentCandidatePool: aiRecentPool
    })
      .then((value) => ({ status: "fulfilled", value }))
      .catch((reason) => ({ status: "rejected", reason }));

  const responsePayload = {
    ok: aiClassificationResult.status === "fulfilled",
    runCount: aiOnlyRunCount,
    lastAiOnlyRunAt,
    dedupSnapshot: {
      totalStored: stores.DEDUP.announcements.length,
      lastDedupSyncAt: stores.DEDUP.lastSyncAt
    },
    prep:
      combinedPrep || dedupPrep
        ? {
            combined:
              combinedPrep?.status === "fulfilled"
                ? combinedPrep.value
                : combinedPrep
                  ? { error: combinedPrep.reason instanceof Error ? combinedPrep.reason.message : "Unknown error" }
                  : null,
            dedup:
              dedupPrep?.status === "fulfilled"
                ? dedupPrep.value
                : dedupPrep
                  ? { error: dedupPrep.reason instanceof Error ? dedupPrep.reason.message : "Unknown error" }
                  : null
          }
        : null,
    aiClassification:
      aiClassificationResult.status === "fulfilled"
        ? aiClassificationResult.value
        : {
            error:
              aiClassificationResult.reason instanceof Error
                ? aiClassificationResult.reason.message
                : "Unknown AI classification error"
          }
  };

  if (responsePayload.ok) {
    sendJson(req, res, 200, responsePayload);
    return;
  }

  log("AI-only classification run finished with errors", responsePayload);
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
  await Promise.all([loadStore("NSE"), loadStore("BSE"), loadStore("COMBINED"), loadStore("DEDUP"), loadAiLabelStore()]);

  const aiSuccessCount = aiLabelStore.records.filter(
    (record) => normalizeText(record?.criteriaVersion) === aiCriteriaVersion && normalizeText(record?.status) === "SUCCESS"
  ).length;
  const aiFailureCount = aiLabelStore.records.filter(
    (record) => normalizeText(record?.criteriaVersion) === aiCriteriaVersion && normalizeText(record?.status) === "FAILED"
  ).length;

  sendJson(req, res, 200, {
    service: appName,
    env: appEnv,
    serverTime: new Date().toISOString(),
    notesCount: notes.length,
    cronRunCount,
    lastCronRunAt,
    aiOnlyRunCount,
    lastAiOnlyRunAt,
    workerHeartbeatCount,
    lastWorkerHeartbeatAt,
    nseAnnouncementsCount: stores.NSE.announcements.length,
    bseAnnouncementsCount: stores.BSE.announcements.length,
    combinedAnnouncementsCount: stores.COMBINED.announcements.length,
    dedupAnnouncementsCount: stores.DEDUP.announcements.length,
    lastNseSyncAt: stores.NSE.lastSyncAt,
    lastNseSyncStats: stores.NSE.lastSyncStats,
    lastBseSyncAt: stores.BSE.lastSyncAt,
    lastBseSyncStats: stores.BSE.lastSyncStats,
    lastCombinedSyncAt: stores.COMBINED.lastSyncAt,
    lastCombinedSyncStats: stores.COMBINED.lastSyncStats,
    lastDedupSyncAt: stores.DEDUP.lastSyncAt,
    lastDedupSyncStats: stores.DEDUP.lastSyncStats,
    aiCriteriaVersion,
    aiClassifierEnabled,
    aiProviderKeysConfigured: {
      openai: Boolean(aiOpenAiApiKey),
      gemini: Boolean(aiGeminiApiKey),
      anthropic: Boolean(aiAnthropicApiKey)
    },
    aiClassificationRuntimeEnabled: isAiClassificationEnabled(),
    aiLabelsCount: aiLabelStore.records.length,
    aiLabelsSuccessCount: aiSuccessCount,
    aiLabelsFailureCount: aiFailureCount,
    aiLabelsLastSyncAt: aiLabelStore.lastSyncAt
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
          "GET /api/notifications/announcements?exchange=NSE|BSE|NSE+BSE|DEDUP|ALL&limit=100&symbol=TCS",
          "POST /api/jobs/daily",
          "POST /api/jobs/ai-only"
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

    if (method === "POST" && requestUrl.pathname === "/api/jobs/ai-only") {
      await handleAiOnlyRun(req, res);
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

Promise.all([loadStore("NSE"), loadStore("BSE"), loadStore("COMBINED"), loadStore("DEDUP"), loadAiLabelStore()])
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
