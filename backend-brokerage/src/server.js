import { createServer } from "node:http";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const port = Number.parseInt(process.env.PORT ?? "10001", 10);
const appName = process.env.APP_NAME ?? "ai-webapp-brokerage-api";
const appEnv = process.env.APP_ENV?.trim() || process.env.NODE_ENV?.trim() || "development";
const isProduction = appEnv.toLowerCase() === "production";
const cronSecret = process.env.CRON_SECRET ?? "";
const corsOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const configuredAuthSecret = process.env.AUTH_SECRET?.trim() || "";
const configuredTokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY?.trim() || "";

if (isProduction) {
  const missingVars = [];

  if (!configuredAuthSecret) {
    missingVars.push("AUTH_SECRET");
  }

  if (!configuredTokenEncryptionKey) {
    missingVars.push("TOKEN_ENCRYPTION_KEY");
  }

  if (corsOrigins.length === 0) {
    missingVars.push("CORS_ORIGIN");
  }

  if (missingVars.length > 0) {
    throw new Error(
      `[config] Missing required production env vars: ${missingVars.join(", ")}`
    );
  }
}

const authSecret = configuredAuthSecret || `dev-${randomBytes(32).toString("hex")}`;
const encryptionKey = deriveKey(configuredTokenEncryptionKey || authSecret);
const publicApiBase = process.env.PUBLIC_API_BASE_URL?.trim().replace(/\/$/, "") || "";

const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || "";
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || "";
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() || "";
const googleScopes =
  process.env.GOOGLE_OAUTH_SCOPES?.trim() ||
  "openid email profile https://www.googleapis.com/auth/gmail.readonly";
const databaseUrl = process.env.DATABASE_URL?.trim() || "";
const databaseSslMode = (process.env.DATABASE_SSL_MODE || (isProduction ? "require" : "disable")).trim().toLowerCase();
const databaseMaxConnections = Number.parseInt(process.env.DATABASE_MAX_CONNECTIONS ?? "5", 10);

const frontendUrl = process.env.FRONTEND_URL?.trim() || corsOrigins[0] || "http://localhost:5173";
const allowedRedirects = new Set(
  [
    frontendUrl,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...(process.env.AUTH_ALLOWED_REDIRECTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  ].map((value) => normalizeRedirect(value)).filter(Boolean)
);

const serviceRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(serviceRootDir, process.env.BROKERAGE_DATA_DIR?.trim() || "data");
const dbFilePath = path.join(dataDir, "app-db.json");
const archiveRootDir = path.join(dataDir, "email-archive");
const dbSnapshotTable = "brokerage_app_state";
const dbSnapshotId = "primary";

const defaultBrokerMappings = [
  {
    broker: "Axis Capital",
    patterns: ["axiscapital", "axis", "@axiscap"],
    enabled: true
  },
  {
    broker: "Kotak Institutional Equities",
    patterns: ["kotak", "institutional.equities"],
    enabled: true
  },
  {
    broker: "Jefferies India",
    patterns: ["jefferies"],
    enabled: true
  },
  {
    broker: "Emkay Global",
    patterns: ["emkay", "@emkayglobal"],
    enabled: true
  }
];

const defaultDb = {
  users: [],
  sessions: [],
  gmailConnections: [],
  gmailPreferences: [],
  emailArchives: [],
  notes: [],
  counters: {
    noteId: 1
  },
  cronState: {
    runCount: 0,
    lastRunAt: null,
    workerHeartbeatCount: 0,
    lastWorkerHeartbeatAt: null
  }
};

const { Pool } = pg;
const databasePool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      max: Number.isFinite(databaseMaxConnections) ? Math.max(1, databaseMaxConnections) : 5,
      ssl: databaseSslMode === "disable" ? false : { rejectUnauthorized: false }
    })
  : null;
let databaseReady = false;

await initializeDatabase();
let db = await loadDb();
let persistQueue = Promise.resolve();

if (!configuredAuthSecret) {
  log("AUTH_SECRET is not set. A temporary runtime secret is being used.");
}

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

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-cron-secret");
}

function sendJson(req, res, statusCode, payload) {
  applyCorsHeaders(req, res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendRedirect(req, res, targetUrl) {
  applyCorsHeaders(req, res);
  res.statusCode = 302;
  res.setHeader("Location", targetUrl);
  res.end();
}

function sendText(req, res, statusCode, text) {
  applyCorsHeaders(req, res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

function log(message, extra = undefined) {
  const prefix = `[${new Date().toISOString()}] [api]`;
  if (extra === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }

  console.log(`${prefix} ${message}`, extra);
}

async function readJsonBody(req) {
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > 5_000_000) {
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

function isDatabaseEnabled() {
  return Boolean(databasePool && databaseReady);
}

async function initializeDatabase() {
  if (!databasePool) {
    return;
  }

  try {
    await databasePool.query(`
      CREATE TABLE IF NOT EXISTS ${dbSnapshotTable} (
        id TEXT PRIMARY KEY,
        state_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    databaseReady = true;
    log("Postgres storage initialized", { table: dbSnapshotTable });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown database init error";
    log("Postgres init failed. Falling back to file storage.", { message });
    databaseReady = false;
  }
}

async function readDbFromDatabase() {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const result = await databasePool.query(`SELECT state_json FROM ${dbSnapshotTable} WHERE id = $1`, [dbSnapshotId]);
  if (result.rowCount === 0) {
    return null;
  }

  return result.rows[0]?.state_json ?? null;
}

async function writeDbToDatabase(value) {
  if (!isDatabaseEnabled()) {
    return;
  }

  await databasePool.query(
    `INSERT INTO ${dbSnapshotTable} (id, state_json, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = NOW()`,
    [dbSnapshotId, JSON.stringify(value)]
  );
}

function normalizeGmailPreferencesEntry(entry) {
  const nowIso = new Date().toISOString();
  const scheduleHour = Number.parseInt(String(entry?.scheduleHour ?? "7"), 10);
  const scheduleMinute = Number.parseInt(String(entry?.scheduleMinute ?? "30"), 10);

  return {
    userId: String(entry?.userId ?? ""),
    maxResults: Math.max(1, Math.min(100, Number(entry?.maxResults ?? 25) || 25)),
    query: typeof entry?.query === "string" ? entry.query : "",
    includeUnmapped: entry?.includeUnmapped === true,
    brokerMappings: mergeBrokerMappingsWithDefaults(entry?.brokerMappings),
    trackedLabelIds: Array.isArray(entry?.trackedLabelIds)
      ? entry.trackedLabelIds.map((value) => String(value).trim()).filter(Boolean)
      : [],
    trackedLabelNames: Array.isArray(entry?.trackedLabelNames)
      ? entry.trackedLabelNames.map((value) => String(value).trim()).filter(Boolean)
      : [],
    scheduleEnabled: entry?.scheduleEnabled === true,
    scheduleHour: Number.isInteger(scheduleHour) ? Math.max(0, Math.min(23, scheduleHour)) : 7,
    scheduleMinute: Number.isInteger(scheduleMinute) ? Math.max(0, Math.min(59, scheduleMinute)) : 30,
    scheduleTimezone: typeof entry?.scheduleTimezone === "string" ? entry.scheduleTimezone : "Asia/Kolkata",
    lastIngestAfterEpoch: Math.max(0, Number.parseInt(String(entry?.lastIngestAfterEpoch ?? "0"), 10) || 0),
    lastScheduledRunDate:
      typeof entry?.lastScheduledRunDate === "string" && entry.lastScheduledRunDate.trim()
        ? entry.lastScheduledRunDate.trim()
        : null,
    lastIngestAt:
      typeof entry?.lastIngestAt === "string" && entry.lastIngestAt.trim() ? entry.lastIngestAt.trim() : null,
    updatedAt: typeof entry?.updatedAt === "string" ? entry.updatedAt : nowIso
  };
}

function mergeBrokerMappingsWithDefaults(mappings) {
  const normalized = Array.isArray(mappings)
    ? mappings
        .filter((entry) => entry && typeof entry.broker === "string")
        .map((entry) => ({
          broker: entry.broker.trim() || "Unnamed Broker",
          patterns: Array.isArray(entry.patterns)
            ? entry.patterns.map((pattern) => String(pattern).trim()).filter(Boolean)
            : [],
          enabled: entry.enabled !== false
        }))
        .filter((entry) => entry.patterns.length > 0)
    : [];

  if (normalized.length === 0) {
    return structuredClone(defaultBrokerMappings);
  }

  const knownBrokers = new Set(normalized.map((entry) => entry.broker.toLowerCase()));
  for (const fallback of defaultBrokerMappings) {
    if (!knownBrokers.has(fallback.broker.toLowerCase())) {
      normalized.push(structuredClone(fallback));
    }
  }

  return normalized;
}

function mergeDbDefaults(value) {
  return {
    ...structuredClone(defaultDb),
    ...value,
    counters: {
      ...structuredClone(defaultDb.counters),
      ...(value.counters ?? {})
    },
    cronState: {
      ...structuredClone(defaultDb.cronState),
      ...(value.cronState ?? {})
    },
    users: Array.isArray(value.users) ? value.users : [],
    sessions: Array.isArray(value.sessions) ? value.sessions : [],
    gmailConnections: Array.isArray(value.gmailConnections) ? value.gmailConnections : [],
    gmailPreferences: Array.isArray(value.gmailPreferences)
      ? value.gmailPreferences.map((entry) => normalizeGmailPreferencesEntry(entry))
      : [],
    emailArchives: Array.isArray(value.emailArchives) ? value.emailArchives : [],
    notes: Array.isArray(value.notes) ? value.notes : []
  };
}

async function loadDb() {
  await mkdir(dataDir, { recursive: true });

  if (isDatabaseEnabled()) {
    try {
      const dbState = await readDbFromDatabase();
      if (dbState) {
        log("Loaded brokerage state from Postgres");
        return mergeDbDefaults(dbState);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown DB read error";
      log("Failed reading brokerage state from Postgres. Falling back to file.", { message });
    }
  }

  try {
    const raw = await readFile(dbFilePath, "utf8");
    const parsed = JSON.parse(raw);
    const merged = mergeDbDefaults(parsed);
    if (isDatabaseEnabled()) {
      await writeDbToDatabase(merged);
      log("Backfilled brokerage state to Postgres from file snapshot");
    }
    return merged;
  } catch {
    const fresh = structuredClone(defaultDb);
    await writeJsonFile(dbFilePath, fresh);
    if (isDatabaseEnabled()) {
      await writeDbToDatabase(fresh);
    }
    return fresh;
  }
}

function persistDb() {
  persistQueue = persistQueue
    .then(async () => {
      if (isDatabaseEnabled()) {
        await writeDbToDatabase(db);
      }
      await writeJsonFile(dbFilePath, db);
    })
    .catch((error) => {
      log("Failed to persist db", { message: error instanceof Error ? error.message : String(error) });
    });

  return persistQueue;
}

async function writeJsonFile(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function deriveKey(secret) {
  return createHash("sha256").update(secret).digest();
}

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value) {
  const padding = (4 - (value.length % 4)) % 4;
  const normalized = `${value}${"=".repeat(padding)}`.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(normalized, "base64");
}

function signPayload(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", authSecret).update(data).digest();
  return `${data}.${base64UrlEncode(signature)}`;
}

function verifySignedPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const data = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac("sha256", authSecret).update(data).digest();
  const providedSignature = base64UrlDecode(encodedSignature);

  if (expectedSignature.length !== providedSignature.length) {
    return null;
  }

  if (!timingSafeEqual(expectedSignature, providedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function encryptValue(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${base64UrlEncode(iv)}.${base64UrlEncode(tag)}.${base64UrlEncode(encrypted)}`;
}

function decryptValue(encoded) {
  const [ivRaw, tagRaw, dataRaw] = encoded.split(".");
  if (!ivRaw || !tagRaw || !dataRaw) {
    throw new Error("Invalid encrypted payload format");
  }

  const iv = base64UrlDecode(ivRaw);
  const tag = base64UrlDecode(tagRaw);
  const encryptedData = base64UrlDecode(dataRaw);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return decrypted.toString("utf8");
}

function newId(prefix) {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}

function getBearerToken(req) {
  const header = req.headers.authorization;
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

function getSessionForRequest(req) {
  const token = getBearerToken(req);
  if (!token) {
    return null;
  }

  const payload = verifySignedPayload(token);
  if (!payload || payload.typ !== "session") {
    return null;
  }

  const session = db.sessions.find((item) => item.id === payload.sid && item.userId === payload.uid);
  if (!session) {
    return null;
  }

  if (session.revokedAt) {
    return null;
  }

  if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) {
    return null;
  }

  return {
    session,
    token,
    payload
  };
}

function getUserById(userId) {
  return db.users.find((user) => user.id === userId) || null;
}

function getGoogleConnection(userId) {
  return db.gmailConnections.find((connection) => connection.userId === userId) || null;
}

function getOrCreateGmailPreferences(userId) {
  let prefs = db.gmailPreferences.find((entry) => entry.userId === userId);
  if (!prefs) {
    const nowEpoch = Math.floor(Date.now() / 1000);
    prefs = {
      userId,
      maxResults: 25,
      query: "",
      includeUnmapped: false,
      brokerMappings: structuredClone(defaultBrokerMappings),
      trackedLabelIds: [],
      trackedLabelNames: [],
      scheduleEnabled: false,
      scheduleHour: 7,
      scheduleMinute: 30,
      scheduleTimezone: "Asia/Kolkata",
      lastIngestAfterEpoch: nowEpoch,
      lastScheduledRunDate: null,
      lastIngestAt: null,
      updatedAt: new Date().toISOString()
    };
    db.gmailPreferences.push(prefs);
  } else {
    Object.assign(prefs, normalizeGmailPreferencesEntry(prefs));
  }

  return prefs;
}

function requireAuth(req, res) {
  const authContext = getSessionForRequest(req);
  if (!authContext) {
    sendJson(req, res, 401, { error: "Unauthorized" });
    return null;
  }

  const user = getUserById(authContext.payload.uid);
  if (!user) {
    sendJson(req, res, 401, { error: "Session user missing" });
    return null;
  }

  authContext.session.lastSeenAt = new Date().toISOString();
  persistDb();

  return {
    user,
    session: authContext.session,
    token: authContext.token
  };
}

function normalizeRedirect(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.replace(/\/$/, "") || `${url.origin}/`;
  } catch {
    return null;
  }
}

function isAllowedRedirect(value) {
  const normalized = normalizeRedirect(value);
  if (!normalized) {
    return false;
  }
  return allowedRedirects.has(normalized);
}

function resolveRedirect(value) {
  if (value && isAllowedRedirect(value)) {
    return value;
  }
  return frontendUrl;
}

function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function resolveTimeZone(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed && isValidTimeZone(trimmed)) {
    return trimmed;
  }
  return "Asia/Kolkata";
}

function getZonedDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const partMap = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    dateKey: `${partMap.year}-${partMap.month}-${partMap.day}`,
    hour: Number.parseInt(partMap.hour ?? "0", 10),
    minute: Number.parseInt(partMap.minute ?? "0", 10)
  };
}

function isScheduleDueNow(prefs, now = new Date()) {
  if (!prefs?.scheduleEnabled) {
    return false;
  }

  const parts = getZonedDateParts(now, prefs.scheduleTimezone);
  const scheduleHour = Number.parseInt(String(prefs.scheduleHour ?? 0), 10);
  const scheduleMinute = Number.parseInt(String(prefs.scheduleMinute ?? 0), 10);
  const dueTimeReached = parts.hour > scheduleHour || (parts.hour === scheduleHour && parts.minute >= scheduleMinute);
  if (!dueTimeReached) {
    return false;
  }

  return prefs.lastScheduledRunDate !== parts.dateKey;
}

function composeIngestQuery(baseQuery, afterEpoch) {
  const chunks = [];
  if (typeof baseQuery === "string" && baseQuery.trim()) {
    chunks.push(baseQuery.trim());
  }
  if (Number.isFinite(afterEpoch) && afterEpoch > 0) {
    chunks.push(`after:${Math.floor(afterEpoch)}`);
  }
  return chunks.join(" ").trim();
}

function sanitizeLabelList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => String(value).trim())
    .filter(Boolean)
    .slice(0, 100);
}

function isGoogleConfigured() {
  return Boolean(googleClientId && googleClientSecret && googleRedirectUri);
}

function createOAuthStateToken(redirectUri) {
  const nowSec = Math.floor(Date.now() / 1000);
  return signPayload({
    typ: "oauth_state",
    redirectUri,
    nonce: randomBytes(12).toString("hex"),
    iat: nowSec,
    exp: nowSec + 10 * 60
  });
}

function createSessionToken(userId, sessionId) {
  const nowSec = Math.floor(Date.now() / 1000);
  return signPayload({
    typ: "session",
    uid: userId,
    sid: sessionId,
    iat: nowSec,
    exp: nowSec + 7 * 24 * 60 * 60
  });
}

function createShareToken(params) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresHours = Number.isFinite(params.expiresHours) ? params.expiresHours : 24;

  return signPayload({
    typ: "share_file",
    aid: params.archiveId,
    kind: params.kind,
    idx: params.index,
    iat: nowSec,
    exp: nowSec + Math.max(1, Math.min(168, expiresHours)) * 60 * 60
  });
}

async function exchangeAuthCodeForTokens(code) {
  const body = new URLSearchParams({
    client_id: googleClientId,
    client_secret: googleClientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: googleRedirectUri
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status}): ${data.error ?? "unknown"}`);
  }

  return data;
}

async function refreshGoogleTokens(refreshToken) {
  const body = new URLSearchParams({
    client_id: googleClientId,
    client_secret: googleClientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Google token refresh failed (${response.status}): ${data.error ?? "unknown"}`);
  }

  return data;
}

async function fetchGoogleUserInfo(accessToken) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Google userinfo failed (${response.status})`);
  }

  return data;
}

function upsertUserFromGoogle(userInfo) {
  const now = new Date().toISOString();
  let user = db.users.find((entry) => entry.googleSub === userInfo.sub || entry.email === userInfo.email);

  if (!user) {
    user = {
      id: newId("user"),
      provider: "google",
      googleSub: userInfo.sub,
      email: userInfo.email,
      name: userInfo.name ?? userInfo.email,
      picture: userInfo.picture ?? null,
      createdAt: now,
      updatedAt: now
    };

    db.users.push(user);
  } else {
    user.googleSub = userInfo.sub;
    user.email = userInfo.email;
    user.name = userInfo.name ?? user.name;
    user.picture = userInfo.picture ?? user.picture;
    user.updatedAt = now;
  }

  return user;
}

function upsertGoogleConnection(user, tokenData) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + Number(tokenData.expires_in ?? 3600) * 1000).toISOString();
  let connection = db.gmailConnections.find((entry) => entry.userId === user.id);

  const refreshTokenEncrypted = tokenData.refresh_token
    ? encryptValue(tokenData.refresh_token)
    : connection?.refreshTokenEncrypted ?? null;

  if (!connection) {
    connection = {
      id: newId("conn"),
      userId: user.id,
      email: user.email,
      googleSub: user.googleSub,
      scope: tokenData.scope ?? googleScopes,
      accessTokenEncrypted: encryptValue(tokenData.access_token),
      refreshTokenEncrypted,
      expiresAt,
      tokenUpdatedAt: now,
      createdAt: now
    };
    db.gmailConnections.push(connection);
  } else {
    connection.email = user.email;
    connection.googleSub = user.googleSub;
    connection.scope = tokenData.scope ?? connection.scope;
    connection.accessTokenEncrypted = encryptValue(tokenData.access_token);
    connection.refreshTokenEncrypted = refreshTokenEncrypted;
    connection.expiresAt = expiresAt;
    connection.tokenUpdatedAt = now;
  }

  return connection;
}

function createSessionForUser(userId) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const sessionId = newId("sess");

  db.sessions.push({
    id: sessionId,
    userId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    lastSeenAt: now.toISOString(),
    revokedAt: null
  });

  return {
    sessionId,
    token: createSessionToken(userId, sessionId)
  };
}

async function getValidGoogleAccessToken(connection) {
  const expiresAt = new Date(connection.expiresAt).getTime();
  if (expiresAt - Date.now() > 60_000) {
    return decryptValue(connection.accessTokenEncrypted);
  }

  if (!connection.refreshTokenEncrypted) {
    throw new Error("Google refresh token not available. Reconnect Gmail.");
  }

  const refreshToken = decryptValue(connection.refreshTokenEncrypted);
  const refreshed = await refreshGoogleTokens(refreshToken);

  connection.accessTokenEncrypted = encryptValue(refreshed.access_token);
  connection.expiresAt = new Date(Date.now() + Number(refreshed.expires_in ?? 3600) * 1000).toISOString();
  connection.tokenUpdatedAt = new Date().toISOString();
  if (refreshed.scope) {
    connection.scope = refreshed.scope;
  }

  await persistDb();
  return refreshed.access_token;
}

function parseFromHeader(rawFrom) {
  const from = rawFrom ?? "";
  const match = from.match(/<([^>]+)>/);
  const email = (match?.[1] ?? from).trim().toLowerCase();
  const name = from.replace(/<[^>]+>/, "").replace(/"/g, "").trim() || email;
  return { raw: from, email, name };
}

function detectBroker(fromHeader, brokerMappings) {
  const normalized = fromHeader.toLowerCase();
  for (const mapping of brokerMappings) {
    if (!mapping.enabled) {
      continue;
    }

    if (mapping.patterns.some((pattern) => normalized.includes(pattern.toLowerCase().trim()))) {
      return mapping.broker;
    }
  }

  return "Unmapped Broker";
}

async function gmailApiGet(accessToken, endpoint, query = undefined) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }

      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry === undefined || entry === null || entry === "") {
            continue;
          }
          url.searchParams.append(key, String(entry));
        }
        continue;
      }

      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gmail API failed (${response.status}) at ${endpoint}: ${data.error?.message ?? "unknown"}`);
  }

  return data;
}

function getHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const header of headers ?? []) {
    if (String(header.name ?? "").toLowerCase() === lower) {
      return String(header.value ?? "");
    }
  }
  return "";
}

function walkParts(part, callback) {
  callback(part);
  for (const child of part.parts ?? []) {
    walkParts(child, callback);
  }
}

function decodeGoogleBase64(rawData) {
  return base64UrlDecode(String(rawData ?? ""));
}

function extractBodyPreview(payload, fallbackSnippet) {
  let selected = "";

  walkParts(payload, (part) => {
    if (selected) {
      return;
    }

    const mimeType = String(part.mimeType ?? "").toLowerCase();
    const data = part.body?.data;
    if (!data) {
      return;
    }

    if (mimeType === "text/plain") {
      selected = decodeGoogleBase64(data).toString("utf8");
      return;
    }

    if (mimeType === "text/html") {
      const html = decodeGoogleBase64(data).toString("utf8");
      selected = stripHtmlTags(html);
    }
  });

  return (selected || fallbackSnippet || "").replace(/\s+/g, " ").trim().slice(0, 4000);
}

function stripHtmlTags(value) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAttachmentParts(payload) {
  const attachments = [];

  walkParts(payload, (part) => {
    const attachmentId = part.body?.attachmentId;
    if (!attachmentId) {
      return;
    }

    const filename = String(part.filename ?? "").trim();
    attachments.push({
      attachmentId,
      filename,
      mimeType: String(part.mimeType ?? "application/octet-stream"),
      size: Number(part.body?.size ?? 0)
    });
  });

  return attachments;
}

function sanitizeFileName(value) {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "file";
}

function makeArchivePublicRecord(record) {
  return {
    id: record.id,
    broker: record.broker,
    from: record.from,
    subject: record.subject,
    snippet: record.snippet,
    bodyPreview: record.bodyPreview,
    dateHeader: record.dateHeader,
    ingestedAt: record.ingestedAt,
    gmailMessageId: record.gmailMessageId,
    gmailThreadId: record.gmailThreadId,
    gmailMessageUrl: record.gmailMessageUrl,
    duplicateOfArchiveId: record.duplicateOfArchiveId ?? null,
    downloadUrl: `/api/email-archives/${record.id}/raw`,
    attachments: (record.attachments ?? []).map((attachment, index) => ({
      index,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      downloadUrl: `/api/email-archives/${record.id}/attachments/${index}`
    }))
  };
}

async function archiveGmailMessage(user, gmailMessage, rawData, includeAttachments, accessToken, broker) {
  const now = new Date();
  const nowIso = now.toISOString();
  const gmailMessageId = String(gmailMessage.id ?? "");

  const existing = db.emailArchives.find(
    (entry) => entry.userId === user.id && String(entry.gmailMessageId) === gmailMessageId
  );
  if (existing) {
    return {
      archived: false,
      skippedReason: "already_archived",
      record: existing
    };
  }

  const payload = gmailMessage.payload ?? {};
  const from = getHeader(payload.headers, "From");
  const subject = getHeader(payload.headers, "Subject") || "(No Subject)";
  const dateHeader = getHeader(payload.headers, "Date");
  const messageIdHeader = getHeader(payload.headers, "Message-ID");
  const bodyPreview = extractBodyPreview(payload, gmailMessage.snippet ?? "");

  const archiveId = newId("arc");
  const rawBuffer = decodeGoogleBase64(rawData.raw ?? "");

  const attachments = [];
  if (includeAttachments) {
    const attachmentParts = extractAttachmentParts(payload);

    for (let index = 0; index < attachmentParts.length; index += 1) {
      const part = attachmentParts[index];
      const attachmentPayload = await gmailApiGet(
        accessToken,
        `messages/${gmailMessageId}/attachments/${part.attachmentId}`
      );
      const fileData = decodeGoogleBase64(attachmentPayload.data ?? "");
      const baseName = sanitizeFileName(part.filename || `attachment_${index + 1}`);

      attachments.push({
        filename: part.filename || baseName,
        mimeType: part.mimeType,
        sizeBytes: fileData.length,
        contentBase64: fileData.toString("base64")
      });
    }
  }

  const record = {
    id: archiveId,
    userId: user.id,
    broker,
    from,
    subject,
    snippet: String(gmailMessage.snippet ?? ""),
    bodyPreview,
    dateHeader,
    messageIdHeader,
    gmailMessageId,
    gmailThreadId: String(gmailMessage.threadId ?? ""),
    gmailMessageUrl: `https://mail.google.com/mail/u/0/#inbox/${gmailMessageId}`,
    internalDateMs: Number(gmailMessage.internalDate ?? Date.now()),
    emlRelativePath: null,
    emlContentBase64: rawBuffer.toString("base64"),
    attachments,
    ingestedAt: nowIso,
    duplicateOfArchiveId: null
  };

  db.emailArchives.push(record);

  return {
    archived: true,
    skippedReason: null,
    record
  };
}

function findArchiveForUser(userId, archiveId) {
  return db.emailArchives.find((entry) => entry.userId === userId && entry.id === archiveId) || null;
}

function findArchiveById(archiveId) {
  return db.emailArchives.find((entry) => entry.id === archiveId) || null;
}

async function sendStoredFile(req, res, absolutePath, options) {
  try {
    const fileInfo = await stat(absolutePath);
    if (!fileInfo.isFile()) {
      sendJson(req, res, 404, { error: "File not found" });
      return;
    }

    applyCorsHeaders(req, res);
    res.statusCode = 200;
    res.setHeader("Content-Type", options.contentType || "application/octet-stream");
    if (options.downloadName) {
      res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFileName(options.downloadName)}"`);
    }
    res.setHeader("Content-Length", String(fileInfo.size));

    const stream = createReadStream(absolutePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        sendJson(req, res, 500, { error: "Failed to stream file" });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  } catch {
    sendJson(req, res, 404, { error: "File not found" });
  }
}

function sendBufferFile(req, res, buffer, options) {
  applyCorsHeaders(req, res);
  res.statusCode = 200;
  res.setHeader("Content-Type", options.contentType || "application/octet-stream");
  if (options.downloadName) {
    res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFileName(options.downloadName)}"`);
  }
  res.setHeader("Content-Length", String(buffer.length));
  res.end(buffer);
}

function getPublicApiBase(req) {
  if (publicApiBase) {
    return publicApiBase;
  }

  const host = req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${host}`;
}

function handleHealth(req, res) {
  sendJson(req, res, 200, {
    ok: true,
    service: appName,
    env: appEnv,
    time: new Date().toISOString(),
    authConfigured: isGoogleConfigured(),
    databaseConfigured: Boolean(databaseUrl),
    databaseEnabled: isDatabaseEnabled()
  });
}

function handleStatus(req, res) {
  sendJson(req, res, 200, {
    service: appName,
    env: appEnv,
    serverTime: new Date().toISOString(),
    notesCount: db.notes.length,
    cronRunCount: db.cronState.runCount,
    lastCronRunAt: db.cronState.lastRunAt,
    workerHeartbeatCount: db.cronState.workerHeartbeatCount,
    lastWorkerHeartbeatAt: db.cronState.lastWorkerHeartbeatAt,
    totalUsers: db.users.length,
    totalArchives: db.emailArchives.length,
    databaseConfigured: Boolean(databaseUrl),
    databaseEnabled: isDatabaseEnabled()
  });
}

function handleGetNotes(req, res) {
  sendJson(req, res, 200, {
    notes: db.notes,
    total: db.notes.length
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
    id: db.counters.noteId,
    text,
    createdAt: new Date().toISOString()
  };

  db.counters.noteId += 1;
  db.notes.unshift(note);
  await persistDb();

  sendJson(req, res, 201, {
    note,
    total: db.notes.length
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

  db.cronState.runCount += 1;
  db.cronState.lastRunAt = new Date().toISOString();
  const scheduleSummary = await runScheduledIngests(body.trigger ?? "cron");
  await persistDb();

  log("Cron run received", {
    runCount: db.cronState.runCount,
    trigger: body.trigger ?? "unknown"
  });

  sendJson(req, res, 200, {
    ok: true,
    runCount: db.cronState.runCount,
    lastCronRunAt: db.cronState.lastRunAt,
    scheduleSummary
  });
}

async function handleWorkerHeartbeat(req, res) {
  if (cronSecret) {
    const providedSecret = req.headers["x-cron-secret"];
    if (providedSecret !== cronSecret) {
      sendJson(req, res, 401, { error: "Invalid heartbeat secret." });
      return;
    }
  }

  db.cronState.workerHeartbeatCount += 1;
  db.cronState.lastWorkerHeartbeatAt = new Date().toISOString();
  await persistDb();

  sendJson(req, res, 200, {
    ok: true,
    workerHeartbeatCount: db.cronState.workerHeartbeatCount,
    lastWorkerHeartbeatAt: db.cronState.lastWorkerHeartbeatAt
  });
}

async function handleGoogleAuthUrl(req, res, requestUrl) {
  if (!isGoogleConfigured()) {
    sendJson(req, res, 503, {
      error:
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI."
    });
    return;
  }

  const requestedRedirect = requestUrl.searchParams.get("redirect_uri") || requestUrl.searchParams.get("redirectUri");
  const redirectUri = resolveRedirect(requestedRedirect);
  const stateToken = createOAuthStateToken(redirectUri);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", googleClientId);
  url.searchParams.set("redirect_uri", googleRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", googleScopes);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", stateToken);

  sendJson(req, res, 200, {
    authUrl: url.toString(),
    redirectUri
  });
}

async function handleGoogleAuthCallback(req, res, requestUrl) {
  const code = requestUrl.searchParams.get("code");
  const stateToken = requestUrl.searchParams.get("state") || "";
  const oauthError = requestUrl.searchParams.get("error");

  const defaultRedirect = resolveRedirect(null);

  if (!stateToken) {
    sendText(req, res, 400, "Missing OAuth state token.");
    return;
  }

  const statePayload = verifySignedPayload(stateToken);
  const redirectUri = resolveRedirect(statePayload?.redirectUri || defaultRedirect);

  if (!statePayload || statePayload.typ !== "oauth_state") {
    sendRedirect(req, res, `${redirectUri}#auth=error&message=${encodeURIComponent("Invalid OAuth state")}`);
    return;
  }

  if (oauthError) {
    sendRedirect(req, res, `${redirectUri}#auth=error&message=${encodeURIComponent(oauthError)}`);
    return;
  }

  if (!code) {
    sendRedirect(req, res, `${redirectUri}#auth=error&message=${encodeURIComponent("Missing authorization code")}`);
    return;
  }

  try {
    const tokenData = await exchangeAuthCodeForTokens(code);
    const userInfo = await fetchGoogleUserInfo(tokenData.access_token);

    if (!userInfo.email || !userInfo.sub) {
      throw new Error("Google user info missing required identity fields");
    }

    const user = upsertUserFromGoogle(userInfo);
    upsertGoogleConnection(user, tokenData);

    const session = createSessionForUser(user.id);
    await persistDb();

    const successUrl = `${redirectUri}#auth=success&token=${encodeURIComponent(session.token)}&email=${encodeURIComponent(user.email)}`;
    sendRedirect(req, res, successUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OAuth callback failed";
    log("OAuth callback failed", { message });
    sendRedirect(req, res, `${redirectUri}#auth=error&message=${encodeURIComponent(message)}`);
  }
}

async function handleAuthMe(req, res, auth) {
  const connection = getGoogleConnection(auth.user.id);
  const prefs = getOrCreateGmailPreferences(auth.user.id);

  sendJson(req, res, 200, {
    user: {
      id: auth.user.id,
      email: auth.user.email,
      name: auth.user.name,
      picture: auth.user.picture
    },
    gmail: {
      connected: Boolean(connection),
      email: connection?.email ?? null,
      scope: connection?.scope ?? null,
      tokenUpdatedAt: connection?.tokenUpdatedAt ?? null,
      expiresAt: connection?.expiresAt ?? null
    },
    ingestionPreferences: {
      maxResults: prefs.maxResults,
      query: prefs.query,
      includeUnmapped: prefs.includeUnmapped,
      brokerMappings: prefs.brokerMappings,
      trackedLabelIds: prefs.trackedLabelIds,
      trackedLabelNames: prefs.trackedLabelNames,
      scheduleEnabled: prefs.scheduleEnabled,
      scheduleHour: prefs.scheduleHour,
      scheduleMinute: prefs.scheduleMinute,
      scheduleTimezone: prefs.scheduleTimezone,
      lastIngestAfterEpoch: prefs.lastIngestAfterEpoch,
      lastIngestAt: prefs.lastIngestAt,
      lastScheduledRunDate: prefs.lastScheduledRunDate
    }
  });
}

async function handleAuthLogout(req, res, auth) {
  auth.session.revokedAt = new Date().toISOString();
  await persistDb();
  sendJson(req, res, 200, { ok: true });
}

async function handleGetGmailConnection(req, res, auth) {
  const connection = getGoogleConnection(auth.user.id);
  if (!connection) {
    sendJson(req, res, 200, { connected: false });
    return;
  }

  sendJson(req, res, 200, {
    connected: true,
    email: connection.email,
    scope: connection.scope,
    tokenUpdatedAt: connection.tokenUpdatedAt,
    expiresAt: connection.expiresAt
  });
}

async function handleGetGmailLabels(req, res, auth) {
  const connection = getGoogleConnection(auth.user.id);
  if (!connection) {
    sendJson(req, res, 400, { error: "Gmail is not connected for this user." });
    return;
  }

  const accessToken = await getValidGoogleAccessToken(connection);
  const labelResponse = await gmailApiGet(accessToken, "labels");
  const labels = Array.isArray(labelResponse.labels) ? labelResponse.labels : [];
  const sorted = labels
    .map((label) => ({
      id: String(label.id ?? ""),
      name: String(label.name ?? ""),
      type: String(label.type ?? "user").toLowerCase(),
      messagesTotal: Number(label.messagesTotal ?? 0),
      threadsTotal: Number(label.threadsTotal ?? 0)
    }))
    .filter((label) => label.id && label.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  sendJson(req, res, 200, { labels: sorted, total: sorted.length });
}

async function handleGetGmailPreferences(req, res, auth) {
  const prefs = getOrCreateGmailPreferences(auth.user.id);
  await persistDb();
  sendJson(req, res, 200, prefs);
}

async function handlePutGmailPreferences(req, res, auth) {
  const body = await readJsonBody(req);
  const prefs = getOrCreateGmailPreferences(auth.user.id);

  const maxResults = Number(body.maxResults ?? prefs.maxResults);
  const includeUnmapped = Boolean(body.includeUnmapped ?? prefs.includeUnmapped);
  const query = typeof body.query === "string" ? body.query.trim() : prefs.query;
  const trackedLabelIds = sanitizeLabelList(body.trackedLabelIds ?? prefs.trackedLabelIds);
  const trackedLabelNames = sanitizeLabelList(body.trackedLabelNames ?? prefs.trackedLabelNames);
  const scheduleEnabled = Boolean(body.scheduleEnabled ?? prefs.scheduleEnabled);
  const scheduleHour = Number.parseInt(String(body.scheduleHour ?? prefs.scheduleHour), 10);
  const scheduleMinute = Number.parseInt(String(body.scheduleMinute ?? prefs.scheduleMinute), 10);
  const scheduleTimezone = resolveTimeZone(body.scheduleTimezone ?? prefs.scheduleTimezone);
  const resetCursorToNow = body.startFromNow === true;
  const resetCursorToStart = body.resetCursor === true;

  const brokerMappings = Array.isArray(body.brokerMappings) ? body.brokerMappings : prefs.brokerMappings;

  prefs.maxResults = Math.max(1, Math.min(100, Number.isFinite(maxResults) ? maxResults : 25));
  prefs.query = query;
  prefs.includeUnmapped = includeUnmapped;
  prefs.brokerMappings = mergeBrokerMappingsWithDefaults(brokerMappings);
  prefs.trackedLabelIds = trackedLabelIds;
  prefs.trackedLabelNames = trackedLabelNames;
  prefs.scheduleEnabled = scheduleEnabled;
  prefs.scheduleHour = Number.isInteger(scheduleHour) ? Math.max(0, Math.min(23, scheduleHour)) : 7;
  prefs.scheduleMinute = Number.isInteger(scheduleMinute) ? Math.max(0, Math.min(59, scheduleMinute)) : 30;
  prefs.scheduleTimezone = scheduleTimezone;
  if (resetCursorToStart) {
    prefs.lastIngestAfterEpoch = 0;
    prefs.lastScheduledRunDate = null;
  } else if (resetCursorToNow) {
    prefs.lastIngestAfterEpoch = Math.floor(Date.now() / 1000);
  }
  prefs.updatedAt = new Date().toISOString();

  await persistDb();
  sendJson(req, res, 200, prefs);
}

async function runGmailIngestForUser(params) {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const labelIds = sanitizeLabelList(params.labelIds ?? params.prefs.trackedLabelIds);
  const trackedLabelIds = sanitizeLabelList(params.prefs.trackedLabelIds);
  const trackedLabelNames = sanitizeLabelList(params.prefs.trackedLabelNames);
  const labelBrokerMap = new Map();
  for (let index = 0; index < trackedLabelIds.length; index += 1) {
    const labelId = trackedLabelIds[index];
    const labelName = trackedLabelNames[index];
    labelBrokerMap.set(labelId, labelName || labelId);
  }

  if (labelIds.length === 0) {
    throw new Error("No tracked labels selected. Configure labels in Ingest setup.");
  }

  const includeAttachments = params.includeAttachments !== false;
  const maxResults = Math.max(
    1,
    Math.min(100, Number.isFinite(Number(params.maxResults)) ? Number(params.maxResults) : params.prefs.maxResults)
  );

  const explicitQuery = typeof params.query === "string" && params.query.trim() ? params.query.trim() : params.prefs.query;
  const startAfterEpoch =
    Number.isFinite(Number(params.afterEpoch)) && Number(params.afterEpoch) > 0
      ? Number(params.afterEpoch)
      : Number(params.prefs.lastIngestAfterEpoch ?? 0);
  const query = composeIngestQuery(explicitQuery, startAfterEpoch);
  const accessToken = await getValidGoogleAccessToken(params.connection);

  const listResponse = await gmailApiGet(accessToken, "messages", {
    maxResults,
    q: query,
    labelIds
  });

  const messages = Array.isArray(listResponse.messages) ? listResponse.messages : [];
  const results = [];

  let archivedCount = 0;
  let skippedCount = 0;
  let skippedUnmappedCount = 0;
  let attachmentCount = 0;
  let newestInternalEpoch = 0;

  for (const messageStub of messages) {
    const full = await gmailApiGet(accessToken, `messages/${messageStub.id}`, { format: "full" });
    const raw = await gmailApiGet(accessToken, `messages/${messageStub.id}`, { format: "raw" });

    const from = getHeader(full.payload?.headers, "From");
    const sender = parseFromHeader(from);
    const messageLabelIds = Array.isArray(full.labelIds) ? full.labelIds.map((value) => String(value)) : [];
    let broker = null;
    for (const labelId of labelIds) {
      if (messageLabelIds.includes(labelId)) {
        broker = labelBrokerMap.get(labelId) || labelId;
        break;
      }
    }
    if (!broker) {
      broker = detectBroker(`${from} ${sender.email}`, params.prefs.brokerMappings);
    }
    const internalEpoch = Math.floor(Number(full.internalDate ?? Date.now()) / 1000);
    newestInternalEpoch = Math.max(newestInternalEpoch, internalEpoch);

    const archived = await archiveGmailMessage(params.user, full, raw, includeAttachments, accessToken, broker);

    if (!archived.archived) {
      skippedCount += 1;
      continue;
    }

    archivedCount += 1;
    attachmentCount += archived.record.attachments.length;
    results.push(makeArchivePublicRecord(archived.record));
  }

  const skippedOnlyUnmapped = messages.length > 0 && archivedCount === 0 && skippedUnmappedCount === messages.length;
  if (!skippedOnlyUnmapped) {
    params.prefs.lastIngestAfterEpoch = Math.max(startAfterEpoch, newestInternalEpoch, nowEpoch);
  }
  params.prefs.lastIngestAt = new Date().toISOString();
  params.prefs.updatedAt = new Date().toISOString();

  return {
    summary: {
      queryUsed: query,
      requestedMaxResults: maxResults,
      fetchedMessages: messages.length,
      archivedCount,
      skippedCount,
      skippedUnmappedCount,
      cursorAdvanced: !skippedOnlyUnmapped,
      attachmentCount,
      trackedLabels: labelIds,
      cursorAfterEpoch: params.prefs.lastIngestAfterEpoch
    },
    items: results
  };
}

async function runScheduledIngests(trigger = "scheduled") {
  const now = new Date();
  const details = [];
  let dueUsers = 0;
  let successfulRuns = 0;
  let failedRuns = 0;
  let archivedCount = 0;

  for (const connection of db.gmailConnections) {
    const user = getUserById(connection.userId);
    if (!user) {
      continue;
    }

    const prefs = getOrCreateGmailPreferences(user.id);
    if (!prefs.scheduleEnabled || prefs.trackedLabelIds.length === 0) {
      continue;
    }

    if (!isScheduleDueNow(prefs, now)) {
      continue;
    }

    dueUsers += 1;
    const zoneParts = getZonedDateParts(now, prefs.scheduleTimezone);

    try {
      const ingest = await runGmailIngestForUser({
        user,
        prefs,
        connection,
        includeAttachments: true
      });
      prefs.lastScheduledRunDate = zoneParts.dateKey;
      successfulRuns += 1;
      archivedCount += ingest.summary.archivedCount;
      details.push({
        userId: user.id,
        email: user.email,
        status: "ok",
        archivedCount: ingest.summary.archivedCount,
        fetchedMessages: ingest.summary.fetchedMessages
      });
    } catch (error) {
      failedRuns += 1;
      details.push({
        userId: user.id,
        email: user.email,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown ingest error"
      });
    }
  }

  await persistDb();

  return {
    trigger,
    dueUsers,
    successfulRuns,
    failedRuns,
    archivedCount,
    details
  };
}

async function handleGmailIngest(req, res, auth) {
  const connection = getGoogleConnection(auth.user.id);
  if (!connection) {
    sendJson(req, res, 400, { error: "Gmail is not connected for this user." });
    return;
  }

  const prefs = getOrCreateGmailPreferences(auth.user.id);
  const body = await readJsonBody(req);
  const ingest = await runGmailIngestForUser({
    user: auth.user,
    prefs,
    connection,
    includeAttachments: body.includeAttachments !== false,
    maxResults: body.maxResults,
    query: body.query,
    labelIds: body.labelIds,
    afterEpoch: body.afterEpoch
  });

  await persistDb();

  sendJson(req, res, 200, {
    ok: true,
    summary: ingest.summary,
    items: ingest.items
  });
}

async function handleListEmailArchives(req, res, auth, requestUrl) {
  const limitRaw = Number(requestUrl.searchParams.get("limit") ?? "30");
  const offsetRaw = Number(requestUrl.searchParams.get("offset") ?? "0");
  const brokerFilter = requestUrl.searchParams.get("broker")?.trim();

  const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 30));
  const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

  let records = db.emailArchives
    .filter((entry) => entry.userId === auth.user.id)
    .sort((a, b) => new Date(b.ingestedAt).getTime() - new Date(a.ingestedAt).getTime());

  if (brokerFilter) {
    records = records.filter((entry) => entry.broker === brokerFilter);
  }

  const sliced = records.slice(offset, offset + limit);

  sendJson(req, res, 200, {
    total: records.length,
    limit,
    offset,
    items: sliced.map(makeArchivePublicRecord)
  });
}

async function handleDownloadArchiveRaw(req, res, auth, archiveId) {
  const record = findArchiveForUser(auth.user.id, archiveId);
  if (!record) {
    sendJson(req, res, 404, { error: "Archive not found" });
    return;
  }

  const downloadName = `${sanitizeFileName(record.subject || archiveId)}.eml`;
  if (record.emlContentBase64) {
    sendBufferFile(req, res, Buffer.from(record.emlContentBase64, "base64"), {
      contentType: "message/rfc822",
      downloadName
    });
    return;
  }

  if (!record.emlRelativePath) {
    sendJson(req, res, 404, { error: "Archive source file not available" });
    return;
  }

  const absolutePath = path.join(dataDir, record.emlRelativePath);
  await sendStoredFile(req, res, absolutePath, {
    contentType: "message/rfc822",
    downloadName
  });
}

async function handleDownloadArchiveAttachment(req, res, auth, archiveId, attachmentIndexRaw) {
  const record = findArchiveForUser(auth.user.id, archiveId);
  if (!record) {
    sendJson(req, res, 404, { error: "Archive not found" });
    return;
  }

  const index = Number(attachmentIndexRaw);
  if (!Number.isInteger(index) || index < 0 || index >= record.attachments.length) {
    sendJson(req, res, 404, { error: "Attachment not found" });
    return;
  }

  const attachment = record.attachments[index];
  if (attachment.contentBase64) {
    sendBufferFile(req, res, Buffer.from(attachment.contentBase64, "base64"), {
      contentType: attachment.mimeType || "application/octet-stream",
      downloadName: attachment.filename
    });
    return;
  }

  if (!attachment.relativePath) {
    sendJson(req, res, 404, { error: "Attachment file not available" });
    return;
  }

  const absolutePath = path.join(dataDir, attachment.relativePath);

  await sendStoredFile(req, res, absolutePath, {
    contentType: attachment.mimeType || "application/octet-stream",
    downloadName: attachment.filename || attachment.diskName
  });
}

async function handleCreateShareLinks(req, res, auth, archiveId) {
  const record = findArchiveForUser(auth.user.id, archiveId);
  if (!record) {
    sendJson(req, res, 404, { error: "Archive not found" });
    return;
  }

  const body = await readJsonBody(req);
  const expiresHours = Math.max(1, Math.min(168, Number(body.expiresHours ?? 24)));
  const base = getPublicApiBase(req);

  const rawToken = createShareToken({
    archiveId,
    kind: "raw",
    index: -1,
    expiresHours
  });

  const attachments = record.attachments.map((attachment, index) => {
    const token = createShareToken({
      archiveId,
      kind: "attachment",
      index,
      expiresHours
    });

    return {
      index,
      filename: attachment.filename,
      url: `${base}/api/shared/file?token=${encodeURIComponent(token)}`
    };
  });

  sendJson(req, res, 200, {
    expiresHours,
    raw: {
      url: `${base}/api/shared/file?token=${encodeURIComponent(rawToken)}`
    },
    attachments
  });
}

async function handleSharedFileDownload(req, res, requestUrl) {
  const token = requestUrl.searchParams.get("token") || "";
  const payload = verifySignedPayload(token);

  if (!payload || payload.typ !== "share_file") {
    sendJson(req, res, 401, { error: "Invalid share token" });
    return;
  }

  const archive = findArchiveById(payload.aid);
  if (!archive) {
    sendJson(req, res, 404, { error: "Archive not found" });
    return;
  }

  if (payload.kind === "raw") {
    const downloadName = `${sanitizeFileName(archive.subject || archive.id)}.eml`;
    if (archive.emlContentBase64) {
      sendBufferFile(req, res, Buffer.from(archive.emlContentBase64, "base64"), {
        contentType: "message/rfc822",
        downloadName
      });
      return;
    }

    if (!archive.emlRelativePath) {
      sendJson(req, res, 404, { error: "Archive source file not available" });
      return;
    }

    const absolutePath = path.join(dataDir, archive.emlRelativePath);
    await sendStoredFile(req, res, absolutePath, {
      contentType: "message/rfc822",
      downloadName
    });
    return;
  }

  if (payload.kind === "attachment") {
    const index = Number(payload.idx);
    const attachment = archive.attachments[index];
    if (!attachment) {
      sendJson(req, res, 404, { error: "Attachment not found" });
      return;
    }

    if (attachment.contentBase64) {
      sendBufferFile(req, res, Buffer.from(attachment.contentBase64, "base64"), {
        contentType: attachment.mimeType || "application/octet-stream",
        downloadName: attachment.filename
      });
      return;
    }

    if (!attachment.relativePath) {
      sendJson(req, res, 404, { error: "Attachment file not available" });
      return;
    }

    const absolutePath = path.join(dataDir, attachment.relativePath);
    await sendStoredFile(req, res, absolutePath, {
      contentType: attachment.mimeType || "application/octet-stream",
      downloadName: attachment.filename || attachment.diskName
    });
    return;
  }

  sendJson(req, res, 400, { error: "Unsupported shared file type" });
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathName = requestUrl.pathname;
  const segments = pathName.split("/").filter(Boolean);

  if (method === "OPTIONS") {
    applyCorsHeaders(req, res);
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    if (method === "GET" && pathName === "/") {
      sendJson(req, res, 200, {
        message: "API is running",
        docs: [
          "GET /health",
          "GET /api/health",
          "GET /api/status",
          "GET /api/auth/google/url",
          "GET /api/auth/google/callback",
          "GET /api/auth/me",
          "GET /api/gmail/labels",
          "GET/PUT /api/gmail/preferences",
          "POST /api/gmail/ingest",
          "GET /api/email-archives"
        ]
      });
      return;
    }

    if (method === "GET" && (pathName === "/health" || pathName === "/api/health")) {
      handleHealth(req, res);
      return;
    }

    if (method === "GET" && pathName === "/api/status") {
      handleStatus(req, res);
      return;
    }

    if (method === "GET" && pathName === "/api/notes") {
      handleGetNotes(req, res);
      return;
    }

    if (method === "POST" && pathName === "/api/notes") {
      await handleCreateNote(req, res);
      return;
    }

    if (method === "POST" && pathName === "/api/jobs/daily") {
      await handleCronRun(req, res);
      return;
    }

    if (method === "POST" && pathName === "/api/internal/worker-heartbeat") {
      await handleWorkerHeartbeat(req, res);
      return;
    }

    if (method === "GET" && pathName === "/api/auth/google/url") {
      await handleGoogleAuthUrl(req, res, requestUrl);
      return;
    }

    if (method === "GET" && pathName === "/api/auth/google/callback") {
      await handleGoogleAuthCallback(req, res, requestUrl);
      return;
    }

    if (method === "GET" && pathName === "/api/shared/file") {
      await handleSharedFileDownload(req, res, requestUrl);
      return;
    }

    if (pathName === "/api/auth/me") {
      const auth = requireAuth(req, res);
      if (!auth) {
        return;
      }
      if (method === "GET") {
        await handleAuthMe(req, res, auth);
        return;
      }
    }

    if (pathName === "/api/auth/logout") {
      const auth = requireAuth(req, res);
      if (!auth) {
        return;
      }
      if (method === "POST") {
        await handleAuthLogout(req, res, auth);
        return;
      }
    }

    if (pathName === "/api/gmail/connection") {
      const auth = requireAuth(req, res);
      if (!auth) {
        return;
      }
      if (method === "GET") {
        await handleGetGmailConnection(req, res, auth);
        return;
      }
    }

    if (pathName === "/api/gmail/labels") {
      const auth = requireAuth(req, res);
      if (!auth) {
        return;
      }
      if (method === "GET") {
        await handleGetGmailLabels(req, res, auth);
        return;
      }
    }

    if (pathName === "/api/gmail/preferences") {
      const auth = requireAuth(req, res);
      if (!auth) {
        return;
      }
      if (method === "GET") {
        await handleGetGmailPreferences(req, res, auth);
        return;
      }
      if (method === "PUT") {
        await handlePutGmailPreferences(req, res, auth);
        return;
      }
    }

    if (pathName === "/api/gmail/ingest") {
      const auth = requireAuth(req, res);
      if (!auth) {
        return;
      }
      if (method === "POST") {
        await handleGmailIngest(req, res, auth);
        return;
      }
    }

    if (pathName === "/api/email-archives") {
      const auth = requireAuth(req, res);
      if (!auth) {
        return;
      }
      if (method === "GET") {
        await handleListEmailArchives(req, res, auth, requestUrl);
        return;
      }
    }

    if (segments.length === 4 && segments[0] === "api" && segments[1] === "email-archives" && segments[3] === "raw") {
      const auth = requireAuth(req, res);
      if (!auth) {
        return;
      }

      if (method === "GET") {
        await handleDownloadArchiveRaw(req, res, auth, segments[2]);
        return;
      }
    }

    if (
      segments.length === 5 &&
      segments[0] === "api" &&
      segments[1] === "email-archives" &&
      segments[3] === "attachments"
    ) {
      const auth = requireAuth(req, res);
      if (!auth) {
        return;
      }

      if (method === "GET") {
        await handleDownloadArchiveAttachment(req, res, auth, segments[2], segments[4]);
        return;
      }
    }

    if (segments.length === 4 && segments[0] === "api" && segments[1] === "email-archives" && segments[3] === "share-links") {
      const auth = requireAuth(req, res);
      if (!auth) {
        return;
      }

      if (method === "POST") {
        await handleCreateShareLinks(req, res, auth, segments[2]);
        return;
      }
    }

    sendJson(req, res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("Request failed", { method, path: pathName, message });
    sendJson(req, res, 400, { error: message });
  }
});

server.listen(port, "0.0.0.0", () => {
  log(`Listening on port ${port}`);
});

process.on("SIGTERM", () => {
  log("SIGTERM received, shutting down");
  server.close(() => process.exit(0));
});
