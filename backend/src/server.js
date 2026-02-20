import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
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
const pdfHashConcurrency = Number.parseInt(process.env.PDF_HASH_CONCURRENCY ?? "2", 10);
const aiLabelsStoragePath = resolve(process.cwd(), process.env.AI_LABELS_STORAGE_FILE ?? "data/announcement_ai_labels.json");
const aiReviewsStoragePath = resolve(process.cwd(), process.env.AI_REVIEWS_STORAGE_FILE ?? "data/announcement_ai_reviews.json");
const aiSuggestionsStoragePath = resolve(
  process.cwd(),
  process.env.AI_SUGGESTIONS_STORAGE_FILE ?? "data/announcement_ai_suggestions.json"
);
const aiCriteriaVersion = process.env.AI_CRITERIA_VERSION ?? "v2";
const aiClassifierEnabled = normalizeText(process.env.AI_CLASSIFIER_ENABLED ?? "false").toLowerCase() === "true";
const aiPromptLearningMinExamples = Number.parseInt(process.env.AI_PROMPT_LEARNING_MIN_EXAMPLES ?? "1", 10);
const aiPromptLearningMaxRules = Number.parseInt(process.env.AI_PROMPT_LEARNING_MAX_RULES ?? "8", 10);
const aiMaxItemsPerCron = Number.parseInt(process.env.AI_MAX_ITEMS_PER_CRON ?? "60", 10);
const aiConcurrency = Number.parseInt(process.env.AI_CLASSIFICATION_CONCURRENCY ?? "2", 10);
const aiClassificationBatchSize = Number.parseInt(process.env.AI_CLASSIFICATION_BATCH_SIZE ?? "8", 10);
const aiMaxRssMb = Number.parseInt(process.env.AI_MAX_RSS_MB ?? "420", 10);
const aiPersistCheckpointEvery = Number.parseInt(process.env.AI_PERSIST_CHECKPOINT_EVERY ?? "20", 10);
const aiPendingBacklogShare = Number.parseFloat(process.env.AI_PENDING_BACKLOG_SHARE ?? "0.75");
const aiPdfFetchTimeoutMs = Number.parseInt(process.env.AI_PDF_FETCH_TIMEOUT_MS ?? "30000", 10);
const aiPdfFetchMaxAttempts = Number.parseInt(process.env.AI_PDF_FETCH_MAX_ATTEMPTS ?? "3", 10);
const aiPdfParseMaxAttempts = Number.parseInt(process.env.AI_PDF_PARSE_MAX_ATTEMPTS ?? "2", 10);
const aiPdfRetryDelayMs = Number.parseInt(process.env.AI_PDF_RETRY_DELAY_MS ?? "1200", 10);
const aiPdfMinBytes = Number.parseInt(process.env.AI_PDF_MIN_BYTES ?? "1024", 10);
const aiGeminiMaxPdfBytes = Number.parseInt(process.env.AI_GEMINI_MAX_PDF_BYTES ?? "12582912", 10);
const aiPrimaryMaxPages = Number.parseInt(process.env.AI_PRIMARY_MAX_PAGES ?? "4", 10);
const aiEscalationMaxPages = Number.parseInt(process.env.AI_ESCALATION_MAX_PAGES ?? "12", 10);
const aiEscalationConfidenceThreshold = Number.parseFloat(process.env.AI_ESCALATION_CONFIDENCE_THRESHOLD ?? "0.8");
const aiMinReadableChars = Number.parseInt(process.env.AI_MIN_READABLE_CHARS ?? "700", 10);
const aiFailureRetryHours = Number.parseInt(process.env.AI_FAILURE_RETRY_HOURS ?? "24", 10);
const aiTransientFailureRetryMinutes = Number.parseInt(process.env.AI_TRANSIENT_FAILURE_RETRY_MINUTES ?? "60", 10);
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
const databaseUrl = normalizeText(process.env.DATABASE_URL ?? "");
const databaseSslMode = normalizeText(
  process.env.DATABASE_SSL_MODE ?? (appEnv === "production" ? "require" : "disable")
).toLowerCase();
const databaseMaxConnections = Number.parseInt(process.env.DATABASE_MAX_CONNECTIONS ?? "10", 10);
const databaseConnectionTimeoutMs = Number.parseInt(process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? "10000", 10);
const databaseIdleTimeoutMs = Number.parseInt(process.env.DATABASE_IDLE_TIMEOUT_MS ?? "30000", 10);

const databaseSnapshotTable = "announcement_snapshots";
const databaseStoreSnapshotPrefix = "store:";
const databaseAiLabelSnapshotKey = "ai-labels";
const databaseAiReviewSnapshotKey = "ai-reviews";
const databaseAiSuggestionSnapshotKey = "ai-suggestions";
const databaseBackgroundJobsTable = "background_jobs";
const backgroundJobTypeAiClassification = "ai-classification";
const backgroundJobStatuses = new Set(["queued", "running", "completed", "failed"]);
const aiAsyncChunkSizeDefault = Number.parseInt(process.env.AI_ASYNC_CHUNK_SIZE ?? "10", 10);
const aiAsyncMaxLoopsDefault = Number.parseInt(process.env.AI_ASYNC_MAX_LOOPS ?? "120", 10);
const cronWindowEnabled = true;
const cronWindowTimezone = "Asia/Kolkata";
const cronWindowStartHour = 9;
const cronWindowEndHour = 21;
const enableLegacyJobEndpoints = false;
const apiSnapshotRefreshIntervalMsRaw = Number.parseInt(process.env.API_SNAPSHOT_REFRESH_INTERVAL_MS ?? "60000", 10);
const apiSnapshotRefreshIntervalMs =
  Number.isFinite(apiSnapshotRefreshIntervalMsRaw) && apiSnapshotRefreshIntervalMsRaw >= 10_000
    ? Math.floor(apiSnapshotRefreshIntervalMsRaw)
    : 60_000;

const notes = [];
let noteId = 1;
let cronRunCount = 0;
let lastCronRunAt = null;
let aiOnlyRunCount = 0;
let lastAiOnlyRunAt = null;
let aiChunkRunCount = 0;
let lastAiChunkRunAt = null;
let workerHeartbeatCount = 0;
let lastWorkerHeartbeatAt = null;
let storeWarmupPromise = null;
let apiSnapshotRefreshTimer = null;
let apiSnapshotRefreshInFlight = null;
let apiSnapshotRefreshCount = 0;
let lastApiSnapshotRefreshAt = null;
let lastApiSnapshotRefreshError = null;

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
  "substantial_transaction",
  "share_pledge",
  "change_in_auditor",
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
  substantial_transaction:
    "Major acquisition/disposal by a significant shareholder who is not disclosed as promoter/KMP/insider.",
  share_pledge: "Pledge/unpledge of promoter/KMP shares.",
  change_in_auditor: "Appointment/resignation/replacement/reclassification of statutory or secretarial auditor.",
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
const aiCategorySet = new Set(aiClassificationCategories);

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

const aiSystemPromptBaseSections = [
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
  "8) Auditor appointment/resignation/replacement maps to change_in_auditor.",
  "9) Major shareholding transactions by non-promoter/non-insider holders map to substantial_transaction.",
  "Allowed categories and concise guidance:",
  aiCategoryGuidanceText,
  "Set needs_escalation true when confidence is below 0.8 or evidence is weak."
];
const aiManualPromptRules = [
  "If the filing is a schedule/intimation of analyst or institutional investor meetings (one-on-one/group, physical/virtual), classify as analyst_meeting unless it explicitly states the interaction is an earnings/results call.",
  "Use earning_call_registration only when the meeting/call is explicitly tied to discussion of quarterly/annual financial results or earnings performance.",
  "Letters to shareholders/CEO narrative updates remain others even if they casually mention rescheduling a call; do not classify these as analyst_meeting unless the primary document purpose is a formal analyst/investor meet notice.",
  "For continuation updates that reference prior intimations and forward a material-subsidiary disclosure tied to a strategic transaction context, prefer ma (or divestment if the text indicates disposal/loss of control) instead of others.",
  "If the update mentions transaction-progress regulators/approvals (for example Competition Commission of India/CCI, combination approval, scheme sanction, merger or acquisition closing steps), classify as ma unless it clearly indicates disposal or loss of control (then divestment).",
  "Use substantial_transaction only for sizeable holding changes by non-promoter/non-insider investors; promoter/KMP/insider trades stay in insider_trading or share_pledge as applicable.",
  "Use change_in_auditor for statutory/secretarial auditor appointment, resignation, removal, cessation or replacement disclosures."
];

const aiLabelStore = {
  loaded: false,
  syncInFlight: null,
  records: [],
  byKey: new Map(),
  byInputHash: new Map(),
  lastSyncAt: null
};

const aiReviewStore = {
  loaded: false,
  syncInFlight: null,
  records: [],
  byKey: new Map(),
  lastSyncAt: null
};
const aiSuggestionStore = {
  loaded: false,
  syncInFlight: null,
  records: [],
  byId: new Map(),
  lastSyncAt: null
};
const aiPromptLearningCache = {
  fingerprint: "",
  rules: []
};

const { Pool } = pg;
let databasePool = null;
let databaseInitInFlight = null;
let databaseReady = false;

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-cron-secret");
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

function normalizeNonNegativeInt(value, fallback = 0) {
  if (!Number.isFinite(value) || value < 0) {
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

function normalizeHourOfDay(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < 0 || parsed > 23) {
    return fallback;
  }
  return parsed;
}

function getTimePartsInTimezone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const hourPart = parts.find((part) => part.type === "hour")?.value ?? "00";
    const minutePart = parts.find((part) => part.type === "minute")?.value ?? "00";
    const hour = Number.parseInt(hourPart, 10);
    const minute = Number.parseInt(minutePart, 10);
    return {
      hour: Number.isFinite(hour) ? hour : 0,
      minute: Number.isFinite(minute) ? minute : 0
    };
  } catch {
    return {
      hour: date.getHours(),
      minute: date.getMinutes()
    };
  }
}

function evaluateCronWindow(date = new Date()) {
  const startHour = normalizeHourOfDay(cronWindowStartHour, 9);
  const endHour = normalizeHourOfDay(cronWindowEndHour, 21);
  const timeParts = getTimePartsInTimezone(date, cronWindowTimezone);
  const minutesOfDay = timeParts.hour * 60 + timeParts.minute;
  const startMinutes = startHour * 60;
  const endMinutes = endHour * 60;
  const wrapsMidnight = endMinutes < startMinutes;
  const inWindow = wrapsMidnight
    ? minutesOfDay >= startMinutes || minutesOfDay <= endMinutes
    : minutesOfDay >= startMinutes && minutesOfDay <= endMinutes;
  const windowEnabled = Boolean(cronWindowEnabled);

  return {
    enabled: windowEnabled,
    timezone: cronWindowTimezone,
    startHour,
    endHour,
    nowHour: timeParts.hour,
    nowMinute: timeParts.minute,
    nowMinutesOfDay: minutesOfDay,
    withinWindow: windowEnabled ? inWindow : true
  };
}

function buildLegacyEndpointDisabledPayload() {
  return {
    error: "Endpoint disabled. Use POST /api/jobs/daily only.",
    mode: "cron-only",
    enableAction: "Set `enableLegacyJobEndpoints = true` in backend/src/server.js"
  };
}

function normalizeBackgroundJobType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === backgroundJobTypeAiClassification) {
    return normalized;
  }
  return "";
}

function normalizeBackgroundJobStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (backgroundJobStatuses.has(normalized)) {
    return normalized;
  }
  return "";
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

function isDatabaseEnabled() {
  return Boolean(databaseUrl);
}

function getDatabaseSslConfig() {
  if (databaseSslMode === "disable" || databaseSslMode === "off" || databaseSslMode === "false") {
    return false;
  }

  return {
    rejectUnauthorized: false
  };
}

function getDatabasePool() {
  if (!isDatabaseEnabled()) {
    return null;
  }

  if (databasePool) {
    return databasePool;
  }

  databasePool = new Pool({
    connectionString: databaseUrl,
    ssl: getDatabaseSslConfig(),
    max: Math.max(1, normalizePositiveInt(databaseMaxConnections, 10)),
    connectionTimeoutMillis: Math.max(1000, normalizePositiveInt(databaseConnectionTimeoutMs, 10_000)),
    idleTimeoutMillis: Math.max(1000, normalizePositiveInt(databaseIdleTimeoutMs, 30_000))
  });

  databasePool.on("error", (error) => {
    const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB pool error"));
    log("Postgres pool error", { message });
  });

  return databasePool;
}

function getStoreSnapshotKey(exchange) {
  return `${databaseStoreSnapshotPrefix}${String(exchange || "").toUpperCase()}`;
}

async function ensureDatabaseReady() {
  if (!isDatabaseEnabled()) {
    return false;
  }

  if (databaseReady) {
    return true;
  }

  if (databaseInitInFlight) {
    return databaseInitInFlight;
  }

  databaseInitInFlight = (async () => {
    const pool = getDatabasePool();
    if (!pool) {
      return false;
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${databaseSnapshotTable} (
        snapshot_key TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${databaseBackgroundJobsTable} (
        id BIGSERIAL PRIMARY KEY,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        result JSONB,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        worker_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        last_heartbeat_at TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_background_jobs_status_created
      ON ${databaseBackgroundJobsTable} (status, created_at)
    `);

    databaseReady = true;
    log("Postgres storage ready", {
      snapshotTable: databaseSnapshotTable,
      jobsTable: databaseBackgroundJobsTable
    });
    return true;
  })()
    .catch((error) => {
      databaseReady = false;
      throw error;
    })
    .finally(() => {
      databaseInitInFlight = null;
    });

  return databaseInitInFlight;
}

async function readSnapshotFromDatabase(snapshotKey) {
  if (!isDatabaseEnabled()) {
    return null;
  }

  await ensureDatabaseReady();
  const pool = getDatabasePool();
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT payload
      FROM ${databaseSnapshotTable}
      WHERE snapshot_key = $1
      LIMIT 1
    `,
    [snapshotKey]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return result.rows[0]?.payload ?? null;
}

async function writeSnapshotToDatabase(snapshotKey, payload) {
  if (!isDatabaseEnabled()) {
    return false;
  }

  await ensureDatabaseReady();
  const pool = getDatabasePool();
  if (!pool) {
    return false;
  }

  await pool.query(
    `
      INSERT INTO ${databaseSnapshotTable} (snapshot_key, payload, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (snapshot_key)
      DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
    `,
    [snapshotKey, JSON.stringify(payload)]
  );

  return true;
}

function normalizeBackgroundJobId(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function normalizeBackgroundJobPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload;
}

function normalizeBackgroundJobRecord(row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const id = normalizeBackgroundJobId(row.id);
  const jobType = normalizeBackgroundJobType(row.job_type ?? row.jobType);
  const status = normalizeBackgroundJobStatus(row.status);
  if (!id || !jobType || !status) {
    return null;
  }

  const attemptsRaw = Number.parseInt(String(row.attempts ?? "0"), 10);
  const maxAttemptsRaw = Number.parseInt(String(row.max_attempts ?? row.maxAttempts ?? "1"), 10);
  return {
    id,
    jobType,
    status,
    payload: normalizeBackgroundJobPayload(row.payload),
    result: row.result && typeof row.result === "object" ? row.result : null,
    error: sanitizeSensitiveText(row.error ?? ""),
    attempts: normalizeNonNegativeInt(attemptsRaw, 0),
    maxAttempts: Math.max(1, normalizePositiveInt(maxAttemptsRaw, 1)),
    workerId: normalizeText(row.worker_id ?? row.workerId),
    createdAt: normalizeText(row.created_at ?? row.createdAt),
    updatedAt: normalizeText(row.updated_at ?? row.updatedAt),
    startedAt: normalizeText(row.started_at ?? row.startedAt),
    completedAt: normalizeText(row.completed_at ?? row.completedAt),
    lastHeartbeatAt: normalizeText(row.last_heartbeat_at ?? row.lastHeartbeatAt)
  };
}

async function createBackgroundJob(jobType, payload = {}, options = {}) {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const normalizedType = normalizeBackgroundJobType(jobType);
  if (!normalizedType) {
    throw new Error(`Unsupported background job type: ${jobType}`);
  }

  const maxAttemptsRaw = Number.parseInt(String(options?.maxAttempts ?? "1"), 10);
  const maxAttempts = Math.max(1, Math.min(10, normalizePositiveInt(maxAttemptsRaw, 1)));

  await ensureDatabaseReady();
  const pool = getDatabasePool();
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `
      INSERT INTO ${databaseBackgroundJobsTable} (
        job_type,
        status,
        payload,
        max_attempts,
        attempts,
        created_at,
        updated_at
      )
      VALUES ($1, 'queued', $2::jsonb, $3, 0, NOW(), NOW())
      RETURNING *
    `,
    [normalizedType, JSON.stringify(normalizeBackgroundJobPayload(payload)), maxAttempts]
  );
  return normalizeBackgroundJobRecord(result.rows[0]);
}

async function claimNextBackgroundJob(workerId = "", allowedTypes = []) {
  if (!isDatabaseEnabled()) {
    return null;
  }

  await ensureDatabaseReady();
  const pool = getDatabasePool();
  if (!pool) {
    return null;
  }

  const normalizedWorkerId = normalizeText(workerId);
  const normalizedTypes = (Array.isArray(allowedTypes) ? allowedTypes : [])
    .map((value) => normalizeBackgroundJobType(value))
    .filter(Boolean);
  const params = [normalizedWorkerId || "worker"];
  let typeFilterSql = "";
  if (normalizedTypes.length > 0) {
    params.push(normalizedTypes);
    typeFilterSql = "AND job_type = ANY($2::text[])";
  }

  const result = await pool.query(
    `
      WITH next_job AS (
        SELECT id
        FROM ${databaseBackgroundJobsTable}
        WHERE status = 'queued'
          ${typeFilterSql}
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE ${databaseBackgroundJobsTable} AS job
      SET
        status = 'running',
        attempts = job.attempts + 1,
        worker_id = $1,
        started_at = COALESCE(job.started_at, NOW()),
        updated_at = NOW(),
        last_heartbeat_at = NOW()
      FROM next_job
      WHERE job.id = next_job.id
      RETURNING job.*
    `,
    params
  );

  if (result.rowCount === 0) {
    return null;
  }
  return normalizeBackgroundJobRecord(result.rows[0]);
}

async function markBackgroundJobHeartbeat(jobId, workerId = "") {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const normalizedId = normalizeBackgroundJobId(jobId);
  if (!normalizedId) {
    return null;
  }

  await ensureDatabaseReady();
  const pool = getDatabasePool();
  if (!pool) {
    return null;
  }

  const normalizedWorkerId = normalizeText(workerId);
  const result = await pool.query(
    `
      UPDATE ${databaseBackgroundJobsTable}
      SET
        last_heartbeat_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
        AND status = 'running'
        AND ($2 = '' OR worker_id = $2)
      RETURNING *
    `,
    [normalizedId, normalizedWorkerId]
  );
  if (result.rowCount === 0) {
    return null;
  }
  return normalizeBackgroundJobRecord(result.rows[0]);
}

async function markBackgroundJobCompleted(jobId, resultPayload = {}, workerId = "") {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const normalizedId = normalizeBackgroundJobId(jobId);
  if (!normalizedId) {
    return null;
  }

  await ensureDatabaseReady();
  const pool = getDatabasePool();
  if (!pool) {
    return null;
  }

  const normalizedWorkerId = normalizeText(workerId);
  const result = await pool.query(
    `
      UPDATE ${databaseBackgroundJobsTable}
      SET
        status = 'completed',
        result = $2::jsonb,
        error = '',
        completed_at = NOW(),
        updated_at = NOW(),
        last_heartbeat_at = NOW()
      WHERE id = $1
        AND status = 'running'
        AND ($3 = '' OR worker_id = $3)
      RETURNING *
    `,
    [normalizedId, JSON.stringify(normalizeBackgroundJobPayload(resultPayload)), normalizedWorkerId]
  );
  if (result.rowCount === 0) {
    return null;
  }
  return normalizeBackgroundJobRecord(result.rows[0]);
}

async function markBackgroundJobFailed(jobId, errorMessage = "", resultPayload = {}, workerId = "") {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const normalizedId = normalizeBackgroundJobId(jobId);
  if (!normalizedId) {
    return null;
  }

  await ensureDatabaseReady();
  const pool = getDatabasePool();
  if (!pool) {
    return null;
  }

  const normalizedWorkerId = normalizeText(workerId);
  const sanitizedError = sanitizeSensitiveText(errorMessage || "Unknown background job failure");
  const result = await pool.query(
    `
      UPDATE ${databaseBackgroundJobsTable}
      SET
        status = 'failed',
        result = $2::jsonb,
        error = $3,
        completed_at = NOW(),
        updated_at = NOW(),
        last_heartbeat_at = NOW()
      WHERE id = $1
        AND status = 'running'
        AND ($4 = '' OR worker_id = $4)
      RETURNING *
    `,
    [normalizedId, JSON.stringify(normalizeBackgroundJobPayload(resultPayload)), sanitizedError, normalizedWorkerId]
  );
  if (result.rowCount === 0) {
    return null;
  }
  return normalizeBackgroundJobRecord(result.rows[0]);
}

async function getBackgroundJobById(jobId) {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const normalizedId = normalizeBackgroundJobId(jobId);
  if (!normalizedId) {
    return null;
  }

  await ensureDatabaseReady();
  const pool = getDatabasePool();
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT *
      FROM ${databaseBackgroundJobsTable}
      WHERE id = $1
      LIMIT 1
    `,
    [normalizedId]
  );
  if (result.rowCount === 0) {
    return null;
  }
  return normalizeBackgroundJobRecord(result.rows[0]);
}

async function listBackgroundJobs(options = {}) {
  if (!isDatabaseEnabled()) {
    return { jobs: [], total: 0, limit: 0, offset: 0 };
  }

  const statusFilter = normalizeBackgroundJobStatus(options?.status);
  const typeFilter = normalizeBackgroundJobType(options?.jobType ?? options?.type);
  const limitRaw = Number.parseInt(String(options?.limit ?? "50"), 10);
  const offsetRaw = Number.parseInt(String(options?.offset ?? "0"), 10);
  const limit = Math.min(Math.max(normalizePositiveInt(limitRaw, 50), 1), 500);
  const offset = Math.max(0, normalizeNonNegativeInt(offsetRaw, 0));

  await ensureDatabaseReady();
  const pool = getDatabasePool();
  if (!pool) {
    return { jobs: [], total: 0, limit, offset };
  }

  const whereClauses = [];
  const whereValues = [];
  if (statusFilter) {
    whereValues.push(statusFilter);
    whereClauses.push(`status = $${whereValues.length}`);
  }
  if (typeFilter) {
    whereValues.push(typeFilter);
    whereClauses.push(`job_type = $${whereValues.length}`);
  }
  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const queryValues = [...whereValues];
  queryValues.push(limit);
  const limitParam = queryValues.length;
  queryValues.push(offset);
  const offsetParam = queryValues.length;

  const jobsResult = await pool.query(
    `
      SELECT *
      FROM ${databaseBackgroundJobsTable}
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${limitParam}
      OFFSET $${offsetParam}
    `,
    queryValues
  );

  const totalResult = await pool.query(
    `
      SELECT COUNT(*) AS total_count
      FROM ${databaseBackgroundJobsTable}
      ${whereSql}
    `,
    whereValues
  );

  const total = Number.parseInt(String(totalResult.rows[0]?.total_count ?? "0"), 10);
  return {
    jobs: jobsResult.rows.map((row) => normalizeBackgroundJobRecord(row)).filter(Boolean),
    total: Number.isFinite(total) ? total : 0,
    limit,
    offset
  };
}

async function getBackgroundJobStatusCounts() {
  if (!isDatabaseEnabled()) {
    return null;
  }

  await ensureDatabaseReady();
  const pool = getDatabasePool();
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT status, COUNT(*) AS total_count
      FROM ${databaseBackgroundJobsTable}
      GROUP BY status
    `
  );

  const counts = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0
  };
  for (const row of result.rows) {
    const status = normalizeBackgroundJobStatus(row?.status);
    if (!status) {
      continue;
    }
    const count = Number.parseInt(String(row?.total_count ?? "0"), 10);
    counts[status] = Number.isFinite(count) ? count : 0;
  }
  return counts;
}

function sleep(ms) {
  const delay = Math.max(0, normalizePositiveInt(ms, 0));
  if (delay === 0) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delay);
  });
}

function normalizeAiFailureType(value) {
  const normalized = normalizeText(value).toLowerCase();
  const allowed = new Set(["fetch_failed", "parse_failed", "page_invalid", "provider_failed", "input_invalid", "unknown"]);
  if (allowed.has(normalized)) {
    return normalized;
  }
  return "unknown";
}

function isTransientAiFailureType(failureType) {
  const normalized = normalizeAiFailureType(failureType);
  return normalized === "fetch_failed" || normalized === "parse_failed" || normalized === "page_invalid" || normalized === "provider_failed";
}

function extractHttpStatusCode(text) {
  const source = normalizeText(text);
  if (!source) {
    return null;
  }

  const match = source.match(/\bHTTP\s+(\d{3})\b/i);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferAiFailureTypeFromMessage(message) {
  const lower = normalizeText(message).toLowerCase();
  if (!lower) {
    return "unknown";
  }

  if (lower.includes("missing attachment") || lower.includes("missing dedup announcement key") || lower.includes("missing url")) {
    return "input_invalid";
  }

  if (lower.includes("invalid page request") || lower.includes("page count is zero") || lower.includes("pdf has no pages")) {
    return "page_invalid";
  }

  if (
    lower.includes("failed to parse pdf") ||
    lower.includes("failed to load pdf") ||
    lower.includes("failed to copy pdf pages") ||
    lower.includes("failed to extract text from pdf")
  ) {
    return "parse_failed";
  }

  if (lower.includes("openai http") || lower.includes("anthropic http") || lower.includes("gemini http")) {
    return "provider_failed";
  }

  if (
    lower.includes("http ") ||
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("timeout") ||
    lower.includes("aborted")
  ) {
    return "fetch_failed";
  }

  return "unknown";
}

function createAiPipelineError(failureType, message, options = {}) {
  const normalizedType = normalizeAiFailureType(failureType);
  const safeMessage = sanitizeSensitiveText(message || "Unknown AI pipeline error");
  const error = new Error(safeMessage);
  error.aiFailureType = normalizedType;
  error.aiTransient =
    typeof options.transient === "boolean" ? options.transient : isTransientAiFailureType(normalizedType);
  if (options?.details !== undefined) {
    error.aiFailureDetails = options.details;
  }
  return error;
}

function normalizeAiPipelineError(error, fallbackType = "unknown", fallbackTransient = true) {
  if (error && typeof error === "object" && typeof error.aiFailureType === "string") {
    return error;
  }

  const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown AI pipeline error"));
  const inferredType = inferAiFailureTypeFromMessage(message);
  const type = inferredType === "unknown" ? normalizeAiFailureType(fallbackType) : inferredType;
  return createAiPipelineError(type, message || "Unknown AI pipeline error", {
    transient: fallbackTransient
  });
}

function classifyAiFailure(error) {
  const normalized = normalizeAiPipelineError(error);
  const message = sanitizeSensitiveText(normalized.message || "Unknown AI classification error");
  const failureType = normalizeAiFailureType(normalized.aiFailureType);
  let retryable = typeof normalized.aiTransient === "boolean" ? normalized.aiTransient : isTransientAiFailureType(failureType);
  const httpStatus = extractHttpStatusCode(message);

  if (httpStatus !== null) {
    if (httpStatus === 408 || httpStatus === 425 || httpStatus === 429 || httpStatus >= 500) {
      retryable = true;
    } else if (httpStatus >= 400 && httpStatus < 500) {
      retryable = false;
    }
  }

  return {
    message,
    failureType,
    retryable
  };
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

function normalizeAiCategory(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeSuggestionCategory(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return "";
  }
  return normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}

function createSuggestionId(seed = "") {
  return createHash("sha1")
    .update(`${Date.now()}|${Math.random()}|${seed}`)
    .digest("hex")
    .slice(0, 18);
}

function normalizeAiLabelFilter(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized || normalized === "all") {
    return "all";
  }
  return normalized;
}

function matchesDedupAiLabelFilter(item, aiLabelFilter) {
  const filter = normalizeAiLabelFilter(aiLabelFilter);
  if (filter === "all") {
    return true;
  }

  const aiStatus = normalizeText(item?.ai_status).toLowerCase();
  const aiLabel = normalizeAiCategory(item?.ai_label);
  const reviewLabel = normalizeAiCategory(item?.review_label);

  if (filter === "pending") {
    return aiStatus === "missing" || !aiLabel;
  }

  if (filter === "failed") {
    return aiStatus === "failed";
  }

  if (filter === "reviewed") {
    return Boolean(reviewLabel);
  }

  return aiLabel === filter || reviewLabel === filter;
}

function buildAiReviewMismatchPairs() {
  const mismatches = new Map();

  for (const reviewRecord of aiReviewStore.records) {
    const key = normalizeAnnouncementKey(reviewRecord?.dedupAnnouncementKey);
    const reviewedLabel = normalizeAiCategory(reviewRecord?.reviewedLabel);
    if (!key || !aiCategorySet.has(reviewedLabel)) {
      continue;
    }

    const aiRecord = aiLabelStore.byKey.get(key);
    if (!aiRecord || normalizeText(aiRecord?.status).toUpperCase() !== "SUCCESS") {
      continue;
    }

    const aiLabel = normalizeAiCategory(aiRecord?.label);
    if (!aiCategorySet.has(aiLabel) || aiLabel === reviewedLabel) {
      continue;
    }

    const pairKey = `${aiLabel}|${reviewedLabel}`;
    const existing = mismatches.get(pairKey);
    if (existing) {
      existing.count += 1;
      continue;
    }

    mismatches.set(pairKey, {
      predictedLabel: aiLabel,
      reviewedLabel,
      count: 1
    });
  }

  return [...mismatches.values()].sort((left, right) => {
    if (left.count === right.count) {
      return `${left.predictedLabel}|${left.reviewedLabel}`.localeCompare(`${right.predictedLabel}|${right.reviewedLabel}`);
    }
    return right.count - left.count;
  });
}

function buildAiPromptLearnedRules() {
  const cacheFingerprint = [
    normalizeText(aiReviewStore.lastSyncAt),
    String(aiReviewStore.records.length),
    normalizeText(aiLabelStore.lastSyncAt),
    String(aiLabelStore.records.length),
    normalizeText(aiCriteriaVersion)
  ].join("|");
  if (aiPromptLearningCache.fingerprint === cacheFingerprint) {
    return [...aiPromptLearningCache.rules];
  }

  const minExamples = Math.max(1, normalizePositiveInt(aiPromptLearningMinExamples, 2));
  const maxRules = Math.max(1, Math.min(20, normalizePositiveInt(aiPromptLearningMaxRules, 8)));

  const rules = buildAiReviewMismatchPairs()
    .filter((entry) => entry.count >= minExamples)
    .slice(0, maxRules)
    .map(
      (entry) =>
        `When uncertain between ${entry.predictedLabel} and ${entry.reviewedLabel}, prefer ${entry.reviewedLabel} if evidence exists (${entry.count} reviewed correction${entry.count === 1 ? "" : "s"}).`
    );

  aiPromptLearningCache.fingerprint = cacheFingerprint;
  aiPromptLearningCache.rules = rules;
  return [...rules];
}

function getAiSystemPromptText() {
  const manualRules = aiManualPromptRules.filter((rule) => Boolean(normalizeText(rule)));
  const learnedRules = buildAiPromptLearnedRules();
  if (manualRules.length === 0 && learnedRules.length === 0) {
    return aiSystemPromptBaseSections.join("\n");
  }

  const sections = [...aiSystemPromptBaseSections];
  if (manualRules.length > 0) {
    sections.push("Manually curated correction rules:");
    sections.push(...manualRules);
  }

  if (learnedRules.length > 0) {
    sections.push("Human-reviewed correction rules:");
    sections.push(...learnedRules);
  }

  return sections.join("\n");
}

function buildAiReviewDiagnostics() {
  const reviewedCount = aiReviewStore.records.length;
  let matchedCount = 0;
  let mismatchCount = 0;
  let noPredictionCount = 0;

  for (const reviewRecord of aiReviewStore.records) {
    const key = normalizeAnnouncementKey(reviewRecord?.dedupAnnouncementKey);
    const reviewedLabel = normalizeAiCategory(reviewRecord?.reviewedLabel);
    if (!key || !aiCategorySet.has(reviewedLabel)) {
      continue;
    }

    const aiRecord = aiLabelStore.byKey.get(key);
    if (!aiRecord || normalizeText(aiRecord?.status).toUpperCase() !== "SUCCESS") {
      noPredictionCount += 1;
      continue;
    }

    const aiLabel = normalizeAiCategory(aiRecord?.label);
    if (!aiCategorySet.has(aiLabel)) {
      noPredictionCount += 1;
      continue;
    }

    if (aiLabel === reviewedLabel) {
      matchedCount += 1;
    } else {
      mismatchCount += 1;
    }
  }

  const comparedCount = matchedCount + mismatchCount;
  const topMismatches = buildAiReviewMismatchPairs().slice(0, 10);
  const learnedRules = buildAiPromptLearnedRules();

  return {
    reviewedCount,
    comparedCount,
    matchedCount,
    mismatchCount,
    noPredictionCount,
    agreementRate: comparedCount > 0 ? Number((matchedCount / comparedCount).toFixed(4)) : null,
    topMismatches,
    learnedRules
  };
}

function getReviewMismatchReplayKeys(maxKeys = 25) {
  const limit = Math.max(1, Math.min(500, normalizePositiveInt(maxKeys, 25)));
  const sortedReviews = [...aiReviewStore.records].sort(
    (left, right) => (parseTimestampToMillis(right?.reviewedAt) ?? 0) - (parseTimestampToMillis(left?.reviewedAt) ?? 0)
  );
  const replayKeys = [];
  const seen = new Set();

  for (const reviewRecord of sortedReviews) {
    if (replayKeys.length >= limit) {
      break;
    }

    const key = normalizeAnnouncementKey(reviewRecord?.dedupAnnouncementKey);
    if (!key || seen.has(key)) {
      continue;
    }

    const reviewedLabel = normalizeAiCategory(reviewRecord?.reviewedLabel);
    if (!aiCategorySet.has(reviewedLabel)) {
      continue;
    }

    const aiRecord = getAiLabelRecordForKey(key);
    if (!aiRecord || normalizeText(aiRecord?.status).toUpperCase() !== "SUCCESS") {
      continue;
    }

    const aiLabel = normalizeAiCategory(aiRecord?.label);
    if (!aiCategorySet.has(aiLabel) || aiLabel === reviewedLabel) {
      continue;
    }

    const reviewedAtMs = parseTimestampToMillis(reviewRecord?.reviewedAt);
    const aiUpdatedAtMs = parseTimestampToMillis(aiRecord?.updatedAt);
    if (reviewedAtMs && aiUpdatedAtMs && aiUpdatedAtMs > reviewedAtMs) {
      // This correction has already been replayed against AI after the latest human review.
      continue;
    }

    replayKeys.push(key);
    seen.add(key);
  }

  return replayKeys;
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
    let parsed = null;
    let source = "";

    if (isDatabaseEnabled()) {
      try {
        parsed = await readSnapshotFromDatabase(databaseAiLabelSnapshotKey);
        if (parsed) {
          source = "postgres";
        }
      } catch (error) {
        const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB load error"));
        log("Failed to load AI classification store from Postgres. Falling back to file.", { message });
      }
    }

    if (!parsed) {
      try {
        const text = await readFile(aiLabelsStoragePath, "utf8");
        parsed = JSON.parse(text);
        source = "file";
      } catch (error) {
        if (error?.code === "ENOENT") {
          log("AI classification store not found. Starting fresh.", { path: aiLabelsStoragePath });
        } else {
          const message = error instanceof Error ? error.message : "Unknown AI store load error";
          log("Failed to load AI classification store. Starting fresh.", { message, path: aiLabelsStoragePath });
        }
      }
    }

    if (!parsed) {
      aiLabelStore.records = [];
      aiLabelStore.lastSyncAt = null;
      indexAiLabelStore();
      aiLabelStore.loaded = true;
      return;
    }

    const records = Array.isArray(parsed?.records) ? parsed.records : Array.isArray(parsed) ? parsed : [];
    aiLabelStore.records = records
      .map((record) => {
        const failureType = normalizeAiFailureType(record?.failureType ?? record?.failure_type);
        const retryable =
          record?.retryable === undefined || record?.retryable === null
            ? isTransientAiFailureType(failureType)
            : Boolean(record?.retryable);

        return {
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
          failureType,
          retryable,
          promptVersion: normalizeText(record?.promptVersion || aiCriteriaVersion)
        };
      })
      .filter((record) => Boolean(record.dedupAnnouncementKey));
    aiLabelStore.lastSyncAt =
      typeof parsed?.lastSyncAt === "string" ? parsed.lastSyncAt : typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null;
    indexAiLabelStore();

    if (source === "file" && isDatabaseEnabled()) {
      try {
        await writeSnapshotToDatabase(databaseAiLabelSnapshotKey, {
          updatedAt: aiLabelStore.lastSyncAt || new Date().toISOString(),
          criteriaVersion: aiCriteriaVersion,
          total: aiLabelStore.records.length,
          records: aiLabelStore.records
        });
        source = "file->postgres";
      } catch (error) {
        const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB write error"));
        log("Failed to backfill AI classification store into Postgres", { message });
      }
    }

    log("Loaded AI classification store", {
      count: aiLabelStore.records.length,
      path: aiLabelsStoragePath,
      source
    });

    aiLabelStore.loaded = true;
  })();

  try {
    await aiLabelStore.syncInFlight;
  } finally {
    aiLabelStore.syncInFlight = null;
  }
}

async function persistAiLabelStore() {
  aiLabelStore.lastSyncAt = new Date().toISOString();
  const payload = {
    updatedAt: aiLabelStore.lastSyncAt,
    criteriaVersion: aiCriteriaVersion,
    total: aiLabelStore.records.length,
    records: aiLabelStore.records
  };

  if (isDatabaseEnabled()) {
    try {
      await writeSnapshotToDatabase(databaseAiLabelSnapshotKey, payload);
    } catch (error) {
      const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB write error"));
      log("Failed to persist AI classification store to Postgres", { message });
    }
  }

  await mkdir(dirname(aiLabelsStoragePath), { recursive: true });
  await writeFile(aiLabelsStoragePath, JSON.stringify(payload, null, 2), "utf8");
}

function indexAiReviewStore() {
  aiReviewStore.byKey = new Map();
  for (const record of aiReviewStore.records) {
    const key = normalizeAnnouncementKey(record?.dedupAnnouncementKey);
    if (!key) {
      continue;
    }
    aiReviewStore.byKey.set(key, record);
  }
}

async function loadAiReviewStore() {
  if (aiReviewStore.loaded) {
    return;
  }

  if (aiReviewStore.syncInFlight) {
    await aiReviewStore.syncInFlight;
    return;
  }

  aiReviewStore.syncInFlight = (async () => {
    let parsed = null;
    let source = "";

    if (isDatabaseEnabled()) {
      try {
        parsed = await readSnapshotFromDatabase(databaseAiReviewSnapshotKey);
        if (parsed) {
          source = "postgres";
        }
      } catch (error) {
        const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB load error"));
        log("Failed to load AI review store from Postgres. Falling back to file.", { message });
      }
    }

    if (!parsed) {
      try {
        const text = await readFile(aiReviewsStoragePath, "utf8");
        parsed = JSON.parse(text);
        source = "file";
      } catch (error) {
        if (error?.code === "ENOENT") {
          log("AI review store not found. Starting fresh.", { path: aiReviewsStoragePath });
        } else {
          const message = error instanceof Error ? error.message : "Unknown AI review store load error";
          log("Failed to load AI review store. Starting fresh.", { message, path: aiReviewsStoragePath });
        }
      }
    }

    if (!parsed) {
      aiReviewStore.records = [];
      aiReviewStore.lastSyncAt = null;
      indexAiReviewStore();
      aiReviewStore.loaded = true;
      return;
    }

    const records = Array.isArray(parsed?.records) ? parsed.records : Array.isArray(parsed) ? parsed : [];
    aiReviewStore.records = records
      .map((record) => {
        const reviewedLabel = normalizeAiCategory(record?.reviewedLabel ?? record?.label);
        if (!aiCategorySet.has(reviewedLabel)) {
          return null;
        }

        const dedupAnnouncementKey = normalizeAnnouncementKey(record?.dedupAnnouncementKey);
        if (!dedupAnnouncementKey) {
          return null;
        }

        const aiConfidenceAtReview = Number.parseFloat(String(record?.aiConfidenceAtReview ?? ""));
        return {
          dedupAnnouncementKey,
          reviewedLabel,
          reviewedNotes: normalizeText(record?.reviewedNotes ?? record?.notes),
          reviewer: normalizeText(record?.reviewer),
          reviewedAt: normalizeText(record?.reviewedAt || record?.updatedAt || new Date().toISOString()),
          aiLabelAtReview: normalizeAiCategory(record?.aiLabelAtReview),
          aiConfidenceAtReview: Number.isFinite(aiConfidenceAtReview) ? clampConfidence(aiConfidenceAtReview) : null,
          aiReasonAtReview: normalizeText(record?.aiReasonAtReview)
        };
      })
      .filter(Boolean);
    aiReviewStore.lastSyncAt =
      typeof parsed?.lastSyncAt === "string" ? parsed.lastSyncAt : typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null;
    indexAiReviewStore();

    if (source === "file" && isDatabaseEnabled()) {
      try {
        await writeSnapshotToDatabase(databaseAiReviewSnapshotKey, {
          updatedAt: aiReviewStore.lastSyncAt || new Date().toISOString(),
          total: aiReviewStore.records.length,
          records: aiReviewStore.records
        });
        source = "file->postgres";
      } catch (error) {
        const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB write error"));
        log("Failed to backfill AI review store into Postgres", { message });
      }
    }

    log("Loaded AI review store", {
      count: aiReviewStore.records.length,
      path: aiReviewsStoragePath,
      source
    });

    aiReviewStore.loaded = true;
  })();

  try {
    await aiReviewStore.syncInFlight;
  } finally {
    aiReviewStore.syncInFlight = null;
  }
}

async function persistAiReviewStore() {
  aiReviewStore.lastSyncAt = new Date().toISOString();
  const payload = {
    updatedAt: aiReviewStore.lastSyncAt,
    total: aiReviewStore.records.length,
    records: aiReviewStore.records
  };
  let persistedToDatabase = false;

  if (isDatabaseEnabled()) {
    try {
      await writeSnapshotToDatabase(databaseAiReviewSnapshotKey, payload);
      persistedToDatabase = true;
    } catch (error) {
      const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB write error"));
      log("Failed to persist AI review store to Postgres", { message });
      throw new Error("Failed to persist AI reviews to Postgres.");
    }
  }

  await mkdir(dirname(aiReviewsStoragePath), { recursive: true });
  await writeFile(aiReviewsStoragePath, JSON.stringify(payload, null, 2), "utf8");
  return {
    persistedToDatabase,
    persistedToFile: true
  };
}

function indexAiSuggestionStore() {
  aiSuggestionStore.byId = new Map();
  for (const record of aiSuggestionStore.records) {
    const id = normalizeText(record?.id);
    if (!id) {
      continue;
    }
    aiSuggestionStore.byId.set(id, record);
  }
}

function normalizeAiSuggestionRecord(record) {
  const id = normalizeText(record?.id);
  const suggestedCategory = normalizeSuggestionCategory(record?.suggestedCategory ?? record?.category);
  const comment = normalizeText(record?.comment ?? record?.notes).slice(0, 3000);
  if (!suggestedCategory || !comment) {
    return null;
  }

  return {
    id: id || createSuggestionId(`${suggestedCategory}|${comment}`),
    suggestedCategory,
    comment,
    source: normalizeText(record?.source || "frontend"),
    suggestedBy: normalizeText(record?.suggestedBy || record?.reviewer || "user"),
    status: normalizeText(record?.status || "OPEN").toUpperCase(),
    exampleDedupAnnouncementKey: normalizeAnnouncementKey(
      record?.exampleDedupAnnouncementKey ?? record?.dedupAnnouncementKey ?? record?.announcementKey
    ),
    exampleAttachmentUrl: normalizeText(record?.exampleAttachmentUrl ?? record?.attachmentUrl),
    existingAiLabel: normalizeAiCategory(record?.existingAiLabel),
    existingReviewLabel: normalizeAiCategory(record?.existingReviewLabel),
    createdAt: normalizeText(record?.createdAt || record?.updatedAt || new Date().toISOString())
  };
}

async function loadAiSuggestionStore() {
  if (aiSuggestionStore.loaded) {
    return;
  }

  if (aiSuggestionStore.syncInFlight) {
    await aiSuggestionStore.syncInFlight;
    return;
  }

  aiSuggestionStore.syncInFlight = (async () => {
    let parsed = null;
    let source = "";

    if (isDatabaseEnabled()) {
      try {
        parsed = await readSnapshotFromDatabase(databaseAiSuggestionSnapshotKey);
        if (parsed) {
          source = "postgres";
        }
      } catch (error) {
        const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB load error"));
        log("Failed to load AI suggestion store from Postgres. Falling back to file.", { message });
      }
    }

    if (!parsed) {
      try {
        const text = await readFile(aiSuggestionsStoragePath, "utf8");
        parsed = JSON.parse(text);
        source = "file";
      } catch (error) {
        if (error?.code === "ENOENT") {
          log("AI suggestion store not found. Starting fresh.", { path: aiSuggestionsStoragePath });
        } else {
          const message = error instanceof Error ? error.message : "Unknown AI suggestion store load error";
          log("Failed to load AI suggestion store. Starting fresh.", { message, path: aiSuggestionsStoragePath });
        }
      }
    }

    if (!parsed) {
      aiSuggestionStore.records = [];
      aiSuggestionStore.lastSyncAt = null;
      indexAiSuggestionStore();
      aiSuggestionStore.loaded = true;
      return;
    }

    const records = Array.isArray(parsed?.records) ? parsed.records : Array.isArray(parsed) ? parsed : [];
    aiSuggestionStore.records = records.map(normalizeAiSuggestionRecord).filter(Boolean);
    aiSuggestionStore.records.sort((left, right) => parseTimestampToMillis(right.createdAt) - parseTimestampToMillis(left.createdAt));
    aiSuggestionStore.lastSyncAt =
      typeof parsed?.lastSyncAt === "string" ? parsed.lastSyncAt : typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null;
    indexAiSuggestionStore();

    if (source === "file" && isDatabaseEnabled()) {
      try {
        await writeSnapshotToDatabase(databaseAiSuggestionSnapshotKey, {
          updatedAt: aiSuggestionStore.lastSyncAt || new Date().toISOString(),
          total: aiSuggestionStore.records.length,
          records: aiSuggestionStore.records
        });
        source = "file->postgres";
      } catch (error) {
        const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB write error"));
        log("Failed to backfill AI suggestion store into Postgres", { message });
      }
    }

    log("Loaded AI suggestion store", {
      count: aiSuggestionStore.records.length,
      path: aiSuggestionsStoragePath,
      source
    });

    aiSuggestionStore.loaded = true;
  })();

  try {
    await aiSuggestionStore.syncInFlight;
  } finally {
    aiSuggestionStore.syncInFlight = null;
  }
}

async function persistAiSuggestionStore() {
  aiSuggestionStore.lastSyncAt = new Date().toISOString();
  const payload = {
    updatedAt: aiSuggestionStore.lastSyncAt,
    total: aiSuggestionStore.records.length,
    records: aiSuggestionStore.records
  };

  if (isDatabaseEnabled()) {
    try {
      await writeSnapshotToDatabase(databaseAiSuggestionSnapshotKey, payload);
    } catch (error) {
      const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB write error"));
      log("Failed to persist AI suggestion store to Postgres", { message });
    }
  }

  await mkdir(dirname(aiSuggestionsStoragePath), { recursive: true });
  await writeFile(aiSuggestionsStoragePath, JSON.stringify(payload, null, 2), "utf8");
}

function addAiSuggestionRecord(record) {
  const normalized = normalizeAiSuggestionRecord(record);
  if (!normalized) {
    return null;
  }

  const existingIndex = aiSuggestionStore.records.findIndex((item) => normalizeText(item?.id) === normalized.id);
  if (existingIndex >= 0) {
    aiSuggestionStore.records[existingIndex] = normalized;
  } else {
    aiSuggestionStore.records.unshift(normalized);
  }

  aiSuggestionStore.byId.set(normalized.id, normalized);
  return normalized;
}

function getAiReviewRecordForKey(dedupAnnouncementKey) {
  const key = normalizeAnnouncementKey(dedupAnnouncementKey);
  if (!key) {
    return null;
  }
  return aiReviewStore.byKey.get(key) ?? null;
}

function upsertAiReviewRecord(record) {
  const key = normalizeAnnouncementKey(record?.dedupAnnouncementKey);
  const reviewedLabel = normalizeAiCategory(record?.reviewedLabel);
  if (!key || !aiCategorySet.has(reviewedLabel)) {
    return;
  }

  const existingIndex = aiReviewStore.records.findIndex(
    (item) => normalizeAnnouncementKey(item?.dedupAnnouncementKey) === key
  );

  const aiConfidenceAtReview = Number.parseFloat(String(record?.aiConfidenceAtReview ?? ""));
  const normalizedRecord = {
    dedupAnnouncementKey: key,
    reviewedLabel,
    reviewedNotes: normalizeText(record?.reviewedNotes),
    reviewer: normalizeText(record?.reviewer),
    reviewedAt: normalizeText(record?.reviewedAt || new Date().toISOString()),
    aiLabelAtReview: normalizeAiCategory(record?.aiLabelAtReview),
    aiConfidenceAtReview: Number.isFinite(aiConfidenceAtReview) ? clampConfidence(aiConfidenceAtReview) : null,
    aiReasonAtReview: normalizeText(record?.aiReasonAtReview)
  };

  if (existingIndex >= 0) {
    aiReviewStore.records[existingIndex] = normalizedRecord;
  } else {
    aiReviewStore.records.push(normalizedRecord);
  }

  aiReviewStore.byKey.set(key, normalizedRecord);
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

function buildPdfFetchHeaders(browserLikeHeaders = false) {
  const headers = {
    Accept: "application/pdf,*/*"
  };

  if (!browserLikeHeaders) {
    return headers;
  }

  return {
    ...headers,
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  };
}

async function fetchBinary(url, timeoutMs, options = {}) {
  const normalizedUrl = normalizeText(url);
  if (!normalizedUrl) {
    throw createAiPipelineError("input_invalid", "Missing URL", { transient: false });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizePositiveInt(timeoutMs, 30_000));

  try {
    let response;
    try {
      response = await fetch(normalizedUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: buildPdfFetchHeaders(options?.browserLikeHeaders === true)
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw createAiPipelineError("fetch_failed", "PDF download timed out", { transient: true });
      }

      throw createAiPipelineError("fetch_failed", `PDF download failed: ${sanitizeSensitiveText(error?.message || String(error))}`, {
        transient: true
      });
    }

    if (!response.ok) {
      throw createAiPipelineError("fetch_failed", `HTTP ${response.status}`, {
        transient: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
      });
    }

    const contentType = normalizeText(response.headers.get("content-type")).toLowerCase();
    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    const minBytes = Math.max(256, normalizePositiveInt(aiPdfMinBytes, 1024));
    if (bytes.length < minBytes) {
      throw createAiPipelineError("fetch_failed", `Downloaded payload too small (${bytes.length} bytes)`, { transient: true });
    }

    if (contentType && !contentType.includes("pdf") && !contentType.includes("octet-stream")) {
      throw createAiPipelineError("fetch_failed", `Unexpected content-type '${contentType}'`, { transient: false });
    }

    return {
      bytes,
      contentType,
      httpStatus: response.status
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function slicePdfToFirstPages(pdfBuffer, maxPages) {
  let sourceDoc;
  try {
    sourceDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  } catch (error) {
    throw createAiPipelineError("parse_failed", `Failed to parse PDF: ${sanitizeSensitiveText(error?.message || String(error))}`, {
      transient: true
    });
  }

  const totalPages = sourceDoc.getPageCount();
  if (!Number.isFinite(totalPages) || totalPages < 1) {
    throw createAiPipelineError("page_invalid", "PDF page count is zero", { transient: true });
  }

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
  let copiedPages;
  try {
    copiedPages = await targetDoc.copyPages(sourceDoc, pageIndexes);
  } catch (error) {
    throw createAiPipelineError(
      "parse_failed",
      `Failed to copy PDF pages: ${sanitizeSensitiveText(error?.message || String(error))}`,
      { transient: true }
    );
  }
  for (const page of copiedPages) {
    targetDoc.addPage(page);
  }

  let truncatedBytes;
  try {
    truncatedBytes = await targetDoc.save();
  } catch (error) {
    throw createAiPipelineError("parse_failed", `Failed to save sliced PDF: ${sanitizeSensitiveText(error?.message || String(error))}`, {
      transient: true
    });
  }

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
  let document;
  try {
    document = await loadingTask.promise;
  } catch (error) {
    try {
      loadingTask.destroy?.();
    } catch {
      // Best-effort cleanup.
    }
    throw createAiPipelineError("parse_failed", `Failed to load PDF: ${sanitizeSensitiveText(error?.message || String(error))}`, {
      transient: true
    });
  }

  try {
    const totalPages = document.numPages;
    if (!Number.isFinite(totalPages) || totalPages < 1) {
      throw createAiPipelineError("page_invalid", "PDF has no pages", { transient: true });
    }

    const safeMaxPages = Math.max(1, normalizePositiveInt(maxPages, 4));
    const pagesToProcess = Math.min(totalPages, safeMaxPages);
    const pageTexts = [];

    for (let pageNumber = 1; pageNumber <= pagesToProcess; pageNumber += 1) {
      let page;
      try {
        page = await document.getPage(pageNumber);
      } catch (error) {
        throw createAiPipelineError(
          "page_invalid",
          `Invalid page request while extracting text (page ${pageNumber} of ${totalPages}): ${sanitizeSensitiveText(
            error?.message || String(error)
          )}`,
          { transient: true }
        );
      }

      let textContent;
      try {
        textContent = await page.getTextContent();
      } catch (error) {
        throw createAiPipelineError(
          "parse_failed",
          `Failed to extract text from PDF: ${sanitizeSensitiveText(error?.message || String(error))}`,
          {
            transient: true
          }
        );
      } finally {
        try {
          page?.cleanup?.();
        } catch {
          // Best-effort cleanup.
        }
      }

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
  } finally {
    try {
      document?.cleanup?.();
    } catch {
      // Best-effort cleanup.
    }
    try {
      const destroyResult = document?.destroy?.();
      if (destroyResult && typeof destroyResult.then === "function") {
        await destroyResult;
      }
    } catch {
      // Best-effort cleanup.
    }
    try {
      loadingTask.destroy?.();
    } catch {
      // Best-effort cleanup.
    }
  }
}

async function preparePdfForClassification(attachmentUrl) {
  const maxFetchAttempts = Math.min(5, Math.max(1, normalizePositiveInt(aiPdfFetchMaxAttempts, 3)));
  const maxParseAttempts = Math.min(4, Math.max(1, normalizePositiveInt(aiPdfParseMaxAttempts, 2)));
  const retryDelayMs = Math.max(200, normalizePositiveInt(aiPdfRetryDelayMs, 1200));
  let lastError = null;

  for (let fetchAttempt = 1; fetchAttempt <= maxFetchAttempts; fetchAttempt += 1) {
    let fetched;
    try {
      fetched = await fetchBinary(attachmentUrl, aiPdfFetchTimeoutMs, {
        browserLikeHeaders: fetchAttempt > 1
      });
    } catch (error) {
      const normalized = normalizeAiPipelineError(error, "fetch_failed", true);
      lastError = normalized;
      if (fetchAttempt < maxFetchAttempts && isTransientAiFailureType(normalized.aiFailureType)) {
        await sleep(retryDelayMs * fetchAttempt);
        continue;
      }
      throw normalized;
    }

    const pdfBuffer = fetched.bytes;
    for (let parseAttempt = 1; parseAttempt <= maxParseAttempts; parseAttempt += 1) {
      try {
        const stage1Pdf = await slicePdfToFirstPages(pdfBuffer, aiPrimaryMaxPages);
        const stage1Text = await extractTextFromPdfPages(stage1Pdf.bytes, stage1Pdf.pagesProcessed);
        return {
          pdfBuffer,
          stage1Pdf,
          stage1Text,
          prepError: null,
          usedRawPdfFallback: false
        };
      } catch (error) {
        const normalized = normalizeAiPipelineError(error, "parse_failed", true);
        lastError = normalized;
        if (parseAttempt < maxParseAttempts && isTransientAiFailureType(normalized.aiFailureType)) {
          await sleep(retryDelayMs * parseAttempt);
          continue;
        }
        break;
      }
    }

    if (fetchAttempt < maxFetchAttempts && lastError && isTransientAiFailureType(lastError.aiFailureType)) {
      await sleep(retryDelayMs * fetchAttempt);
      continue;
    }

    if (lastError && (lastError.aiFailureType === "parse_failed" || lastError.aiFailureType === "page_invalid")) {
      return {
        pdfBuffer,
        stage1Pdf: {
          totalPages: 1,
          pagesProcessed: 1,
          bytes: pdfBuffer
        },
        stage1Text: {
          totalPages: 0,
          pagesProcessed: 0,
          text: "",
          textLength: 0
        },
        prepError: lastError,
        usedRawPdfFallback: true
      };
    }

    throw lastError ?? createAiPipelineError("unknown", "Unknown PDF preparation error", { transient: true });
  }

  throw lastError ?? createAiPipelineError("unknown", "Unknown PDF preparation error", { transient: true });
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
  const systemPrompt = getAiSystemPromptText();
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
              text: systemPrompt
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
  const systemPrompt = getAiSystemPromptText();
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
      system: systemPrompt,
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

async function classifyWithGemini(model, prompt, apiKey, baseUrl, extraParts = []) {
  const systemPrompt = getAiSystemPromptText();
  const parts = [{ text: prompt }];
  if (Array.isArray(extraParts) && extraParts.length > 0) {
    for (const part of extraParts) {
      if (part && typeof part === "object") {
        parts.push(part);
      }
    }
  }

  const response = await fetch(`${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text: systemPrompt
          }
        ]
      },
      contents: [
        {
          role: "user",
          parts
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

async function classifyWithGeminiText(model, prompt, apiKey, baseUrl) {
  return classifyWithGemini(model, prompt, apiKey, baseUrl, []);
}

async function classifyWithGeminiPdf(model, prompt, pdfBytes, apiKey, baseUrl) {
  const safeMaxPdfBytes = Math.max(1_048_576, normalizePositiveInt(aiGeminiMaxPdfBytes, 12 * 1024 * 1024));
  if (!Buffer.isBuffer(pdfBytes) || pdfBytes.length < 256) {
    throw createAiPipelineError("input_invalid", "Missing PDF bytes for Gemini classification", { transient: false });
  }
  if (pdfBytes.length > safeMaxPdfBytes) {
    throw createAiPipelineError(
      "input_invalid",
      `PDF too large for Gemini inline upload (${pdfBytes.length} bytes > ${safeMaxPdfBytes} bytes)`,
      { transient: false }
    );
  }

  return classifyWithGemini(model, prompt, apiKey, baseUrl, [
    {
      inlineData: {
        mimeType: "application/pdf",
        data: pdfBytes.toString("base64")
      }
    }
  ]);
}

async function classifyDedupAnnouncement(announcement) {
  const dedupAnnouncementKey = normalizeAnnouncementKey(
    announcement?.dedupAnnouncementKey ?? announcement?.mergedAnnouncementKey ?? announcement?.announcementKey
  );
  if (!dedupAnnouncementKey) {
    throw createAiPipelineError("input_invalid", "Missing dedup announcement key", { transient: false });
  }

  const attachmentUrl = normalizeText(announcement?.attachment_url);
  if (!attachmentUrl) {
    throw createAiPipelineError("input_invalid", "Missing attachment URL", { transient: false });
  }

  const preparedPdf = await preparePdfForClassification(attachmentUrl);
  let pdfBuffer = preparedPdf.pdfBuffer;
  const stage1Pdf = preparedPdf.stage1Pdf;
  const stage1Text = preparedPdf.stage1Text;
  const hasExtractedText = !preparedPdf.usedRawPdfFallback && stage1Text.textLength > 0;
  const machineReadable = hasExtractedText && stage1Text.textLength >= normalizePositiveInt(aiMinReadableChars, 700);
  const criteriaVersion = aiCriteriaVersion;
  const inputHash = buildAiInputHash(announcement, criteriaVersion);

  // Keep peak RSS lower by dropping the full source PDF once text is extracted.
  if (hasExtractedText) {
    preparedPdf.pdfBuffer = null;
    pdfBuffer = null;
  }

  const stage1Prompt = buildClassificationUserPrompt(announcement, criteriaVersion, stage1Text.text);
  const stage1Errors = [];
  const captureProviderError = (provider, error, targetList) => {
    const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown error"));
    targetList.push(`${provider}: ${message.slice(0, 220)}`);
  };
  const classifyWithStage1Chain = async () => {
    if (hasExtractedText) {
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

      if (aiGeminiApiKey) {
        try {
          return {
            ...(await classifyWithGeminiText(aiGeminiStage1Model, stage1Prompt, aiGeminiApiKey, aiGeminiBaseUrl)),
            provider: "gemini",
            model: aiGeminiStage1Model
          };
        } catch (error) {
          captureProviderError("gemini", error, stage1Errors);
        }
      }
    }

    if (!hasExtractedText && aiGeminiApiKey) {
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

    if (!hasExtractedText) {
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
    let stage2Pdf = stage1Pdf;
    let stage2Text = hasExtractedText ? stage1Text : null;

    if (machineReadable) {
      try {
        const escalationFetched = await fetchBinary(attachmentUrl, aiPdfFetchTimeoutMs, {
          browserLikeHeaders: true
        });
        const escalationPdfBuffer = escalationFetched.bytes;
        stage2Pdf = await slicePdfToFirstPages(escalationPdfBuffer, aiEscalationMaxPages);
        pagesProcessed = stage2Pdf.pagesProcessed;
        stage2Text = await extractTextFromPdfPages(stage2Pdf.bytes, stage2Pdf.pagesProcessed);
      } catch (error) {
        stage2Pdf = stage1Pdf;
        stage2Text = stage1Text;
      }
    } else {
      stage2Pdf = {
        totalPages: stage1Pdf.totalPages,
        pagesProcessed: stage1Pdf.pagesProcessed,
        bytes: pdfBuffer ?? stage1Pdf.bytes
      };
      pagesProcessed = stage2Pdf.pagesProcessed;
    }

    const stage2Prompt = buildClassificationUserPrompt(
      announcement,
      criteriaVersion,
      hasExtractedText ? stage2Text?.text ?? stage1Text.text : stage1Text.text
    );

    const stage2Errors = [];
    const classifyWithStage2Chain = async () => {
      if (hasExtractedText) {
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

        if (aiGeminiApiKey) {
          try {
            return {
              ...(await classifyWithGeminiText(aiGeminiStage2Model, stage2Prompt, aiGeminiApiKey, aiGeminiBaseUrl)),
              provider: "gemini",
              model: aiGeminiStage2Model
            };
          } catch (error) {
            captureProviderError("gemini", error, stage2Errors);
          }
        }
      }

      if (!hasExtractedText && aiGeminiApiKey) {
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

      if (!hasExtractedText) {
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

  pdfBuffer = null;

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
    error: "",
    failureType: "",
    retryable: false
  };
}

async function runAiClassificationCron(trigger, touchedDedupKeys = [], options = {}) {
  const forceEnabled = options?.forceEnabled === true;
  const retryFailed = options?.retryFailed === true;
  const includePendingBacklog = options?.includePendingBacklog !== false;
  const maxItemsOverrideRaw = Number.parseInt(String(options?.maxItems ?? ""), 10);
  const maxItemsOverride = Number.isFinite(maxItemsOverrideRaw) && maxItemsOverrideRaw > 0 ? maxItemsOverrideRaw : null;
  const scanRecentWhenNoTouched = options?.scanRecentWhenNoTouched === true;
  const backlogShareRaw = Number.parseFloat(String(options?.backlogShare ?? ""));
  const backlogShare = Number.isFinite(backlogShareRaw)
    ? Math.max(0, Math.min(0.9, backlogShareRaw))
    : Math.max(0, Math.min(0.9, Number.isFinite(aiPendingBacklogShare) ? aiPendingBacklogShare : 0.4));
  await Promise.all([loadAiLabelStore(), loadAiReviewStore()]);

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
  const consideredKeys = new Set();
  let skippedExistingCount = 0;
  let backlogCandidateCount = 0;
  const primaryQueueCap =
    includePendingBacklog && candidates.length > 0
      ? Math.max(1, Math.min(maxItems, Math.ceil(maxItems * (1 - backlogShare))))
      : maxItems;
  const legacyFailureRetryWindowMs = normalizePositiveInt(aiFailureRetryHours, 24) * 60 * 60 * 1000;
  const transientFailureRetryWindowMs = Math.min(
    legacyFailureRetryWindowMs,
    normalizePositiveInt(aiTransientFailureRetryMinutes, 60) * 60 * 1000
  );

  const considerQueueCandidate = (item) => {
    const dedupAnnouncementKey = normalizeAnnouncementKey(
      item?.dedupAnnouncementKey ?? item?.mergedAnnouncementKey ?? item?.announcementKey
    );
    if (!dedupAnnouncementKey) {
      return;
    }
    if (consideredKeys.has(dedupAnnouncementKey)) {
      return;
    }
    consideredKeys.add(dedupAnnouncementKey);

    const inputHash = buildAiInputHash(item, aiCriteriaVersion);
    const existingRecord = getAiLabelRecordForKey(dedupAnnouncementKey);
    if (
      existingRecord &&
      existingRecord.status === "SUCCESS" &&
      normalizeText(existingRecord.criteriaVersion) === aiCriteriaVersion &&
      normalizeText(existingRecord.inputHash) === inputHash
    ) {
      skippedExistingCount += 1;
      return;
    }

    if (existingRecord && existingRecord.status === "FAILED") {
      if (
        !retryFailed ||
        normalizeText(existingRecord.criteriaVersion) !== aiCriteriaVersion ||
        normalizeText(existingRecord.inputHash) !== inputHash
      ) {
        skippedExistingCount += 1;
        return;
      }

      const failureType = normalizeAiFailureType(existingRecord?.failureType);
      const retryable =
        typeof existingRecord?.retryable === "boolean"
          ? existingRecord.retryable
          : isTransientAiFailureType(failureType);

      if (!retryable && !forceEnabled) {
        skippedExistingCount += 1;
        return;
      }

      const failedAtMs = parseTimestampToMillis(existingRecord.updatedAt);
      if (!forceEnabled && failedAtMs && Date.now() - failedAtMs < transientFailureRetryWindowMs) {
        skippedExistingCount += 1;
        return;
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
      return;
    }

    queue.push(item);
  };

  for (const item of candidates) {
    if (queue.length >= primaryQueueCap) {
      break;
    }
    considerQueueCandidate(item);
  }

  if (includePendingBacklog && queue.length < maxItems) {
    for (let index = stores.DEDUP.announcements.length - 1; index >= 0; index -= 1) {
      if (queue.length >= maxItems) {
        break;
      }
      const item = stores.DEDUP.announcements[index];
      const dedupAnnouncementKey = normalizeAnnouncementKey(
        item?.dedupAnnouncementKey ?? item?.mergedAnnouncementKey ?? item?.announcementKey
      );
      if (!dedupAnnouncementKey || consideredKeys.has(dedupAnnouncementKey)) {
        continue;
      }
      backlogCandidateCount += 1;
      considerQueueCandidate(item);
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
      candidateCount: consideredKeys.size,
      primaryCandidateCount: candidates.length,
      backlogCandidateCount,
      skippedExistingCount,
      processedCount: 0,
      successCount: 0,
      failureCount: 0
    };
  }

  const checkpointEvery = Math.max(1, Math.min(50, normalizePositiveInt(aiPersistCheckpointEvery, 5)));
  let updatesSinceCheckpoint = 0;
  let checkpointPersistChain = Promise.resolve();
  const scheduleCheckpointPersist = (force = false) => {
    if (!force) {
      updatesSinceCheckpoint += 1;
      if (updatesSinceCheckpoint < checkpointEvery) {
        return Promise.resolve();
      }
    }

    updatesSinceCheckpoint = 0;
    checkpointPersistChain = checkpointPersistChain
      .then(() => persistAiLabelStore())
      .catch((error) => {
        const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown persistence error"));
        log("Failed to persist AI label checkpoint", { message });
      });
    return checkpointPersistChain;
  };

  const classifyQueueItem = async (announcement) => {
    const dedupAnnouncementKey = normalizeAnnouncementKey(
      announcement?.dedupAnnouncementKey ?? announcement?.mergedAnnouncementKey ?? announcement?.announcementKey
    );
    const inputHash = buildAiInputHash(announcement, aiCriteriaVersion);

    try {
      const result = await classifyDedupAnnouncement(announcement);
      upsertAiLabelRecord(result);
      await scheduleCheckpointPersist(false);
      return { key: dedupAnnouncementKey, ok: true, provider: result.provider, model: result.model };
    } catch (error) {
      const failure = classifyAiFailure(error);
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
        error: failure.message,
        failureType: failure.failureType,
        retryable: failure.retryable
      });
      await scheduleCheckpointPersist(false);
      return { key: dedupAnnouncementKey, ok: false, error: failure.message, failureType: failure.failureType };
    }
  };

  let processedCount = 0;
  let successCount = 0;
  let failureCount = 0;
  const failedKeys = [];
  const failedSamples = [];
  const safeBatchSize = Math.max(1, Math.min(50, normalizePositiveInt(aiClassificationBatchSize, 8)));
  const safeMemoryLimitMb = Math.max(300, normalizePositiveInt(aiMaxRssMb, 420));
  const safeMemoryLimitBytes = safeMemoryLimitMb * 1024 * 1024;
  let peakRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  let stoppedEarly = false;
  let stopReason = "";

  for (let offset = 0; offset < queue.length; offset += safeBatchSize) {
    const beforeBatchRssBytes = process.memoryUsage().rss;
    const beforeBatchRssMb = Math.round(beforeBatchRssBytes / (1024 * 1024));
    if (beforeBatchRssMb > peakRssMb) {
      peakRssMb = beforeBatchRssMb;
    }

    if (beforeBatchRssBytes >= safeMemoryLimitBytes) {
      stoppedEarly = true;
      stopReason = "memory-guard-before-batch";
      break;
    }

    const batch = queue.slice(offset, offset + safeBatchSize);
    const batchResults = await mapWithConcurrency(batch, normalizePositiveInt(aiConcurrency, 2), classifyQueueItem);
    for (const result of batchResults) {
      processedCount += 1;
      if (result?.ok) {
        successCount += 1;
        continue;
      }
      failureCount += 1;
      if (result?.key) {
        failedKeys.push(result.key);
      }
      if (failedSamples.length < 3) {
        failedSamples.push({
          key: result?.key,
          error: sanitizeSensitiveText(result?.error || "Unknown classification failure"),
          failureType: normalizeAiFailureType(result?.failureType)
        });
      }
    }

    await scheduleCheckpointPersist(true);

    const afterBatchRssBytes = process.memoryUsage().rss;
    const afterBatchRssMb = Math.round(afterBatchRssBytes / (1024 * 1024));
    if (afterBatchRssMb > peakRssMb) {
      peakRssMb = afterBatchRssMb;
    }

    if (afterBatchRssBytes >= safeMemoryLimitBytes) {
      stoppedEarly = true;
      stopReason = "memory-guard-after-batch";
      break;
    }

    await sleep(0);
  }

  await scheduleCheckpointPersist(true);
  await checkpointPersistChain;

  return {
    trigger,
    criteriaVersion: aiCriteriaVersion,
    forceEnabled,
    maxItems,
    candidateCount: consideredKeys.size,
    primaryCandidateCount: candidates.length,
    backlogCandidateCount,
    queuedCount: queue.length,
    skippedExistingCount,
    concurrency: normalizePositiveInt(aiConcurrency, 2),
    processedCount,
    successCount,
    failureCount,
    stoppedEarly,
    stopReason: stopReason || null,
    remainingCount: Math.max(0, queue.length - processedCount),
    peakRssMb,
    memoryGuardMb: safeMemoryLimitMb,
    batchSize: safeBatchSize,
    failedKeys,
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

  const reviewRecord = getAiReviewRecordForKey(key);
  const reviewLabel = reviewRecord?.reviewedLabel || null;
  const reviewNotes = reviewRecord?.reviewedNotes || null;
  const reviewedAt = reviewRecord?.reviewedAt || null;

  const aiRecord = getAiLabelRecordForKey(key);
  if (!aiRecord) {
    return {
      ...announcement,
      ai_label: null,
      ai_confidence: null,
      ai_reason: null,
      ai_error: null,
      ai_failure_type: null,
      ai_retryable: null,
      ai_status: "MISSING",
      review_label: reviewLabel,
      review_notes: reviewNotes,
      reviewed_at: reviewedAt
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
    ai_failure_type: isFailed ? normalizeAiFailureType(aiRecord.failureType) : null,
    ai_retryable: isFailed ? Boolean(aiRecord.retryable) : null,
    ai_status: aiStatus || "UNKNOWN",
    ai_provider: aiRecord.provider || null,
    ai_model: aiRecord.model || null,
    review_label: reviewLabel,
    review_notes: reviewNotes,
    reviewed_at: reviewedAt
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

function buildStoreSnapshotPayload(exchange, store) {
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

  return {
    updatedAt: new Date().toISOString(),
    exchange,
    sourceFingerprint: typeof store.sourceFingerprint === "string" ? store.sourceFingerprint : null,
    lastSyncAt: store.lastSyncAt,
    lastSyncStats: store.lastSyncStats,
    total: store.announcements.length,
    announcements: store.announcements,
    ...legacySyncFields
  };
}

function applyStoreSnapshot(exchange, store, parsed) {
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
  } else {
    store.lastSyncAt = null;
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
  } else {
    store.lastSyncStats = null;
  }

  if (typeof parsed?.sourceFingerprint === "string") {
    store.sourceFingerprint = parsed.sourceFingerprint;
  }
}

async function loadStore(exchange) {
  const store = stores[exchange];
  if (store.loaded) {
    return;
  }

  let parsed = null;
  let source = "";

  if (isDatabaseEnabled()) {
    try {
      parsed = await readSnapshotFromDatabase(getStoreSnapshotKey(exchange));
      if (parsed) {
        source = "postgres";
      }
    } catch (error) {
      const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB load error"));
      log(`Failed to load ${exchange} announcement store from Postgres. Falling back to file.`, { message });
    }
  }

  if (!parsed) {
    try {
      const text = await readFile(store.storagePath, "utf8");
      parsed = JSON.parse(text);
      source = "file";
    } catch (error) {
      const code = error?.code;
      if (code === "ENOENT") {
        log(`${exchange} announcement store not found. Starting fresh.`, { path: store.storagePath });
      } else {
        const message = error instanceof Error ? error.message : "Unknown error";
        log(`Failed to load ${exchange} announcement store. Starting fresh.`, { message, path: store.storagePath });
      }
    }
  }

  if (!parsed) {
    store.announcements = [];
    store.keys.clear();
    store.lastSyncAt = null;
    store.lastSyncStats = null;
    store.loaded = true;
    return;
  }

  applyStoreSnapshot(exchange, store, parsed);

  if (source === "file" && isDatabaseEnabled()) {
    try {
      await writeSnapshotToDatabase(getStoreSnapshotKey(exchange), buildStoreSnapshotPayload(exchange, store));
      source = "file->postgres";
    } catch (error) {
      const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB write error"));
      log(`Failed to backfill ${exchange} store into Postgres`, { message });
    }
  }

  log(`Loaded ${exchange} announcement store`, {
    count: store.announcements.length,
    path: store.storagePath,
    source
  });

  store.loaded = true;
}

async function persistStore(exchange) {
  const store = stores[exchange];
  const payload = buildStoreSnapshotPayload(exchange, store);

  if (isDatabaseEnabled()) {
    try {
      await writeSnapshotToDatabase(getStoreSnapshotKey(exchange), payload);
    } catch (error) {
      const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB write error"));
      log(`Failed to persist ${exchange} announcement store to Postgres`, { message });
    }
  }

  await mkdir(dirname(store.storagePath), { recursive: true });
  await writeFile(store.storagePath, JSON.stringify(payload, null, 2), "utf8");
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

async function handleGetAiCategories(req, res) {
  await Promise.all([loadAiLabelStore(), loadAiReviewStore(), loadAiSuggestionStore()]);
  const diagnostics = buildAiReviewDiagnostics();

  sendJson(req, res, 200, {
    categories: aiClassificationCategories.map((category) => ({
      value: category,
      description: aiCategoryDefinitions[category] || ""
    })),
    promptLearning: {
      minExamples: Math.max(1, normalizePositiveInt(aiPromptLearningMinExamples, 2)),
      maxRules: Math.max(1, Math.min(20, normalizePositiveInt(aiPromptLearningMaxRules, 8))),
      activeRules: diagnostics.learnedRules.length,
      learnedRules: diagnostics.learnedRules
    },
    diagnostics,
    suggestions: {
      total: aiSuggestionStore.records.length,
      lastSyncAt: aiSuggestionStore.lastSyncAt
    }
  });
}

async function handleGetAiSuggestions(req, res, requestUrl) {
  await loadAiSuggestionStore();

  const requestedLimit = Number.parseInt(requestUrl.searchParams.get("limit") ?? "100", 10);
  const limit = Math.min(Math.max(normalizePositiveInt(requestedLimit, 100), 1), 500);
  const requestedOffset = Number.parseInt(requestUrl.searchParams.get("offset") ?? "0", 10);
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0);
  const statusFilter = normalizeText(requestUrl.searchParams.get("status") ?? "OPEN").toUpperCase();
  const categoryFilter = normalizeSuggestionCategory(requestUrl.searchParams.get("category") ?? "");

  let filtered = [...aiSuggestionStore.records];
  if (statusFilter !== "ALL") {
    filtered = filtered.filter((item) => normalizeText(item?.status).toUpperCase() === statusFilter);
  }
  if (categoryFilter) {
    filtered = filtered.filter((item) => normalizeSuggestionCategory(item?.suggestedCategory) === categoryFilter);
  }

  const suggestions = filtered.slice(offset, offset + limit);
  sendJson(req, res, 200, {
    suggestions,
    total: filtered.length,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    totalPages: Math.max(1, Math.ceil(filtered.length / limit)),
    lastSyncAt: aiSuggestionStore.lastSyncAt
  });
}

async function handleCreateAiSuggestion(req, res) {
  await loadAiSuggestionStore();
  const body = await readJsonBody(req);

  const suggestedCategory = normalizeSuggestionCategory(body?.suggestedCategory ?? body?.category);
  const comment = normalizeText(body?.comment ?? body?.notes).slice(0, 3000);
  if (!suggestedCategory) {
    sendJson(req, res, 400, { error: "Field 'suggestedCategory' is required." });
    return;
  }
  if (!comment) {
    sendJson(req, res, 400, { error: "Field 'comment' is required." });
    return;
  }

  const record = addAiSuggestionRecord({
    id: createSuggestionId(`${suggestedCategory}|${comment}`),
    suggestedCategory,
    comment,
    source: normalizeText(body?.source || "frontend"),
    suggestedBy: normalizeText(body?.suggestedBy || "user"),
    status: "OPEN",
    exampleDedupAnnouncementKey: normalizeAnnouncementKey(
      body?.exampleDedupAnnouncementKey ?? body?.dedupAnnouncementKey ?? body?.announcementKey
    ),
    exampleAttachmentUrl: normalizeText(body?.exampleAttachmentUrl ?? body?.attachmentUrl),
    existingAiLabel: normalizeAiCategory(body?.existingAiLabel),
    existingReviewLabel: normalizeAiCategory(body?.existingReviewLabel),
    createdAt: new Date().toISOString()
  });

  if (!record) {
    sendJson(req, res, 400, { error: "Invalid suggestion payload." });
    return;
  }

  await persistAiSuggestionStore();
  sendJson(req, res, 201, {
    suggestion: record,
    total: aiSuggestionStore.records.length,
    lastSyncAt: aiSuggestionStore.lastSyncAt
  });
}

async function handleBulkAiReviews(req, res) {
  await Promise.all([loadStore("DEDUP"), loadAiLabelStore(), loadAiReviewStore()]);

  if (!isDatabaseEnabled()) {
    sendJson(req, res, 503, { error: "AI review writes require Postgres." });
    return;
  }

  const body = await readJsonBody(req);
  const reviews = Array.isArray(body?.reviews) ? body.reviews : Array.isArray(body?.items) ? body.items : [];
  const reviewer = normalizeText(body?.reviewer);

  if (reviews.length === 0) {
    sendJson(req, res, 400, { error: "Field 'reviews' must be a non-empty array." });
    return;
  }

  if (reviews.length > 2000) {
    sendJson(req, res, 400, { error: "Too many reviews in one request. Limit is 2000." });
    return;
  }

  const dedupKeySet = new Set(
    stores.DEDUP.announcements
      .map((item) => normalizeAnnouncementKey(item?.dedupAnnouncementKey ?? item?.mergedAnnouncementKey ?? item?.announcementKey))
      .filter(Boolean)
  );

  const nowIso = new Date().toISOString();
  const invalid = [];
  const saved = [];

  for (let index = 0; index < reviews.length; index += 1) {
    const entry = reviews[index];
    const dedupAnnouncementKey = normalizeAnnouncementKey(
      entry?.dedupAnnouncementKey ?? entry?.announcementKey ?? entry?.key ?? entry?.sourceKey
    );
    const reviewedLabel = normalizeAiCategory(entry?.reviewedLabel ?? entry?.label ?? entry?.category);
    const reviewedNotes = normalizeText(entry?.reviewedNotes ?? entry?.notes).slice(0, 800);

    if (!dedupAnnouncementKey) {
      invalid.push({ index, error: "Missing dedupAnnouncementKey." });
      continue;
    }

    if (!aiCategorySet.has(reviewedLabel)) {
      invalid.push({ index, key: dedupAnnouncementKey, error: `Invalid reviewedLabel '${reviewedLabel || "-"}'.` });
      continue;
    }

    if (!dedupKeySet.has(dedupAnnouncementKey)) {
      invalid.push({ index, key: dedupAnnouncementKey, error: "Unknown dedupAnnouncementKey for current DEDUP records." });
      continue;
    }

    const aiRecord = getAiLabelRecordForKey(dedupAnnouncementKey);
    upsertAiReviewRecord({
      dedupAnnouncementKey,
      reviewedLabel,
      reviewedNotes,
      reviewer,
      reviewedAt: nowIso,
      aiLabelAtReview: normalizeAiCategory(aiRecord?.label),
      aiConfidenceAtReview: Number(aiRecord?.confidence),
      aiReasonAtReview: normalizeText(aiRecord?.reason || aiRecord?.error)
    });

    saved.push({
      dedupAnnouncementKey,
      reviewedLabel
    });
  }

  if (saved.length === 0) {
    sendJson(req, res, 400, {
      error: "No valid review rows were provided.",
      invalid: invalid.slice(0, 30)
    });
    return;
  }

  let persistenceResult = null;
  try {
    persistenceResult = await persistAiReviewStore();
  } catch (error) {
    const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown persistence error"));
    sendJson(req, res, 503, {
      error: "Failed to persist review data to Postgres.",
      message
    });
    return;
  }
  const diagnostics = buildAiReviewDiagnostics();

  sendJson(req, res, 200, {
    ok: true,
    savedCount: saved.length,
    invalidCount: invalid.length,
    totalReviewed: aiReviewStore.records.length,
    updatedAt: aiReviewStore.lastSyncAt,
    promptLearning: {
      activeRules: diagnostics.learnedRules.length,
      learnedRules: diagnostics.learnedRules
    },
    diagnostics,
    storage: persistenceResult,
    savedKeys: saved.slice(0, 200).map((item) => item.dedupAnnouncementKey),
    invalid: invalid.slice(0, 30)
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
  await Promise.all([loadStore("NSE"), loadStore("BSE"), loadStore("COMBINED"), loadStore("DEDUP"), loadAiLabelStore(), loadAiReviewStore()]);

  const requestedLimit = Number.parseInt(requestUrl.searchParams.get("limit") ?? "100", 10);
  const limit = Math.min(Math.max(normalizePositiveInt(requestedLimit, 100), 1), 500);
  const requestedOffset = Number.parseInt(requestUrl.searchParams.get("offset") ?? "0", 10);
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0);
  const exchangeQuery = String(requestUrl.searchParams.get("exchange") ?? "NSE")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
  const symbolFilter = String(requestUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();
  const aiLabelFilter = normalizeAiLabelFilter(
    requestUrl.searchParams.get("aiLabel") ?? requestUrl.searchParams.get("ai_label") ?? ""
  );

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

  const filteredSource = sourceAnnouncements.filter((item) => {
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

  let filtered = filteredSource;
  let announcements = [];
  if (selectedExchange === "DEDUP") {
    filtered = filteredSource.map((item) => enrichDedupAnnouncementWithAi(item)).filter((item) => matchesDedupAiLabelFilter(item, aiLabelFilter));
    announcements = filtered.slice(offset, offset + limit);
  } else {
    announcements = filtered.slice(offset, offset + limit);
  }

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

async function runSourceSyncStage(trigger) {
  const [nseResult, bseResult] = await Promise.allSettled([syncNseAnnouncements(trigger), syncBseAnnouncements(trigger)]);
  const nseNewCount = nseResult.status === "fulfilled" ? Number(nseResult.value?.newCount ?? 0) : 0;
  const bseNewCount = bseResult.status === "fulfilled" ? Number(bseResult.value?.newCount ?? 0) : 0;

  return {
    nseResult,
    bseResult,
    hasNewSourceRows: nseNewCount > 0 || bseNewCount > 0
  };
}

async function runDerivedSyncStage(trigger, hasNewSourceRows) {
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

  return {
    combinedResult,
    dedupResult
  };
}

async function runAiClassificationStage(trigger, dedupResult, options = {}) {
  const forceEnabled = options?.forceEnabled === true;
  const maxItemsRaw = Number.parseInt(String(options?.maxItems ?? ""), 10);
  const maxItems = Number.isFinite(maxItemsRaw) && maxItemsRaw > 0 ? maxItemsRaw : null;
  const scanRecentWhenNoTouched = options?.scanRecentWhenNoTouched === true;
  const recentPoolRaw = Number.parseInt(String(options?.recentCandidatePool ?? ""), 10);
  const recentCandidatePool = Number.isFinite(recentPoolRaw) && recentPoolRaw > 0 ? recentPoolRaw : null;

  if (dedupResult.status !== "fulfilled") {
    return {
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
  }

  if (!aiClassifierEnabled && !forceEnabled) {
    return {
      status: "fulfilled",
      value: {
        trigger,
        skipped: true,
        reason: "ai-classifier-disabled",
        processedCount: 0,
        successCount: 0,
        failureCount: 0
      }
    };
  }

  const touchedDedupKeys = Array.isArray(dedupResult.value?.touchedDedupKeys) ? dedupResult.value.touchedDedupKeys : [];
  return runAiClassificationCron(trigger, touchedDedupKeys, {
    forceEnabled,
    maxItems,
    scanRecentWhenNoTouched,
    recentCandidatePool
  })
    .then((value) => ({ status: "fulfilled", value }))
    .catch((reason) => ({ status: "rejected", reason }));
}

function parseAiRequestConfig(body, defaults = {}) {
  const aiRequest = body?.ai && typeof body.ai === "object" ? body.ai : {};
  const forceEnabled =
    aiRequest?.enabled === undefined ? Boolean(defaults.forceEnabled) : Boolean(aiRequest?.enabled);
  const asyncEnabled =
    aiRequest?.async === undefined ? Boolean(defaults.asyncEnabled ?? true) : Boolean(aiRequest?.async);

  const maxItemsRaw = Number.parseInt(String(aiRequest?.maxItems ?? ""), 10);
  const maxItems = Number.isFinite(maxItemsRaw) && maxItemsRaw > 0 ? maxItemsRaw : null;

  const recentPoolRaw = Number.parseInt(String(aiRequest?.recentCandidatePool ?? ""), 10);
  const recentCandidatePool = Number.isFinite(recentPoolRaw) && recentPoolRaw > 0 ? recentPoolRaw : null;

  const chunkSizeRaw = Number.parseInt(String(aiRequest?.chunkSize ?? ""), 10);
  const chunkSize = Number.isFinite(chunkSizeRaw) && chunkSizeRaw > 0 ? chunkSizeRaw : null;

  const maxLoopsRaw = Number.parseInt(String(aiRequest?.maxLoops ?? ""), 10);
  const maxLoops = Number.isFinite(maxLoopsRaw) && maxLoopsRaw > 0 ? maxLoopsRaw : null;

  return {
    forceEnabled,
    asyncEnabled,
    maxItems,
    recentCandidatePool,
    chunkSize,
    maxLoops
  };
}

function resolveAiAsyncChunkSize(chunkSizeRequest) {
  const fallback = Math.max(1, normalizePositiveInt(aiAsyncChunkSizeDefault, 10));
  const requestedRaw = Number.parseInt(String(chunkSizeRequest ?? ""), 10);
  const requested = Number.isFinite(requestedRaw) && requestedRaw > 0 ? requestedRaw : fallback;
  return Math.max(1, Math.min(50, Math.floor(requested)));
}

function resolveAiAsyncMaxLoops(maxLoopsRequest) {
  const fallback = Math.max(1, normalizePositiveInt(aiAsyncMaxLoopsDefault, 120));
  const requestedRaw = Number.parseInt(String(maxLoopsRequest ?? ""), 10);
  const requested = Number.isFinite(requestedRaw) && requestedRaw > 0 ? requestedRaw : fallback;
  return Math.max(1, Math.min(500, Math.floor(requested)));
}

async function prepareStoresForAiClassification(triggerBase = "ai") {
  await Promise.all([loadStore("NSE"), loadStore("BSE"), loadStore("COMBINED"), loadStore("DEDUP"), loadAiLabelStore()]);

  let combinedPrep = null;
  let dedupPrep = null;
  const normalizedTrigger = normalizeText(triggerBase) || "ai";

  if (stores.COMBINED.announcements.length === 0 && (stores.NSE.announcements.length > 0 || stores.BSE.announcements.length > 0)) {
    combinedPrep = await refreshCombinedAnnouncements(`${normalizedTrigger}-prepare`)
      .then((value) => ({ status: "fulfilled", value }))
      .catch((reason) => ({ status: "rejected", reason }));
  }

  if (stores.DEDUP.announcements.length === 0 && stores.COMBINED.announcements.length > 0) {
    dedupPrep = await refreshDedupAnnouncements(`${normalizedTrigger}-prepare`)
      .then((value) => ({ status: "fulfilled", value }))
      .catch((reason) => ({ status: "rejected", reason }));
  }

  return { combinedPrep, dedupPrep };
}

async function executeAiClassificationChunk(params = {}) {
  const effectiveTrigger = normalizeText(params?.trigger) || "manual-ai-only";
  const forceEnabled = params?.forceEnabled === true;
  const maxItemsRaw = Number.parseInt(String(params?.maxItems ?? ""), 10);
  const maxItems = Number.isFinite(maxItemsRaw) && maxItemsRaw > 0 ? maxItemsRaw : null;
  const scanRecentWhenNoTouched = params?.scanRecentWhenNoTouched === true;
  const recentPoolRaw = Number.parseInt(String(params?.recentCandidatePool ?? ""), 10);
  const recentCandidatePool = Number.isFinite(recentPoolRaw) && recentPoolRaw > 0 ? recentPoolRaw : null;
  const touchedDedupKeys = Array.isArray(params?.touchedDedupKeys) ? params.touchedDedupKeys : [];

  aiChunkRunCount += 1;
  lastAiChunkRunAt = new Date().toISOString();

  const { combinedPrep, dedupPrep } = await prepareStoresForAiClassification(effectiveTrigger);
  const aiClassificationResult = await runAiClassificationCron(effectiveTrigger, touchedDedupKeys, {
    forceEnabled,
    maxItems,
    scanRecentWhenNoTouched,
    recentCandidatePool
  })
    .then((value) => ({ status: "fulfilled", value }))
    .catch((reason) => ({ status: "rejected", reason }));

  return {
    ok: aiClassificationResult.status === "fulfilled",
    runCount: aiChunkRunCount,
    lastAiChunkRunAt,
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
}

function buildOutsideCronWindowPayload(trigger, runCount, runAt, cronWindow) {
  return {
    ok: true,
    skipped: true,
    reason: "outside-cron-window",
    runCount,
    lastCronRunAt: runAt,
    trigger,
    cronWindow,
    nseSync: {
      exchange: "NSE",
      trigger,
      skipped: true,
      reason: "outside-cron-window"
    },
    bseSync: {
      exchange: "BSE",
      trigger,
      skipped: true,
      reason: "outside-cron-window"
    },
    combinedSync: {
      exchange: "COMBINED",
      trigger,
      skipped: true,
      reason: "outside-cron-window"
    },
    dedupSync: {
      exchange: "DEDUP",
      trigger,
      skipped: true,
      reason: "outside-cron-window"
    },
    aiClassification: {
      trigger,
      skipped: true,
      reason: "outside-cron-window",
      processedCount: 0,
      successCount: 0,
      failureCount: 0
    }
  };
}

async function executeDailyPipelineRun(body = {}) {
  await warmAnnouncementStores();

  const trigger = String(body?.trigger ?? "unknown");
  const forceRun = body?.force === true || normalizeText(body?.force).toLowerCase() === "true";
  const aiConfig = parseAiRequestConfig(body, {
    forceEnabled: false,
    asyncEnabled: false
  });
  const manualAiBackfillRequested =
    aiConfig.forceEnabled || aiConfig.maxItems !== null || aiConfig.recentCandidatePool !== null;

  cronRunCount += 1;
  lastCronRunAt = new Date().toISOString();
  const cronWindow = evaluateCronWindow(new Date());

  log("Cron run received", {
    runCount: cronRunCount,
    trigger,
    forceRun,
    aiConfig: {
      forceEnabled: aiConfig.forceEnabled,
      maxItems: aiConfig.maxItems,
      recentCandidatePool: aiConfig.recentCandidatePool,
      manualBackfill: manualAiBackfillRequested
    },
    cronWindow
  });

  if (!cronWindow.withinWindow && !forceRun) {
    return buildOutsideCronWindowPayload(trigger, cronRunCount, lastCronRunAt, cronWindow);
  }

  const sourceStage = await runSourceSyncStage(trigger);
  const { combinedResult, dedupResult } = await runDerivedSyncStage(trigger, sourceStage.hasNewSourceRows);
  const aiClassificationResult = await runAiClassificationStage(trigger, dedupResult, {
    forceEnabled: aiConfig.forceEnabled,
    maxItems: aiConfig.maxItems,
    scanRecentWhenNoTouched: manualAiBackfillRequested,
    recentCandidatePool: aiConfig.recentCandidatePool
  });

  const responsePayload = {
    ok:
      sourceStage.nseResult.status === "fulfilled" &&
      sourceStage.bseResult.status === "fulfilled" &&
      combinedResult.status === "fulfilled" &&
      dedupResult.status === "fulfilled" &&
      aiClassificationResult.status === "fulfilled",
    runCount: cronRunCount,
    lastCronRunAt,
    trigger,
    cronWindow,
    nseSync:
      sourceStage.nseResult.status === "fulfilled"
        ? sourceStage.nseResult.value
        : {
            error:
              sourceStage.nseResult.reason instanceof Error
                ? sourceStage.nseResult.reason.message
                : "Unknown NSE sync error"
          },
    bseSync:
      sourceStage.bseResult.status === "fulfilled"
        ? sourceStage.bseResult.value
        : {
            error:
              sourceStage.bseResult.reason instanceof Error
                ? sourceStage.bseResult.reason.message
                : "Unknown BSE sync error"
          },
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

  if (!responsePayload.ok) {
    log("Cron sync finished with errors", responsePayload);
  }

  return responsePayload;
}

export async function runDailyPipelineJob(body = {}) {
  return executeDailyPipelineRun(body);
}

export async function runSourceIngestionJob(trigger = "manual-source-sync") {
  await warmAnnouncementStores();
  return runSourceSyncStage(trigger);
}

export async function runDerivedTablesJob(trigger = "manual-derived-sync", hasNewSourceRows = true) {
  await warmAnnouncementStores();
  return runDerivedSyncStage(trigger, hasNewSourceRows);
}

export async function runAiClassificationJob(trigger = "manual-ai-sync", dedupResult = null, options = {}) {
  await warmAnnouncementStores();
  const effectiveDedupResult = dedupResult ?? { status: "fulfilled", value: { touchedDedupKeys: [] } };
  return runAiClassificationStage(trigger, effectiveDedupResult, options);
}

async function handleCronRun(req, res) {
  if (!requireCronSecret(req, res, "Invalid cron secret.")) {
    return;
  }

  const body = await readJsonBody(req);
  const responsePayload = await executeDailyPipelineRun(body);
  sendJson(req, res, responsePayload.ok ? 200 : 502, responsePayload);
}

async function handleAiOnlyRun(req, res, requestUrl) {
  if (!requireCronSecret(req, res, "Invalid AI job secret.")) {
    return;
  }

  const body = await readJsonBody(req);
  const trigger = String(body.trigger ?? "unknown");
  const aiConfig = parseAiRequestConfig(body, {
    forceEnabled: true,
    asyncEnabled: true
  });
  const effectiveTrigger = trigger || "manual-ai-only";
  const syncOverride = normalizeText(requestUrl.searchParams.get("sync")).toLowerCase() === "true" || body?.sync === true;

  aiOnlyRunCount += 1;
  lastAiOnlyRunAt = new Date().toISOString();

  log("AI-only run received", {
    runCount: aiOnlyRunCount,
    trigger: effectiveTrigger,
    maxItems: aiConfig.maxItems,
    forceEnabled: aiConfig.forceEnabled,
    asyncEnabled: aiConfig.asyncEnabled && !syncOverride
  });

  if (isDatabaseEnabled() && aiConfig.asyncEnabled && !syncOverride) {
    const asyncJobPayload = {
      mode: "ai-only",
      trigger: effectiveTrigger,
      forceEnabled: aiConfig.forceEnabled,
      targetSuccessCount: aiConfig.maxItems ?? normalizePositiveInt(aiMaxItemsPerCron, 120),
      chunkSize: resolveAiAsyncChunkSize(aiConfig.chunkSize),
      maxLoops: resolveAiAsyncMaxLoops(aiConfig.maxLoops),
      touchedDedupKeys: [],
      scanRecentWhenNoTouched: true,
      recentCandidatePool: aiConfig.recentCandidatePool
    };

    const job = await createBackgroundJob(backgroundJobTypeAiClassification, asyncJobPayload, { maxAttempts: 1 });
    if (!job) {
      sendJson(req, res, 503, { error: "Database-backed background queue is unavailable." });
      return;
    }

    sendJson(req, res, 202, {
      ok: true,
      queued: true,
      runCount: aiOnlyRunCount,
      lastAiOnlyRunAt,
      mode: "async-worker",
      job
    });
    return;
  }

  const responsePayload = await executeAiClassificationChunk({
    trigger: effectiveTrigger,
    forceEnabled: aiConfig.forceEnabled,
    maxItems: aiConfig.maxItems,
    scanRecentWhenNoTouched: true,
    recentCandidatePool: aiConfig.recentCandidatePool,
    touchedDedupKeys: []
  });

  if (responsePayload.ok) {
    sendJson(req, res, 200, responsePayload);
    return;
  }

  log("AI-only classification run finished with errors", responsePayload);
  sendJson(req, res, 502, responsePayload);
}

async function handleInternalRunAiChunk(req, res) {
  if (!requireCronSecret(req, res, "Invalid worker secret.")) {
    return;
  }

  const body = await readJsonBody(req);
  const trigger = String(body?.trigger ?? "worker-ai-chunk");
  const forceEnabled = body?.forceEnabled === true;
  const maxItemsRaw = Number.parseInt(String(body?.maxItems ?? ""), 10);
  const maxItems = Number.isFinite(maxItemsRaw) && maxItemsRaw > 0 ? maxItemsRaw : null;
  const scanRecentWhenNoTouched = body?.scanRecentWhenNoTouched === true;
  const recentCandidatePoolRaw = Number.parseInt(String(body?.recentCandidatePool ?? ""), 10);
  const recentCandidatePool = Number.isFinite(recentCandidatePoolRaw) && recentCandidatePoolRaw > 0 ? recentCandidatePoolRaw : null;
  const touchedDedupKeys = Array.isArray(body?.touchedDedupKeys) ? body.touchedDedupKeys : [];

  const responsePayload = await executeAiClassificationChunk({
    trigger,
    forceEnabled,
    maxItems,
    scanRecentWhenNoTouched,
    recentCandidatePool,
    touchedDedupKeys
  });
  if (responsePayload.ok) {
    sendJson(req, res, 200, responsePayload);
    return;
  }
  sendJson(req, res, 502, responsePayload);
}

async function handleClaimBackgroundJob(req, res) {
  if (!requireCronSecret(req, res, "Invalid worker secret.")) {
    return;
  }
  if (!isDatabaseEnabled()) {
    sendJson(req, res, 503, { error: "Background jobs require Postgres." });
    return;
  }

  const body = await readJsonBody(req);
  const workerId = normalizeText(body?.workerId || body?.worker || "worker");
  const types = Array.isArray(body?.types) ? body.types : [backgroundJobTypeAiClassification];
  const job = await claimNextBackgroundJob(workerId, types);
  sendJson(req, res, 200, { ok: true, job });
}

async function handleBackgroundJobHeartbeat(req, res, jobId) {
  if (!requireCronSecret(req, res, "Invalid worker secret.")) {
    return;
  }

  const body = await readJsonBody(req);
  const workerId = normalizeText(body?.workerId || body?.worker || "");
  const job = await markBackgroundJobHeartbeat(jobId, workerId);
  if (!job) {
    sendJson(req, res, 404, { error: "Job not found or not running." });
    return;
  }
  sendJson(req, res, 200, { ok: true, job });
}

async function handleBackgroundJobComplete(req, res, jobId) {
  if (!requireCronSecret(req, res, "Invalid worker secret.")) {
    return;
  }

  const body = await readJsonBody(req);
  const workerId = normalizeText(body?.workerId || body?.worker || "");
  const job = await markBackgroundJobCompleted(jobId, body?.result, workerId);
  if (!job) {
    sendJson(req, res, 404, { error: "Job not found or not running." });
    return;
  }
  sendJson(req, res, 200, { ok: true, job });
}

async function handleBackgroundJobFail(req, res, jobId) {
  if (!requireCronSecret(req, res, "Invalid worker secret.")) {
    return;
  }

  const body = await readJsonBody(req);
  const workerId = normalizeText(body?.workerId || body?.worker || "");
  const errorMessage = normalizeText(body?.error || body?.message || "Background job failed");
  const job = await markBackgroundJobFailed(jobId, errorMessage, body?.result, workerId);
  if (!job) {
    sendJson(req, res, 404, { error: "Job not found or not running." });
    return;
  }
  sendJson(req, res, 200, { ok: true, job });
}

async function handleGetBackgroundJobs(req, res, requestUrl) {
  if (!isDatabaseEnabled()) {
    sendJson(req, res, 503, { error: "Background jobs require Postgres." });
    return;
  }

  const jobsResponse = await listBackgroundJobs({
    status: requestUrl.searchParams.get("status"),
    type: requestUrl.searchParams.get("type"),
    limit: requestUrl.searchParams.get("limit"),
    offset: requestUrl.searchParams.get("offset")
  });
  sendJson(req, res, 200, {
    jobs: jobsResponse.jobs,
    total: jobsResponse.total,
    limit: jobsResponse.limit,
    offset: jobsResponse.offset,
    page: Math.floor(jobsResponse.offset / Math.max(1, jobsResponse.limit)) + 1,
    totalPages: Math.max(1, Math.ceil(jobsResponse.total / Math.max(1, jobsResponse.limit)))
  });
}

async function handleGetBackgroundJob(req, res, jobId) {
  if (!isDatabaseEnabled()) {
    sendJson(req, res, 503, { error: "Background jobs require Postgres." });
    return;
  }

  const job = await getBackgroundJobById(jobId);
  if (!job) {
    sendJson(req, res, 404, { error: "Job not found." });
    return;
  }
  sendJson(req, res, 200, { job });
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
  await Promise.all([
    loadStore("NSE"),
    loadStore("BSE"),
    loadStore("COMBINED"),
    loadStore("DEDUP"),
    loadAiLabelStore(),
    loadAiReviewStore(),
    loadAiSuggestionStore()
  ]);

  const aiSuccessCount = aiLabelStore.records.filter(
    (record) => normalizeText(record?.criteriaVersion) === aiCriteriaVersion && normalizeText(record?.status) === "SUCCESS"
  ).length;
  const aiFailureCount = aiLabelStore.records.filter(
    (record) => normalizeText(record?.criteriaVersion) === aiCriteriaVersion && normalizeText(record?.status) === "FAILED"
  ).length;
  const aiReviewDiagnostics = buildAiReviewDiagnostics();
  const backgroundJobCounts = isDatabaseEnabled() && enableLegacyJobEndpoints
    ? await getBackgroundJobStatusCounts().catch((error) => {
        const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown error"));
        log("Failed to load background job counts", { message });
        return null;
      })
    : null;

  sendJson(req, res, 200, {
    service: appName,
    env: appEnv,
    serverTime: new Date().toISOString(),
    notesCount: notes.length,
    cronRunCount,
    lastCronRunAt,
    aiOnlyRunCount,
    lastAiOnlyRunAt,
    aiChunkRunCount,
    lastAiChunkRunAt,
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
    aiLabelsLastSyncAt: aiLabelStore.lastSyncAt,
    aiReviewsCount: aiReviewStore.records.length,
    aiReviewsLastSyncAt: aiReviewStore.lastSyncAt,
    aiSuggestionsCount: aiSuggestionStore.records.length,
    aiSuggestionsLastSyncAt: aiSuggestionStore.lastSyncAt,
    aiReviewDiagnostics,
    apiSnapshotRefresh: {
      enabled: isDatabaseEnabled(),
      intervalMs: apiSnapshotRefreshIntervalMs,
      runCount: apiSnapshotRefreshCount,
      lastRefreshedAt: lastApiSnapshotRefreshAt,
      inFlight: Boolean(apiSnapshotRefreshInFlight),
      lastError: lastApiSnapshotRefreshError
    },
    database: {
      enabled: isDatabaseEnabled(),
      ready: databaseReady,
      snapshotTable: databaseSnapshotTable,
      jobsTable: enableLegacyJobEndpoints ? databaseBackgroundJobsTable : null
    },
    backgroundJobs: {
      enabled: isDatabaseEnabled() && enableLegacyJobEndpoints,
      counts: backgroundJobCounts
    },
    pipeline: {
      mode: "in-process-pipeline",
      cronTriggers: ["POST /api/jobs/daily", "npm run cron"],
      cronWindow: {
        enabled: cronWindowEnabled,
        timezone: cronWindowTimezone,
        startHour: normalizeHourOfDay(cronWindowStartHour, 9),
        endHour: normalizeHourOfDay(cronWindowEndHour, 21)
      },
      legacyJobEndpointsEnabled: enableLegacyJobEndpoints
    }
  });
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const backgroundJobByIdMatch = requestUrl.pathname.match(/^\/api\/jobs\/(\d+)$/);
  const internalJobHeartbeatMatch = requestUrl.pathname.match(/^\/api\/internal\/jobs\/(\d+)\/heartbeat$/);
  const internalJobCompleteMatch = requestUrl.pathname.match(/^\/api\/internal\/jobs\/(\d+)\/complete$/);
  const internalJobFailMatch = requestUrl.pathname.match(/^\/api\/internal\/jobs\/(\d+)\/fail$/);

  if (method === "OPTIONS") {
    applyCorsHeaders(req, res);
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    if (method === "GET" && requestUrl.pathname === "/") {
      const docs = [
        "GET /health",
        "GET /api/health",
        "GET /api/status",
        "GET/POST /api/notes",
        "GET /api/notifications/announcements?exchange=NSE|BSE|NSE+BSE|DEDUP|ALL&limit=100&symbol=TCS",
        "GET /api/ai/categories",
        "GET /api/ai/suggestions",
        "POST /api/ai/suggestions",
        "POST /api/ai/reviews/bulk",
        "POST /api/jobs/daily"
      ];
      if (enableLegacyJobEndpoints) {
        docs.push(
          "POST /api/jobs/ai-only",
          "GET /api/jobs?status=queued|running|completed|failed&type=ai-classification&limit=50&offset=0",
          "GET /api/jobs/:id",
          "POST /api/internal/worker-heartbeat",
          "POST /api/internal/jobs/claim",
          "POST /api/internal/jobs/:id/heartbeat",
          "POST /api/internal/jobs/:id/complete",
          "POST /api/internal/jobs/:id/fail",
          "POST /api/internal/ai/run-chunk"
        );
      }

      sendJson(req, res, 200, {
        message: "API is running",
        docs
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

    if (method === "GET" && requestUrl.pathname === "/api/ai/categories") {
      await handleGetAiCategories(req, res);
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/api/ai/suggestions") {
      await handleGetAiSuggestions(req, res, requestUrl);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/ai/suggestions") {
      await handleCreateAiSuggestion(req, res);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/ai/reviews/bulk") {
      await handleBulkAiReviews(req, res);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/jobs/daily") {
      await handleCronRun(req, res);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/jobs/ai-only") {
      if (!enableLegacyJobEndpoints) {
        sendJson(req, res, 410, buildLegacyEndpointDisabledPayload());
        return;
      }
      await handleAiOnlyRun(req, res, requestUrl);
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/api/jobs") {
      if (!enableLegacyJobEndpoints) {
        sendJson(req, res, 410, buildLegacyEndpointDisabledPayload());
        return;
      }
      await handleGetBackgroundJobs(req, res, requestUrl);
      return;
    }

    if (method === "GET" && backgroundJobByIdMatch) {
      if (!enableLegacyJobEndpoints) {
        sendJson(req, res, 410, buildLegacyEndpointDisabledPayload());
        return;
      }
      await handleGetBackgroundJob(req, res, backgroundJobByIdMatch[1]);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/internal/worker-heartbeat") {
      if (!enableLegacyJobEndpoints) {
        sendJson(req, res, 410, buildLegacyEndpointDisabledPayload());
        return;
      }
      await handleWorkerHeartbeat(req, res);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/internal/jobs/claim") {
      if (!enableLegacyJobEndpoints) {
        sendJson(req, res, 410, buildLegacyEndpointDisabledPayload());
        return;
      }
      await handleClaimBackgroundJob(req, res);
      return;
    }

    if (method === "POST" && internalJobHeartbeatMatch) {
      if (!enableLegacyJobEndpoints) {
        sendJson(req, res, 410, buildLegacyEndpointDisabledPayload());
        return;
      }
      await handleBackgroundJobHeartbeat(req, res, internalJobHeartbeatMatch[1]);
      return;
    }

    if (method === "POST" && internalJobCompleteMatch) {
      if (!enableLegacyJobEndpoints) {
        sendJson(req, res, 410, buildLegacyEndpointDisabledPayload());
        return;
      }
      await handleBackgroundJobComplete(req, res, internalJobCompleteMatch[1]);
      return;
    }

    if (method === "POST" && internalJobFailMatch) {
      if (!enableLegacyJobEndpoints) {
        sendJson(req, res, 410, buildLegacyEndpointDisabledPayload());
        return;
      }
      await handleBackgroundJobFail(req, res, internalJobFailMatch[1]);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/internal/ai/run-chunk") {
      if (!enableLegacyJobEndpoints) {
        sendJson(req, res, 410, buildLegacyEndpointDisabledPayload());
        return;
      }
      await handleInternalRunAiChunk(req, res);
      return;
    }

    sendJson(req, res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("Request failed", { method, path: requestUrl.pathname, message });
    sendJson(req, res, 400, { error: message });
  }
});

function getAnnouncementStoreWarmupTasks() {
  return [
    loadStore("NSE"),
    loadStore("BSE"),
    loadStore("COMBINED"),
    loadStore("DEDUP"),
    loadAiLabelStore(),
    loadAiReviewStore(),
    loadAiSuggestionStore()
  ];
}

export async function warmAnnouncementStores() {
  if (!storeWarmupPromise) {
    storeWarmupPromise = Promise.all(getAnnouncementStoreWarmupTasks()).catch((error) => {
      storeWarmupPromise = null;
      throw error;
    });
  }
  return storeWarmupPromise;
}

function markInMemorySnapshotsStale() {
  stores.NSE.loaded = false;
  stores.BSE.loaded = false;
  stores.COMBINED.loaded = false;
  stores.DEDUP.loaded = false;
  aiLabelStore.loaded = false;
  aiReviewStore.loaded = false;
  aiSuggestionStore.loaded = false;
  storeWarmupPromise = null;
}

function hasLocalStoreSyncInFlight() {
  return Boolean(
    stores.NSE.syncInFlight ||
      stores.BSE.syncInFlight ||
      stores.COMBINED.syncInFlight ||
      stores.DEDUP.syncInFlight ||
      aiLabelStore.syncInFlight ||
      aiReviewStore.syncInFlight ||
      aiSuggestionStore.syncInFlight
  );
}

async function refreshApiInMemorySnapshots(reason = "interval") {
  if (!isDatabaseEnabled()) {
    return {
      ok: false,
      skipped: true,
      reason: "database-disabled"
    };
  }

  if (hasLocalStoreSyncInFlight()) {
    return {
      ok: false,
      skipped: true,
      reason: "local-sync-in-flight"
    };
  }

  if (apiSnapshotRefreshInFlight) {
    return apiSnapshotRefreshInFlight;
  }

  apiSnapshotRefreshInFlight = (async () => {
    markInMemorySnapshotsStale();
    await warmAnnouncementStores();

    apiSnapshotRefreshCount += 1;
    lastApiSnapshotRefreshAt = new Date().toISOString();
    lastApiSnapshotRefreshError = null;
    return {
      ok: true,
      skipped: false,
      reason,
      runCount: apiSnapshotRefreshCount,
      lastApiSnapshotRefreshAt
    };
  })()
    .catch((error) => {
      const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown refresh error"));
      lastApiSnapshotRefreshError = message;
      log("API snapshot refresh failed", { reason, message });
      return {
        ok: false,
        skipped: false,
        reason,
        error: message
      };
    })
    .finally(() => {
      apiSnapshotRefreshInFlight = null;
    });

  return apiSnapshotRefreshInFlight;
}

function startApiSnapshotRefreshLoop() {
  if (!isDatabaseEnabled()) {
    return;
  }

  if (apiSnapshotRefreshTimer) {
    return;
  }

  apiSnapshotRefreshTimer = setInterval(() => {
    refreshApiInMemorySnapshots("interval").catch((error) => {
      const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown refresh loop error"));
      lastApiSnapshotRefreshError = message;
      log("API snapshot refresh loop error", { message });
    });
  }, apiSnapshotRefreshIntervalMs);

  if (typeof apiSnapshotRefreshTimer.unref === "function") {
    apiSnapshotRefreshTimer.unref();
  }

  log("API snapshot refresh loop enabled", {
    intervalMs: apiSnapshotRefreshIntervalMs
  });
}

function stopApiSnapshotRefreshLoop() {
  if (!apiSnapshotRefreshTimer) {
    return;
  }

  clearInterval(apiSnapshotRefreshTimer);
  apiSnapshotRefreshTimer = null;
}

export async function closeDatabaseConnections() {
  if (!databasePool) {
    return;
  }

  const pool = databasePool;
  databasePool = null;
  databaseReady = false;
  try {
    await pool.end();
  } catch (error) {
    const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error || "Unknown DB close error"));
    log("Failed to close Postgres pool cleanly", { message });
  }
}

let shutdownInFlight = null;
async function shutdownRuntime(exitCode = null) {
  if (!shutdownInFlight) {
    shutdownInFlight = (async () => {
      stopApiSnapshotRefreshLoop();
      if (server.listening) {
        await new Promise((resolveClose) => {
          server.close(() => {
            resolveClose();
          });
        });
      }
      await closeDatabaseConnections();
    })().finally(() => {
      shutdownInFlight = null;
    });
  }

  await shutdownInFlight;
  if (Number.isInteger(exitCode)) {
    process.exit(exitCode);
  }
}

async function startApiServer() {
  try {
    await warmAnnouncementStores();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("Announcement stores warm-up failed", { message });
  }

  startApiSnapshotRefreshLoop();

  server.listen(port, "0.0.0.0", () => {
    log(`Listening on port ${port}`);
  });
}

const currentModulePath = fileURLToPath(import.meta.url);
const processEntryPath = normalizeText(process.argv[1]);
const isMainModule = processEntryPath ? resolve(processEntryPath) === currentModulePath : false;

if (isMainModule) {
  startApiServer().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown server startup error";
    log("Server startup failed", { message });
    process.exit(1);
  });
}

process.on("SIGTERM", () => {
  log("SIGTERM received, shutting down");
  shutdownRuntime(0).catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown shutdown error";
    log("Shutdown failed", { message });
    process.exit(1);
  });
});
