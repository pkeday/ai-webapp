const STORAGE_KEYS = {
  apiBase: "ai_webapp_api_base",
  priority: "brokerage_priority_companies",
  ignored: "brokerage_ignored_companies",
  recipients: "brokerage_digest_recipients",
  schedule: "brokerage_digest_schedule",
  dictionary: "brokerage_company_dictionary"
};

const defaultApiBase = "https://pkeday-ai-webapp-api.onrender.com";

const defaultDictionary = [
  {
    canonical: "Reliance Industries",
    ticker: "NSE:RIL",
    aliases: ["Reliance", "Reliance Inds", "Reliance Industries Ltd", "RIL"]
  },
  {
    canonical: "UltraTech Cement",
    ticker: "NSE:ULTRACEMCO",
    aliases: ["UltraTech", "Ultra Tech", "UTCEM", "UltraTech Cement Ltd"]
  },
  {
    canonical: "ICICI Bank",
    ticker: "NSE:ICICIBANK",
    aliases: ["ICICI", "ICICI BK", "ICICI Bank Ltd"]
  },
  {
    canonical: "Adani Ports",
    ticker: "NSE:ADANIPORTS",
    aliases: ["APSEZ", "Adani Port", "Adani Ports SEZ"]
  },
  {
    canonical: "Vodafone Idea",
    ticker: "NSE:IDEA",
    aliases: ["Voda Idea", "Vodafone", "VI"]
  }
];

const rawReports = [
  {
    id: "ax-ril-results-1902",
    broker: "Axis Capital",
    company: "Reliance Industries Ltd",
    type: "Results Update",
    coverage: "Large Cap",
    time: "2026-02-19T08:42:00+05:30",
    summary:
      "EBITDA beat is quality-led from refining mix, not pure volume uplift. FY27E EPS +3.1 percent, TP moved from 3,210 to 3,360 with Neutral retained due to rerating limits.",
    sentiment: "neutral",
    links: {
      archive: "#",
      pdf: "#",
      gmail: "#"
    }
  },
  {
    id: "ax-ultra-update-1902",
    broker: "Axis Capital",
    company: "Ultra Tech",
    type: "General Update",
    coverage: "Cement",
    time: "2026-02-19T11:25:00+05:30",
    summary:
      "Cost reset thesis is pulled forward as fuel spread narrows. Margin bridge implies FY27E EBITDA per ton +6.4 percent while capex cadence remains unchanged.",
    sentiment: "bullish",
    links: {
      archive: "#",
      pdf: "#",
      gmail: "#"
    }
  },
  {
    id: "ax-roundup-ril-repeat-1902",
    broker: "Axis Capital",
    company: "Reliance",
    type: "General Update",
    coverage: "Roundup",
    time: "2026-02-19T11:25:00+05:30",
    summary:
      "Latest releases section repeats prior Reliance result takeaways from morning note.",
    sentiment: "neutral",
    duplicateOf: "ax-ril-results-1902",
    links: {
      archive: "#",
      pdf: "#",
      gmail: "#"
    }
  },
  {
    id: "kotak-ril-init-1902",
    broker: "Kotak Institutional Equities",
    company: "RIL",
    type: "Initiation",
    coverage: "Large Cap",
    time: "2026-02-19T07:58:00+05:30",
    summary:
      "Initiates with Add on medium-term cash conversion from O2C plus new-energy option value. Bear-case explicitly stresses a weaker chemicals downcycle.",
    sentiment: "bullish",
    links: {
      archive: "#",
      pdf: "#",
      gmail: "#"
    }
  },
  {
    id: "kotak-icici-update-1902",
    broker: "Kotak Institutional Equities",
    company: "ICICI BK",
    type: "General Update",
    coverage: "BFSI",
    time: "2026-02-19T09:31:00+05:30",
    summary:
      "Liability-side repricing remains the core watch item. Estimate block is unchanged, but the note warns against assuming CASA normalization pace too early.",
    sentiment: "neutral",
    links: {
      archive: "#",
      pdf: "#",
      gmail: "#"
    }
  },
  {
    id: "jeff-ultra-results-1902",
    broker: "Jefferies India",
    company: "UltraTech",
    type: "Results Update",
    coverage: "Cement",
    time: "2026-02-19T10:14:00+05:30",
    summary:
      "Pricing realization surprise offsets freight inflation. Jefferies flags south-region volume lag as the only material variance versus broad buy-side narrative.",
    sentiment: "bullish",
    links: {
      archive: "#",
      pdf: "#",
      gmail: "#"
    }
  },
  {
    id: "jeff-sector-pack-1902",
    broker: "Jefferies India",
    company: "Reliance",
    type: "Sector Update",
    coverage: "Sector Packet",
    time: "2026-02-19T10:20:00+05:30",
    summary:
      "Weekly packet carries a compact Reliance mention that repeats prior-day framing and is not treated as a new canonical event.",
    sentiment: "neutral",
    duplicateOf: "kotak-ril-init-1902",
    links: {
      archive: "#",
      pdf: "#",
      gmail: "#"
    }
  },
  {
    id: "jeff-adani-update-1902",
    broker: "Jefferies India",
    company: "Adani Ports",
    type: "General Update",
    coverage: "Logistics",
    time: "2026-02-19T09:50:00+05:30",
    summary:
      "Container throughput view revised modestly higher, but valuation premium remains difficult to defend against execution volatility in adjacent assets.",
    sentiment: "neutral",
    links: {
      archive: "#",
      pdf: "#",
      gmail: "#"
    }
  },
  {
    id: "ax-vi-quick-1902",
    broker: "Axis Capital",
    company: "Voda Idea",
    type: "General Update",
    coverage: "Telecom",
    time: "2026-02-19T08:10:00+05:30",
    summary:
      "Tariff commentary remains speculative and unsupported by immediate balance sheet flexibility. Monitoring only.",
    sentiment: "bearish",
    links: {
      archive: "#",
      pdf: "#",
      gmail: "#"
    }
  }
];

const state = {
  view: "dashboard",
  apiBase: loadString(STORAGE_KEYS.apiBase, defaultApiBase),
  priorityCompanies: loadList(STORAGE_KEYS.priority, ["Reliance Industries", "UltraTech Cement", "ICICI Bank"]),
  ignoredCompanies: loadList(STORAGE_KEYS.ignored, ["Adani Ports", "Vodafone Idea"]),
  digestRecipients: loadList(STORAGE_KEYS.recipients, ["pkeday@gmail.com"]),
  digestSchedule: loadString(STORAGE_KEYS.schedule, "Daily 07:30 IST"),
  dictionary: loadDictionary(),
  filters: {
    broker: "All",
    type: "All",
    search: "",
    includeDuplicates: false
  },
  companyView: {
    selected: "Reliance Industries",
    sort: "latest"
  },
  pipelineMessage: ""
};

const refs = {
  backendStatus: document.getElementById("backend-status"),
  pipelineStatus: document.getElementById("pipeline-status"),
  tabButtons: Array.from(document.querySelectorAll(".tab")),
  views: {
    dashboard: document.getElementById("view-dashboard"),
    company: document.getElementById("view-company"),
    settings: document.getElementById("view-settings"),
    digest: document.getElementById("view-digest")
  },
  filterBroker: document.getElementById("filter-broker"),
  filterType: document.getElementById("filter-type"),
  filterSearch: document.getElementById("filter-search"),
  filterDuplicates: document.getElementById("filter-duplicates"),
  chipRow: document.getElementById("control-chip-row"),
  kpiGrid: document.getElementById("kpi-grid"),
  brokerLanes: document.getElementById("broker-lanes"),
  companySelect: document.getElementById("company-select"),
  companySort: document.getElementById("company-sort"),
  companyTimeline: document.getElementById("company-timeline"),
  companyWorkbench: document.getElementById("company-workbench"),
  dictionaryTable: document.getElementById("dictionary-table"),
  priorityList: document.getElementById("priority-list"),
  ignoreList: document.getElementById("ignore-list"),
  recipientList: document.getElementById("recipient-list"),
  scheduleInput: document.getElementById("schedule-input"),
  digestPreview: document.getElementById("digest-preview"),
  dictionaryForm: document.getElementById("dictionary-form"),
  dictionaryCanonical: document.getElementById("dictionary-canonical"),
  dictionaryTicker: document.getElementById("dictionary-ticker"),
  dictionaryAliases: document.getElementById("dictionary-aliases"),
  priorityForm: document.getElementById("priority-form"),
  priorityInput: document.getElementById("priority-input"),
  ignoreForm: document.getElementById("ignore-form"),
  ignoreInput: document.getElementById("ignore-input"),
  recipientForm: document.getElementById("recipient-form"),
  recipientInput: document.getElementById("recipient-input"),
  scheduleSaveBtn: document.getElementById("schedule-save-btn"),
  sendDigestBtn: document.getElementById("send-digest-btn"),
  runIngestBtn: document.getElementById("run-ingest-btn"),
  googleConnectBtn: document.getElementById("google-connect-btn")
};

init();

function init() {
  hydrateBrokerFilter();
  hydrateCompanySelect();
  bindEvents();
  renderAll();
  checkBackendStatus();
}

function bindEvents() {
  for (const button of refs.tabButtons) {
    button.addEventListener("click", () => {
      const view = button.dataset.view;
      if (view) {
        state.view = view;
        renderViewState();
      }
    });
  }

  refs.filterBroker.addEventListener("change", (event) => {
    state.filters.broker = event.target.value;
    renderDashboard();
  });

  refs.filterType.addEventListener("change", (event) => {
    state.filters.type = event.target.value;
    renderDashboard();
  });

  refs.filterSearch.addEventListener("input", (event) => {
    state.filters.search = event.target.value.trim();
    renderDashboard();
  });

  refs.filterDuplicates.addEventListener("change", (event) => {
    state.filters.includeDuplicates = event.target.checked;
    renderDashboard();
  });

  refs.companySelect.addEventListener("change", (event) => {
    state.companyView.selected = event.target.value;
    renderCompanyView();
  });

  refs.companySort.addEventListener("change", (event) => {
    state.companyView.sort = event.target.value;
    renderCompanyView();
  });

  refs.dictionaryForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const canonical = refs.dictionaryCanonical.value.trim();
    const ticker = refs.dictionaryTicker.value.trim();
    const aliases = refs.dictionaryAliases.value
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (!canonical || !ticker || aliases.length === 0) {
      return;
    }

    state.dictionary.push({ canonical, ticker, aliases });
    persistDictionary();
    refs.dictionaryForm.reset();
    refreshAfterDictionaryChange();
    setPipelineMessage("Added dictionary mapping and refreshed company normalization.");
  });

  refs.priorityForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addCompanyToList("priority", refs.priorityInput.value);
    refs.priorityForm.reset();
  });

  refs.ignoreForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addCompanyToList("ignore", refs.ignoreInput.value);
    refs.ignoreForm.reset();
  });

  refs.recipientForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = refs.recipientInput.value.trim().toLowerCase();
    if (!email || state.digestRecipients.includes(email)) {
      return;
    }
    state.digestRecipients.push(email);
    persistList(STORAGE_KEYS.recipients, state.digestRecipients);
    renderSettings();
    renderDigest();
  });

  refs.scheduleSaveBtn.addEventListener("click", () => {
    state.digestSchedule = refs.scheduleInput.value.trim() || "Daily 07:30 IST";
    localStorage.setItem(STORAGE_KEYS.schedule, state.digestSchedule);
    renderDigest();
    setPipelineMessage("Digest schedule saved.");
  });

  refs.sendDigestBtn.addEventListener("click", () => {
    state.view = "digest";
    renderViewState();
    setPipelineMessage("Digest preview is ready. Backend mail sending is the next step.");
  });

  refs.runIngestBtn.addEventListener("click", () => {
    setPipelineMessage("Ingest trigger UI is ready. Gmail pipeline will be connected in backend phase.");
  });

  refs.googleConnectBtn.addEventListener("click", () => {
    setPipelineMessage("Google OAuth screen will be wired in the next backend/auth phase.");
  });

  refs.priorityList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-company]");
    if (!button) {
      return;
    }
    state.priorityCompanies = state.priorityCompanies.filter((value) => value !== button.dataset.company);
    persistList(STORAGE_KEYS.priority, state.priorityCompanies);
    renderDashboard();
    renderSettings();
    renderDigest();
  });

  refs.ignoreList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-company]");
    if (!button) {
      return;
    }
    state.ignoredCompanies = state.ignoredCompanies.filter((value) => value !== button.dataset.company);
    persistList(STORAGE_KEYS.ignored, state.ignoredCompanies);
    renderDashboard();
    renderSettings();
    renderCompanyView();
    renderDigest();
  });

  refs.recipientList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-recipient]");
    if (!button) {
      return;
    }
    state.digestRecipients = state.digestRecipients.filter((value) => value !== button.dataset.recipient);
    persistList(STORAGE_KEYS.recipients, state.digestRecipients);
    renderSettings();
    renderDigest();
  });
}

function renderAll() {
  renderViewState();
  renderDashboard();
  renderCompanyView();
  renderSettings();
  renderDigest();
  refs.scheduleInput.value = state.digestSchedule;
}

function renderViewState() {
  for (const [viewName, element] of Object.entries(refs.views)) {
    element.classList.toggle("active", viewName === state.view);
  }

  for (const button of refs.tabButtons) {
    button.classList.toggle("active", button.dataset.view === state.view);
  }
}

function renderDashboard() {
  const allReports = buildReports();
  const canonicalReports = allReports.filter((report) => !report.duplicateOf);
  const duplicateCount = allReports.length - canonicalReports.length;

  const visibleReports = allReports.filter((report) => {
    if (!state.filters.includeDuplicates && report.duplicateOf) {
      return false;
    }

    if (state.ignoredCompanies.includes(report.canonicalCompany)) {
      return false;
    }

    if (state.filters.broker !== "All" && report.broker !== state.filters.broker) {
      return false;
    }

    if (state.filters.type !== "All" && report.type !== state.filters.type) {
      return false;
    }

    if (state.filters.search) {
      const query = state.filters.search.toLowerCase();
      const haystack = `${report.canonicalCompany} ${report.summary}`.toLowerCase();
      if (!haystack.includes(query)) {
        return false;
      }
    }

    return true;
  });

  const priorityHitCount = canonicalReports.filter((report) => state.priorityCompanies.includes(report.canonicalCompany)).length;

  refs.chipRow.innerHTML = `
    ${state.priorityCompanies
      .map((company) => `<span class="chip priority">Priority: ${escapeHtml(company)}</span>`)
      .join("")}
    ${state.ignoredCompanies.map((company) => `<span class="chip ignore">Ignored: ${escapeHtml(company)}</span>`).join("")}
  `;

  refs.kpiGrid.innerHTML = `
    <article class="kpi">
      <h4>Raw Reports</h4>
      <p>${allReports.length}</p>
      <small>input emails and packet snippets</small>
    </article>
    <article class="kpi">
      <h4>Canonical Reports</h4>
      <p>${canonicalReports.length}</p>
      <small>dedupe primary events only</small>
    </article>
    <article class="kpi">
      <h4>Collapsed Duplicates</h4>
      <p>${duplicateCount}</p>
      <small>roundup repeats removed</small>
    </article>
    <article class="kpi">
      <h4>Priority Hits</h4>
      <p>${priorityHitCount}</p>
      <small>used first in digest ordering</small>
    </article>
  `;

  const grouped = groupBy(visibleReports, "broker");
  const brokers = Object.keys(grouped).sort();

  if (brokers.length === 0) {
    refs.brokerLanes.innerHTML = `<div class="empty-state">No reports match the selected filters.</div>`;
    return;
  }

  refs.brokerLanes.innerHTML = brokers
    .map((broker, index) => {
      const cards = grouped[broker]
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((report) => renderReportCard(report))
        .join("");

      return `
        <section class="lane broker-${(index % 3) + 1}">
          <header>${escapeHtml(broker)} · Distinct Broker Lane</header>
          <div class="lane-body">${cards}</div>
        </section>
      `;
    })
    .join("");
}

function renderReportCard(report) {
  const duplicateTag = report.duplicateOf ? `<span class="tag duplicate">Duplicate snippet</span>` : "";

  return `
    <article class="report-card">
      <h3>${escapeHtml(report.canonicalCompany)} · ${escapeHtml(report.type)}</h3>
      <div class="meta-tags">
        <span class="tag ${tagClassForType(report.type)}">${escapeHtml(report.type)}</span>
        <span class="tag">${escapeHtml(report.coverage)}</span>
        <span class="tag">${formatTime(report.time)}</span>
        ${duplicateTag}
      </div>
      <p class="summary">${escapeHtml(report.summary)}</p>
      <div class="card-actions">
        <a class="link-btn" href="${escapeAttribute(report.links.archive)}">Open archived .eml</a>
        <a class="link-btn" href="${escapeAttribute(report.links.pdf)}">Open attachment PDF</a>
        <a class="link-btn" href="${escapeAttribute(report.links.gmail)}">Open Gmail thread</a>
      </div>
    </article>
  `;
}

function renderCompanyView() {
  const reports = buildReports().filter(
    (report) => report.canonicalCompany === state.companyView.selected && !state.ignoredCompanies.includes(report.canonicalCompany)
  );

  let sorted = reports;
  if (state.companyView.sort === "latest") {
    sorted = [...reports].sort((a, b) => b.timestamp - a.timestamp);
  } else {
    sorted = [...reports].sort((a, b) => a.broker.localeCompare(b.broker));
  }

  if (sorted.length === 0) {
    refs.companyTimeline.innerHTML = `<div class="empty-state">No visible reports for this company after filters.</div>`;
  } else {
    refs.companyTimeline.innerHTML = sorted
      .map(
        (report) => `
          <article class="item">
            <h3>${escapeHtml(report.broker)} · ${escapeHtml(report.type)} · ${formatShortDate(report.time)}</h3>
            <div class="meta-tags">
              <span class="tag ${tagClassForType(report.type)}">${escapeHtml(report.type)}</span>
              <span class="tag">${report.duplicateOf ? "Duplicate Reference" : "Canonical"}</span>
            </div>
            <p class="summary">${escapeHtml(report.summary)}</p>
            <div class="card-actions">
              <a class="link-btn" href="${escapeAttribute(report.links.archive)}">Open archived .eml</a>
              <a class="link-btn" href="${escapeAttribute(report.links.pdf)}">Open PDF</a>
            </div>
          </article>
        `
      )
      .join("");
  }

  const canonical = reports.filter((report) => !report.duplicateOf);
  const duplicates = reports.filter((report) => report.duplicateOf);
  const sentiment = {
    bullish: canonical.filter((report) => report.sentiment === "bullish").length,
    neutral: canonical.filter((report) => report.sentiment === "neutral").length,
    bearish: canonical.filter((report) => report.sentiment === "bearish").length
  };

  refs.companyWorkbench.innerHTML = `
    <div class="workbench-list">
      <div class="note good"><strong>Signal map:</strong> ${sentiment.bullish} bullish, ${sentiment.neutral} neutral, ${sentiment.bearish} bearish (canonical only).</div>
      <div class="note"><strong>Canonical references:</strong> ${canonical.length}<br /><strong>Collapsed duplicates:</strong> ${duplicates.length}</div>
      <div class="note"><strong>Priority status:</strong> ${state.priorityCompanies.includes(state.companyView.selected) ? "In priority list" : "Not in priority list"}</div>
      <div class="note warn"><strong>Broker separation:</strong> all summaries stay broker-native. No merged thesis text across houses.</div>
      <div class="note"><strong>Source access model:</strong> archived .eml and PDFs can be shared without Gmail login access.</div>
    </div>
  `;
}

function renderSettings() {
  refs.dictionaryTable.innerHTML = state.dictionary
    .map(
      (entry) => `
        <tr>
          <td>${escapeHtml(entry.canonical)}</td>
          <td>${escapeHtml(entry.ticker)}</td>
          <td>${escapeHtml(entry.aliases.join(", "))}</td>
          <td><span class="tag">Mapped</span></td>
        </tr>
      `
    )
    .join("");

  refs.priorityList.innerHTML = renderRemovableChipList(state.priorityCompanies, "priority", "data-company");
  refs.ignoreList.innerHTML = renderRemovableChipList(state.ignoredCompanies, "ignore", "data-company");
  refs.recipientList.innerHTML = renderRemovableChipList(state.digestRecipients, "", "data-recipient");
  refs.scheduleInput.value = state.digestSchedule;
}

function renderDigest() {
  const reports = buildReports()
    .filter((report) => !report.duplicateOf)
    .filter((report) => !state.ignoredCompanies.includes(report.canonicalCompany));

  const priorityOrder = state.priorityCompanies
    .map((company) => {
      const count = reports.filter((report) => report.canonicalCompany === company).length;
      return { company, count };
    })
    .filter((entry) => entry.count > 0);

  const byBroker = groupBy(reports, "broker");
  const duplicateCount = buildReports().filter((report) => report.duplicateOf).length;

  refs.digestPreview.innerHTML = `
    <div class="digest-block">
      <h3>Delivery Target</h3>
      <p><strong>Recipients:</strong> ${escapeHtml(state.digestRecipients.join(", ") || "none")}</p>
      <p><strong>Schedule:</strong> ${escapeHtml(state.digestSchedule)}</p>
    </div>

    <div class="digest-block">
      <h3>Priority Queue First</h3>
      <p>${
        priorityOrder.length > 0
          ? priorityOrder.map((entry) => `${escapeHtml(entry.company)} (${entry.count})`).join(" -> ")
          : "No priority companies in the current report set."
      }</p>
    </div>

    ${Object.keys(byBroker)
      .sort()
      .map((broker) => {
        const list = byBroker[broker]
          .sort((a, b) => b.timestamp - a.timestamp)
          .map(
            (report) =>
              `<li><strong>${escapeHtml(report.canonicalCompany)} · ${escapeHtml(report.type)}:</strong> ${escapeHtml(report.summary)}</li>`
          )
          .join("");

        return `
          <div class="digest-block">
            <h3>${escapeHtml(broker)}</h3>
            <ul class="digest-list">${list}</ul>
          </div>
        `;
      })
      .join("")}

    <div class="digest-block">
      <h3>Dedupe Audit</h3>
      <p>${duplicateCount} duplicate snippets are suppressed from the canonical digest construction.</p>
    </div>

    ${state.pipelineMessage ? `<div class="message-toast">${escapeHtml(state.pipelineMessage)}</div>` : ""}
  `;
}

function hydrateBrokerFilter() {
  const brokers = Array.from(new Set(buildReports().map((report) => report.broker))).sort();
  refs.filterBroker.innerHTML = [`<option value="All">All</option>`, ...brokers.map((broker) => `<option>${escapeHtml(broker)}</option>`)].join("");
}

function hydrateCompanySelect() {
  const companies = Array.from(new Set(buildReports().map((report) => report.canonicalCompany))).sort();
  refs.companySelect.innerHTML = companies.map((company) => `<option value="${escapeAttribute(company)}">${escapeHtml(company)}</option>`).join("");

  if (!companies.includes(state.companyView.selected)) {
    state.companyView.selected = companies[0] || "";
  }

  refs.companySelect.value = state.companyView.selected;
}

function buildReports() {
  const aliasLookup = new Map();
  for (const entry of state.dictionary) {
    aliasLookup.set(normalizeKey(entry.canonical), entry.canonical);
    for (const alias of entry.aliases) {
      aliasLookup.set(normalizeKey(alias), entry.canonical);
    }
  }

  return rawReports.map((report) => {
    const normalized = aliasLookup.get(normalizeKey(report.company)) ?? report.company;

    return {
      ...report,
      canonicalCompany: normalized,
      duplicateOf: report.duplicateOf ?? null,
      timestamp: new Date(report.time).getTime()
    };
  });
}

function refreshAfterDictionaryChange() {
  persistDictionary();
  hydrateBrokerFilter();
  hydrateCompanySelect();
  renderDashboard();
  renderCompanyView();
  renderSettings();
  renderDigest();
}

async function checkBackendStatus() {
  refs.backendStatus.textContent = "Backend status: checking...";

  try {
    const response = await fetch(`${state.apiBase.replace(/\/$/, "")}/api/health`);
    if (!response.ok) {
      refs.backendStatus.textContent = `Backend status: failed (HTTP ${response.status})`;
      return;
    }

    const data = await response.json();
    refs.backendStatus.textContent = `Backend status: connected (${data.env})`;
  } catch {
    refs.backendStatus.textContent = "Backend status: unreachable";
  }
}

function addCompanyToList(kind, rawCompany) {
  const normalized = normalizeCompanyName(rawCompany);
  if (!normalized) {
    return;
  }

  if (kind === "priority") {
    if (!state.priorityCompanies.includes(normalized)) {
      state.priorityCompanies.push(normalized);
      persistList(STORAGE_KEYS.priority, state.priorityCompanies);
    }
  } else {
    if (!state.ignoredCompanies.includes(normalized)) {
      state.ignoredCompanies.push(normalized);
      persistList(STORAGE_KEYS.ignored, state.ignoredCompanies);
    }
  }

  renderDashboard();
  renderCompanyView();
  renderSettings();
  renderDigest();
}

function normalizeCompanyName(input) {
  const value = input.trim();
  if (!value) {
    return "";
  }

  const key = normalizeKey(value);
  for (const entry of state.dictionary) {
    if (normalizeKey(entry.canonical) === key) {
      return entry.canonical;
    }

    if (entry.aliases.some((alias) => normalizeKey(alias) === key)) {
      return entry.canonical;
    }
  }

  return value;
}

function renderRemovableChipList(values, extraClass, attrName) {
  if (values.length === 0) {
    return `<span class="chip">None</span>`;
  }

  return values
    .map(
      (value) =>
        `<span class="chip ${extraClass}">${escapeHtml(value)} <button class="remove" ${attrName}="${escapeAttribute(value)}" type="button">x</button></span>`
    )
    .join("");
}

function setPipelineMessage(message) {
  state.pipelineMessage = message;
  refs.pipelineStatus.textContent = `Pipeline status: ${message}`;
  renderDigest();
}

function groupBy(items, field) {
  return items.reduce((acc, item) => {
    const key = item[field];
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(item);
    return acc;
  }, {});
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatShortDate(value) {
  return new Date(value).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

function tagClassForType(type) {
  return `type-${type.toLowerCase().replace(/\s+/g, "-")}`;
}

function normalizeKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function loadList(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    if (!value) {
      return [...fallback];
    }

    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [...fallback];
    }

    return parsed.filter((item) => typeof item === "string" && item.trim());
  } catch {
    return [...fallback];
  }
}

function persistList(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function loadString(key, fallback) {
  const value = localStorage.getItem(key);
  return value && value.trim() ? value : fallback;
}

function loadDictionary() {
  try {
    const value = localStorage.getItem(STORAGE_KEYS.dictionary);
    if (!value) {
      return [...defaultDictionary];
    }

    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [...defaultDictionary];
    }

    return parsed
      .filter((entry) => entry && typeof entry.canonical === "string" && typeof entry.ticker === "string")
      .map((entry) => ({
        canonical: entry.canonical,
        ticker: entry.ticker,
        aliases: Array.isArray(entry.aliases)
          ? entry.aliases.filter((alias) => typeof alias === "string" && alias.trim())
          : []
      }));
  } catch {
    return [...defaultDictionary];
  }
}

function persistDictionary() {
  localStorage.setItem(STORAGE_KEYS.dictionary, JSON.stringify(state.dictionary));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "");
}
