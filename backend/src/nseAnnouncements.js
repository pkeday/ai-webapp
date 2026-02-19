const NSE_BASE_URL = "https://www.nseindia.com";
const ANNOUNCEMENTS_API_PATH = "/api/corporate-announcements";

function buildBrowserHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: `${NSE_BASE_URL}/`,
    Connection: "keep-alive"
  };
}

function formatNseDate(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

function extractCookieHeader(response) {
  const getSetCookie = response.headers.getSetCookie;
  if (typeof getSetCookie === "function") {
    const cookieEntries = getSetCookie.call(response.headers);
    if (Array.isArray(cookieEntries) && cookieEntries.length > 0) {
      return cookieEntries
        .map((entry) => entry.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
    }
  }

  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    return "";
  }

  return setCookie
    .split(/,(?=[^;,\s]+=)/)
    .map((entry) => entry.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function firstDefined(raw, keys) {
  for (const key of keys) {
    const value = raw?.[key];
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

export function cleanAnnouncement(raw) {
  const fieldMap = {
    symbol: ["symbol"],
    desc: ["desc"],
    dt: ["dt"],
    an_dt: ["an_dt"],
    sm_name: ["sm_name", "smName"],
    sm_isin: ["sm_isin", "smIsin"],
    smindustry: ["smindustry", "smIndustry"],
    seq_id: ["seq_id", "seqId"],
    attchmntfile: ["attchmntfile", "attchmntFile"],
    attchmnttext: ["attchmnttext", "attchmntText"],
    exchdisstime: ["exchdisstime", "exchDisstime"],
    difference: ["difference"],
    filesize: ["filesize", "fileSize"]
  };

  const cleaned = {};

  for (const [field, sourceKeys] of Object.entries(fieldMap)) {
    const value = firstDefined(raw, sourceKeys);
    if (value === null) {
      cleaned[field] = null;
      continue;
    }

    if (typeof value === "string") {
      cleaned[field] = value.trim();
      continue;
    }

    cleaned[field] = value;
  }

  return cleaned;
}

export function deriveAnnouncementKey(announcement) {
  if (announcement?.seq_id) {
    return String(announcement.seq_id).trim();
  }

  const fallbackParts = [
    announcement?.symbol ?? "",
    announcement?.an_dt ?? "",
    announcement?.dt ?? "",
    announcement?.desc ?? "",
    announcement?.attchmntfile ?? ""
  ];

  const fallback = fallbackParts.join("|").trim();
  return fallback || null;
}

export function getDefaultDateRange(lookbackDays = 1, now = new Date()) {
  const safeLookback = Number.isFinite(lookbackDays) ? Math.max(0, lookbackDays) : 1;
  const fromDateObj = new Date(now);
  fromDateObj.setDate(fromDateObj.getDate() - safeLookback);

  return {
    fromDate: formatNseDate(fromDateObj),
    toDate: formatNseDate(now)
  };
}

export async function fetchNseAnnouncements({
  fromDate,
  toDate,
  index = "equities",
  timeoutMs = 30_000
}) {
  const headers = buildBrowserHeaders();
  const query = new URLSearchParams({
    index,
    from_date: fromDate,
    to_date: toDate
  });
  const apiUrl = `${NSE_BASE_URL}${ANNOUNCEMENTS_API_PATH}?${query}`;

  // Try direct API first. In some environments, NSE blocks homepage bootstrap but allows API.
  const directResponse = await fetch(apiUrl, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (directResponse.ok) {
    const payload = await directResponse.json();
    if (!Array.isArray(payload)) {
      throw new Error("NSE announcements response is not a list");
    }
    return payload.map((item) => cleanAnnouncement(item));
  }

  const homeResponse = await fetch(NSE_BASE_URL, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!homeResponse.ok) {
    throw new Error(
      `NSE announcements direct request failed with status ${directResponse.status}; ` +
        `session bootstrap failed with status ${homeResponse.status}`
    );
  }

  const cookieHeader = extractCookieHeader(homeResponse);
  if (!cookieHeader) {
    throw new Error(`NSE announcements direct request failed with status ${directResponse.status}; no cookies from bootstrap`);
  }

  const cookieResponse = await fetch(apiUrl, {
    method: "GET",
    headers: {
      ...headers,
      Cookie: cookieHeader
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!cookieResponse.ok) {
    throw new Error(
      `NSE announcements fetch failed with status ${cookieResponse.status} ` +
        `(direct status was ${directResponse.status})`
    );
  }

  const payload = await cookieResponse.json();
  if (!Array.isArray(payload)) {
    throw new Error("NSE announcements response is not a list");
  }

  return payload.map((item) => cleanAnnouncement(item));
}
