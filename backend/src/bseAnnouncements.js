const BSE_BASE_URL = "https://www.bseindia.com";
const BSE_API_URL = "https://api.bseindia.com";
const BSE_ANNOUNCEMENTS_API_PATH = "/BseIndiaAPI/api/AnnSubCategoryGetData/w";
const BSE_SCRIP_MASTER_API_PATH = "/BseIndiaAPI/api/ListofScripData/w";

const DEFAULT_CATEGORY = "-1";
const DEFAULT_SUBCATEGORY = "-1";
const DEFAULT_TYPE = "C";
const DEFAULT_SEARCH = "P";
const DEFAULT_SCRIP = "";
const DEFAULT_SCRIP_MASTER_SEGMENT = "Equity";
const DEFAULT_SCRIP_MASTER_STATUS = "";
const DEFAULT_SCRIP_MASTER_GROUP = "";
const DEFAULT_SCRIP_MASTER_SCRIP_CODE = "";

function buildBrowserHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: `${BSE_BASE_URL}/`,
    Origin: BSE_BASE_URL,
    Connection: "keep-alive"
  };
}

function formatDateToDdMmYyyy(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

function parseDdMmYyyyToYyyyMmDd(dateStr) {
  const value = String(dateStr ?? "").trim();
  const parts = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!parts) {
    throw new Error(`Invalid BSE date format '${value}'. Expected DD-MM-YYYY.`);
  }

  const day = Number.parseInt(parts[1], 10);
  const month = Number.parseInt(parts[2], 10);
  const year = Number.parseInt(parts[3], 10);
  const check = new Date(Date.UTC(year, month - 1, day));

  const isValid =
    check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;

  if (!isValid) {
    throw new Error(`Invalid BSE date value '${value}'.`);
  }

  return `${parts[3]}${parts[2]}${parts[1]}`;
}

function normalizeFieldValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }

  return value;
}

function normalizeScripCode(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeIsin(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim().toUpperCase();
  return normalized || null;
}

function resolveIsinFromMap(isinByScripCode, scripCode) {
  if (!scripCode || !isinByScripCode) {
    return null;
  }

  if (isinByScripCode instanceof Map) {
    const isin = isinByScripCode.get(scripCode);
    return normalizeIsin(isin);
  }

  if (typeof isinByScripCode === "object") {
    const isin = isinByScripCode[scripCode];
    return normalizeIsin(isin);
  }

  return null;
}

export function cleanBseAnnouncement(raw) {
  const fieldMapping = {
    NEWSID: "news_id",
    NEWSSUB: "subject",
    NEWS_BODY: "news_body",
    ATTACHMENTNAME: "attachment_file",
    SLONGNAME: "company_name",
    SCRIP_CD: "scrip_code",
    NEWS_DT: "news_date",
    DT_TM: "datetime",
    CATEGORYNAME: "category",
    SUBCATEGORYNAME: "subcategory",
    XML_NAME: "xml_name",
    PDFFLAG: "is_pdf"
  };

  const cleaned = {};

  for (const [rawField, cleanField] of Object.entries(fieldMapping)) {
    cleaned[cleanField] = normalizeFieldValue(raw?.[rawField]);
  }

  if (cleaned.attachment_file) {
    cleaned.attachment_url = `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${cleaned.attachment_file}`;
    cleaned.attachment_url_fallback = `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${cleaned.attachment_file}`;
  } else {
    cleaned.attachment_url = null;
    cleaned.attachment_url_fallback = null;
  }

  if (cleaned.news_id && cleaned.scrip_code) {
    cleaned.xml_url =
      `https://www.bseindia.com/Msource/90D/CorpXbrlGen.aspx?` +
      `Bsenewid=${encodeURIComponent(String(cleaned.news_id))}&` +
      `Scripcode=${encodeURIComponent(String(cleaned.scrip_code))}`;
  } else {
    cleaned.xml_url = null;
  }

  cleaned.isin = null;
  cleaned.scraped_at = new Date().toISOString();
  return cleaned;
}

export function deriveBseAnnouncementKey(announcement) {
  if (announcement?.news_id) {
    return String(announcement.news_id).trim();
  }

  const fallbackParts = [
    announcement?.scrip_code ?? "",
    announcement?.datetime ?? "",
    announcement?.subject ?? "",
    announcement?.attachment_file ?? ""
  ];

  const fallback = fallbackParts.join("|").trim();
  return fallback || null;
}

export function getDefaultBseDateRange(lookbackDays = 1, now = new Date()) {
  const safeLookback = Number.isFinite(lookbackDays) ? Math.max(0, lookbackDays) : 1;
  const fromDateObj = new Date(now);
  fromDateObj.setDate(fromDateObj.getDate() - safeLookback);

  return {
    fromDate: formatDateToDdMmYyyy(fromDateObj),
    toDate: formatDateToDdMmYyyy(now)
  };
}

export async function fetchBseIsinMap({
  timeoutMs = 30_000,
  segment = DEFAULT_SCRIP_MASTER_SEGMENT,
  status = DEFAULT_SCRIP_MASTER_STATUS,
  group = DEFAULT_SCRIP_MASTER_GROUP,
  scripCode = DEFAULT_SCRIP_MASTER_SCRIP_CODE
} = {}) {
  const headers = buildBrowserHeaders();
  const query = new URLSearchParams({
    segment: String(segment ?? DEFAULT_SCRIP_MASTER_SEGMENT),
    status: String(status ?? DEFAULT_SCRIP_MASTER_STATUS),
    Group: String(group ?? DEFAULT_SCRIP_MASTER_GROUP),
    Scripcode: String(scripCode ?? DEFAULT_SCRIP_MASTER_SCRIP_CODE)
  });

  const response = await fetch(`${BSE_API_URL}${BSE_SCRIP_MASTER_API_PATH}?${query}`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`BSE ISIN master fetch failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("BSE ISIN master response is not a list");
  }

  const isinByScripCode = new Map();

  for (const row of payload) {
    const normalizedScripCode = normalizeScripCode(row?.SCRIP_CD ?? row?.SCRIPCODE ?? row?.ScripCode ?? row?.scrip_code);
    if (!normalizedScripCode) {
      continue;
    }

    const normalizedIsin = normalizeIsin(row?.ISIN_NUMBER ?? row?.ISIN ?? row?.isin);
    const previous = isinByScripCode.get(normalizedScripCode);

    if (!previous || normalizedIsin) {
      isinByScripCode.set(normalizedScripCode, normalizedIsin);
    }
  }

  return isinByScripCode;
}

export function enrichBseAnnouncementsWithIsin(announcements, isinByScripCode) {
  const source = Array.isArray(announcements) ? announcements : [];
  const enriched = [];
  let withIsinCount = 0;

  for (const announcement of source) {
    const normalizedScripCode = normalizeScripCode(announcement?.scrip_code);
    const mappedIsin = resolveIsinFromMap(isinByScripCode, normalizedScripCode);
    const existingIsin = normalizeIsin(announcement?.isin);
    const isin = mappedIsin ?? existingIsin;

    if (isin) {
      withIsinCount += 1;
    }

    enriched.push({
      ...announcement,
      isin
    });
  }

  return {
    announcements: enriched,
    withIsinCount
  };
}

export async function fetchBseAnnouncements({
  fromDate,
  toDate,
  pageSize = 100,
  timeoutMs = 30_000,
  pageDelayMs = 500
}) {
  const fromDateBse = parseDdMmYyyyToYyyyMmDd(fromDate);
  const toDateBse = parseDdMmYyyyToYyyyMmDd(toDate);
  const effectivePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 100;
  const effectiveDelayMs = Number.isFinite(pageDelayMs) ? Math.max(0, Math.floor(pageDelayMs)) : 500;
  const headers = buildBrowserHeaders();

  let pageNo = 1;
  let totalPages = 1;
  const cleaned = [];

  while (pageNo <= totalPages) {
    const query = new URLSearchParams({
      strCat: DEFAULT_CATEGORY,
      strSubCat: DEFAULT_SUBCATEGORY,
      strType: DEFAULT_TYPE,
      strSearch: DEFAULT_SEARCH,
      strScrip: DEFAULT_SCRIP,
      strStartDate: fromDateBse,
      strEndDate: toDateBse,
      intPageNo: String(pageNo),
      intPageSize: String(effectivePageSize)
    });

    const response = await fetch(`${BSE_API_URL}${BSE_ANNOUNCEMENTS_API_PATH}?${query}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`BSE announcements fetch failed with status ${response.status} on page ${pageNo}`);
    }

    const payload = await response.json();
    const pageRecords = Array.isArray(payload?.Table) ? payload.Table : [];

    if (pageNo === 1) {
      const totalPageCount = Number.parseInt(String(payload?.TotalPageCnt ?? "1"), 10);
      totalPages = Number.isFinite(totalPageCount) && totalPageCount > 0 ? totalPageCount : 1;
    }

    if (pageRecords.length === 0) {
      break;
    }

    for (const rawRecord of pageRecords) {
      cleaned.push(cleanBseAnnouncement(rawRecord));
    }

    if (pageNo >= totalPages) {
      break;
    }

    pageNo += 1;
    if (effectiveDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, effectiveDelayMs));
    }
  }

  return cleaned;
}
