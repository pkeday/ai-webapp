const STORAGE_KEYS = {
  apiBase: "ai_webapp_api_base",
  authToken: "brokerage_auth_token",
  priority: "brokerage_priority_companies",
  ignored: "brokerage_ignored_companies",
  recipients: "brokerage_digest_recipients",
  schedule: "brokerage_digest_schedule",
  dictionary: "brokerage_company_dictionary"
};

const defaultApiBase = "https://pkeday-ai-webapp-brokerage-api.onrender.com";

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

const seedReports = [
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
    summary: "Latest releases section repeats prior Reliance result takeaways from morning note.",
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
  }
];

const state = {
  view: "dashboard",
  apiBase: loadString(STORAGE_KEYS.apiBase, defaultApiBase),
  auth: {
    token: loadString(STORAGE_KEYS.authToken, ""),
    user: null,
    gmailConnected: false,
    loading: false
  },
  archives: {
    items: [],
    brokerFilter: "All",
    search: "",
    fetchedAt: null,
    total: 0
  },
  notifications: {
    items: [],
    total: 0,
    limit: 50,
    symbol: "",
    loading: false,
    error: "",
    lastSyncAt: null,
    lastSyncStats: null
  },
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
  authStatus: document.getElementById("auth-status"),
  pipelineStatus: document.getElementById("pipeline-status"),
  tabButtons: Array.from(document.querySelectorAll(".tab")),
  views: {
    dashboard: document.getElementById("view-dashboard"),
    archive: document.getElementById("view-archive"),
    company: document.getElementById("view-company"),
    notifications: document.getElementById("view-notifications"),
    settings: document.getElementById("view-settings"),
    digest: document.getElementById("view-digest")
  },
  googleConnectBtn: document.getElementById("google-connect-btn"),
  signoutBtn: document.getElementById("signout-btn"),
  runIngestBtn: document.getElementById("run-ingest-btn"),
  sendDigestBtn: document.getElementById("send-digest-btn"),
  filterBroker: document.getElementById("filter-broker"),
  filterType: document.getElementById("filter-type"),
  filterSearch: document.getElementById("filter-search"),
  filterDuplicates: document.getElementById("filter-duplicates"),
  chipRow: document.getElementById("control-chip-row"),
  kpiGrid: document.getElementById("kpi-grid"),
  brokerLanes: document.getElementById("broker-lanes"),
  archiveBrokerFilter: document.getElementById("archive-broker-filter"),
  archiveSearch: document.getElementById("archive-search"),
  archiveRefreshBtn: document.getElementById("archive-refresh-btn"),
  archiveSummary: document.getElementById("archive-summary"),
  archiveTable: document.getElementById("archive-table"),
  notificationsSymbolInput: document.getElementById("notifications-symbol-input"),
  notificationsLimitSelect: document.getElementById("notifications-limit-select"),
  notificationsRefreshBtn: document.getElementById("notifications-refresh-btn"),
  notificationsMeta: document.getElementById("notifications-meta"),
  notificationsTable: document.getElementById("notifications-table"),
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
  scheduleSaveBtn: document.getElementById("schedule-save-btn")
};

init();

async function init() {
  handleAuthCallbackFromHash();
  hydrateBrokerFilter();
  hydrateCompanySelect();
  bindEvents();
  renderAll();
  await Promise.all([checkBackendStatus(), refreshAuthState()]);
  await fetchNotifications();
}

function bindEvents() {
  for (const button of refs.tabButtons) {
    button.addEventListener("click", () => {
      const view = button.dataset.view;
      if (!view) {
        return;
      }
      state.view = view;
      renderViewState();

      if (view === "notifications" && state.notifications.items.length === 0 && !state.notifications.loading) {
        void fetchNotifications();
      }
    });
  }

  refs.googleConnectBtn.addEventListener("click", async () => {
    await startGoogleAuth();
  });

  refs.signoutBtn.addEventListener("click", async () => {
    await signOut();
  });

  refs.runIngestBtn.addEventListener("click", async () => {
    if (!state.auth.token) {
      setPipelineMessage("Sign in with Google before running ingest.");
      return;
    }

    refs.runIngestBtn.disabled = true;
    setPipelineMessage("Running Gmail ingest...");

    try {
      const response = await apiFetch("/api/gmail/ingest", {
        method: "POST",
        body: JSON.stringify({
          maxResults: 30,
          includeAttachments: true
        })
      });

      const summary = response.summary;
      setPipelineMessage(
        `Ingest complete: archived ${summary.archivedCount}, skipped ${summary.skippedCount}, attachments ${summary.attachmentCount}.`
      );
      await fetchArchives();
      renderAllDataViews();
    } catch (error) {
      setPipelineMessage(`Ingest failed: ${error.message}`);
    } finally {
      refs.runIngestBtn.disabled = false;
    }
  });

  refs.sendDigestBtn.addEventListener("click", () => {
    state.view = "digest";
    renderViewState();
    setPipelineMessage("Digest preview is ready. Email sending pipeline is next.");
  });

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

  refs.archiveBrokerFilter.addEventListener("change", (event) => {
    state.archives.brokerFilter = event.target.value;
    renderArchiveView();
  });

  refs.archiveSearch.addEventListener("input", (event) => {
    state.archives.search = event.target.value.trim().toLowerCase();
    renderArchiveView();
  });

  refs.archiveRefreshBtn.addEventListener("click", async () => {
    await fetchArchives();
    renderArchiveView();
  });

  refs.notificationsRefreshBtn.addEventListener("click", async () => {
    await fetchNotifications();
  });

  refs.notificationsLimitSelect.addEventListener("change", async () => {
    await fetchNotifications();
  });

  refs.notificationsSymbolInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    await fetchNotifications();
  });

  refs.archiveTable.addEventListener("click", async (event) => {
    const shareButton = event.target.closest("button[data-share-archive]");
    if (!shareButton) {
      return;
    }

    const archiveId = shareButton.dataset.shareArchive;
    if (!archiveId) {
      return;
    }

    shareButton.disabled = true;
    try {
      const response = await apiFetch(`/api/email-archives/${archiveId}/share-links`, {
        method: "POST",
        body: JSON.stringify({ expiresHours: 24 })
      });

      const link = response.raw?.url;
      if (link) {
        await copyToClipboard(link);
        setPipelineMessage(`Share link copied for archive ${archiveId}.`);
      } else {
        setPipelineMessage(`Share link generated for archive ${archiveId}.`);
      }
    } catch (error) {
      setPipelineMessage(`Failed to create share link: ${error.message}`);
    } finally {
      shareButton.disabled = false;
    }
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

  refs.priorityList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-company]");
    if (!button) {
      return;
    }

    state.priorityCompanies = state.priorityCompanies.filter((value) => value !== button.dataset.company);
    persistList(STORAGE_KEYS.priority, state.priorityCompanies);
    renderAllDataViews();
  });

  refs.ignoreList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-company]");
    if (!button) {
      return;
    }

    state.ignoredCompanies = state.ignoredCompanies.filter((value) => value !== button.dataset.company);
    persistList(STORAGE_KEYS.ignored, state.ignoredCompanies);
    renderAllDataViews();
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
  renderAuthUi();
  renderAllDataViews();
}

function renderAllDataViews() {
  renderDashboard();
  renderArchiveView();
  renderCompanyView();
  renderNotifications();
  renderSettings();
  renderDigest();
}

function renderViewState() {
  for (const [viewName, element] of Object.entries(refs.views)) {
    element.classList.toggle("active", viewName === state.view);
  }

  for (const button of refs.tabButtons) {
    button.classList.toggle("active", button.dataset.view === state.view);
  }
}

function renderAuthUi() {
  const signedIn = Boolean(state.auth.token && state.auth.user);

  if (!signedIn) {
    refs.authStatus.textContent = "Auth status: not signed in";
    refs.googleConnectBtn.textContent = "Sign in with Google";
    refs.signoutBtn.classList.add("hidden");
    refs.runIngestBtn.disabled = true;
    return;
  }

  const gmailPart = state.auth.gmailConnected ? "Gmail connected" : "Gmail not connected";
  refs.authStatus.textContent = `Auth status: ${state.auth.user.email} (${gmailPart})`;
  refs.googleConnectBtn.textContent = state.auth.gmailConnected ? "Reconnect Google" : "Connect Gmail";
  refs.signoutBtn.classList.remove("hidden");
  refs.runIngestBtn.disabled = false;
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
      <small>seed + ingested archive</small>
    </article>
    <article class="kpi">
      <h4>Canonical Reports</h4>
      <p>${canonicalReports.length}</p>
      <small>dedupe primary events</small>
    </article>
    <article class="kpi">
      <h4>Collapsed Duplicates</h4>
      <p>${duplicateCount}</p>
      <small>roundup repeats removed</small>
    </article>
    <article class="kpi">
      <h4>Priority Hits</h4>
      <p>${priorityHitCount}</p>
      <small>ranked first in digest</small>
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
        <a class="link-btn" href="${escapeAttribute(report.links.archive)}" target="_blank" rel="noopener">Open archived .eml</a>
        <a class="link-btn" href="${escapeAttribute(report.links.pdf)}" target="_blank" rel="noopener">Open attachment PDF</a>
        <a class="link-btn" href="${escapeAttribute(report.links.gmail)}" target="_blank" rel="noopener">Open Gmail thread</a>
      </div>
    </article>
  `;
}

function renderArchiveView() {
  const records = getVisibleArchives();

  const brokers = Array.from(new Set(state.archives.items.map((item) => item.broker))).sort();
  refs.archiveBrokerFilter.innerHTML = [
    `<option value="All">All</option>`,
    ...brokers.map((broker) => `<option value="${escapeAttribute(broker)}">${escapeHtml(broker)}</option>`)
  ].join("");
  refs.archiveBrokerFilter.value = state.archives.brokerFilter;

  const fetchedText = state.archives.fetchedAt ? new Date(state.archives.fetchedAt).toLocaleString() : "not fetched yet";
  refs.archiveSummary.innerHTML = `<strong>${records.length}</strong> visible archives (${state.archives.total} total loaded). Last fetch: ${escapeHtml(fetchedText)}.`;

  if (records.length === 0) {
    refs.archiveTable.innerHTML =
      '<tr><td colspan="5"><div class="empty-state">No archived emails yet. Sign in and run ingest to populate this table.</div></td></tr>';
    return;
  }

  refs.archiveTable.innerHTML = records
    .map((item) => {
      const attachments = item.attachments
        .slice(0, 2)
        .map(
          (attachment) =>
            `<a class="link-btn" href="${escapeAttribute(toApiAbsolute(attachment.downloadUrl))}" target="_blank" rel="noopener">${escapeHtml(
              attachment.filename
            )}</a>`
        )
        .join("");

      return `
        <tr>
          <td>${escapeHtml(formatShortDate(item.ingestedAt))}</td>
          <td>${escapeHtml(item.broker)}</td>
          <td>${escapeHtml(item.from)}</td>
          <td>
            <strong>${escapeHtml(item.subject)}</strong>
            <br />
            <small>${escapeHtml(item.snippet || item.bodyPreview || "")}</small>
          </td>
          <td>
            <div class="archive-links">
              <a class="link-btn" href="${escapeAttribute(toApiAbsolute(item.downloadUrl))}" target="_blank" rel="noopener">Open .eml</a>
              ${attachments}
              <a class="link-btn" href="${escapeAttribute(item.gmailMessageUrl || "#")}" target="_blank" rel="noopener">Gmail</a>
              <button class="btn" data-share-archive="${escapeAttribute(item.id)}" type="button">Share link</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderCompanyView() {
  const reports = buildReports().filter(
    (report) => report.canonicalCompany === state.companyView.selected && !state.ignoredCompanies.includes(report.canonicalCompany)
  );

  const sorted =
    state.companyView.sort === "broker"
      ? [...reports].sort((a, b) => a.broker.localeCompare(b.broker))
      : [...reports].sort((a, b) => b.timestamp - a.timestamp);

  if (sorted.length === 0) {
    refs.companyTimeline.innerHTML = `<div class="empty-state">No visible reports for this company.</div>`;
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
              <a class="link-btn" href="${escapeAttribute(report.links.archive)}" target="_blank" rel="noopener">Open archived .eml</a>
              <a class="link-btn" href="${escapeAttribute(report.links.pdf)}" target="_blank" rel="noopener">Open PDF</a>
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
      <div class="note good"><strong>Signal map:</strong> ${sentiment.bullish} bullish, ${sentiment.neutral} neutral, ${sentiment.bearish} bearish.</div>
      <div class="note"><strong>Canonical references:</strong> ${canonical.length}<br /><strong>Collapsed duplicates:</strong> ${duplicates.length}</div>
      <div class="note"><strong>Priority status:</strong> ${state.priorityCompanies.includes(state.companyView.selected) ? "In priority list" : "Not in priority list"}</div>
      <div class="note warn"><strong>Broker separation:</strong> summaries remain broker-native and are not merged.</div>
      <div class="note"><strong>Source access:</strong> archived .eml and attachment links are shareable with signed URLs.</div>
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
    .map((company) => ({
      company,
      count: reports.filter((report) => report.canonicalCompany === company).length
    }))
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
      <p>${duplicateCount} duplicate snippets are suppressed from canonical digest generation.</p>
    </div>

    ${state.pipelineMessage ? `<div class="message-toast">${escapeHtml(state.pipelineMessage)}</div>` : ""}
  `;
}

function renderNotifications() {
  if (!refs.notificationsTable || !refs.notificationsMeta) {
    return;
  }

  const stats = state.notifications.lastSyncStats;
  const syncedLabel = state.notifications.lastSyncAt
    ? new Date(state.notifications.lastSyncAt).toLocaleString()
    : "not synced yet";

  const details = [
    `${state.notifications.total} total announcements`,
    `showing ${state.notifications.items.length}`,
    `last sync: ${syncedLabel}`
  ];

  if (stats?.fromDate && stats?.toDate) {
    details.push(`range: ${stats.fromDate} to ${stats.toDate}`);
  }

  refs.notificationsMeta.textContent = details.join(" | ");

  if (state.notifications.loading) {
    refs.notificationsTable.innerHTML = '<tr><td colspan="5"><div class="empty-state">Loading announcements...</div></td></tr>';
    return;
  }

  if (state.notifications.error) {
    refs.notificationsTable.innerHTML = `<tr><td colspan="5"><div class="empty-state">Failed to load announcements: ${escapeHtml(
      state.notifications.error
    )}</div></td></tr>`;
    return;
  }

  if (state.notifications.items.length === 0) {
    refs.notificationsTable.innerHTML =
      '<tr><td colspan="5"><div class="empty-state">No announcements found for the selected filter.</div></td></tr>';
    return;
  }

  refs.notificationsTable.innerHTML = state.notifications.items
    .map((item) => {
      const attachment = item.attchmntfile
        ? `<a class="link-btn" href="${escapeAttribute(item.attchmntfile)}" target="_blank" rel="noopener">Open</a>`
        : "-";

      return `
        <tr>
          <td>${escapeHtml(item.an_dt || item.exchdisstime || "-")}</td>
          <td>${escapeHtml(item.symbol || "-")}</td>
          <td>${escapeHtml(item.sm_name || "-")}</td>
          <td>${escapeHtml(item.desc || "-")}</td>
          <td>${attachment}</td>
        </tr>
      `;
    })
    .join("");
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
  const dictionaryMap = new Map();
  for (const entry of state.dictionary) {
    dictionaryMap.set(normalizeKey(entry.canonical), entry.canonical);
    for (const alias of entry.aliases) {
      dictionaryMap.set(normalizeKey(alias), entry.canonical);
    }
  }

  const normalizedSeed = seedReports.map((report) => normalizeReport(report, dictionaryMap));
  const normalizedArchive = state.archives.items.map((archive) => {
    const companyGuess = guessCompanyFromSubject(archive.subject);
    const reportType = classifyReportType(archive.subject, archive.bodyPreview || archive.snippet || "");

    return normalizeReport(
      {
        id: `archive-${archive.id}`,
        broker: archive.broker || "Unmapped Broker",
        company: companyGuess,
        type: reportType,
        coverage: "Email Archive",
        time: archive.dateHeader || archive.ingestedAt,
        summary: archive.bodyPreview || archive.snippet || "(No preview)",
        sentiment: "neutral",
        links: {
          archive: toApiAbsolute(archive.downloadUrl),
          pdf: archive.attachments?.[0] ? toApiAbsolute(archive.attachments[0].downloadUrl) : "#",
          gmail: archive.gmailMessageUrl || "#"
        }
      },
      dictionaryMap
    );
  });

  return [...normalizedSeed, ...normalizedArchive];
}

function normalizeReport(report, dictionaryMap) {
  const canonicalCompany = dictionaryMap.get(normalizeKey(report.company)) ?? report.company;
  return {
    ...report,
    canonicalCompany,
    duplicateOf: report.duplicateOf ?? null,
    timestamp: new Date(report.time).getTime()
  };
}

function guessCompanyFromSubject(subject) {
  const source = (subject || "").trim();
  if (!source) {
    return "Unclassified Company";
  }

  const separators = ["|", "-", "–", ":"];
  for (const separator of separators) {
    if (source.includes(separator)) {
      return source.split(separator)[0].trim();
    }
  }

  return source.split(" ").slice(0, 3).join(" ").trim();
}

function classifyReportType(subject, bodyPreview) {
  const text = `${subject} ${bodyPreview}`.toLowerCase();
  if (text.includes("initiat")) {
    return "Initiation";
  }
  if (text.includes("result") || text.includes("q1") || text.includes("q2") || text.includes("q3") || text.includes("q4")) {
    return "Results Update";
  }
  if (text.includes("sector") || text.includes("weekly") || text.includes("monitor")) {
    return "Sector Update";
  }
  return "General Update";
}

function refreshAfterDictionaryChange() {
  persistDictionary();
  hydrateBrokerFilter();
  hydrateCompanySelect();
  renderAllDataViews();
}

async function checkBackendStatus() {
  refs.backendStatus.textContent = "Backend status: checking...";

  try {
    const response = await fetch(`${getApiBase()}/api/health`);
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

async function refreshAuthState() {
  renderAuthUi();
  if (!state.auth.token) {
    state.auth.user = null;
    state.auth.gmailConnected = false;
    state.archives.items = [];
    state.archives.total = 0;
    renderAllDataViews();
    return;
  }

  state.auth.loading = true;
  renderAuthUi();

  try {
    const me = await apiFetch("/api/auth/me");
    state.auth.user = me.user;
    state.auth.gmailConnected = Boolean(me.gmail?.connected);
    if (me.ingestionPreferences?.query) {
      setPipelineMessage(`Auth connected. Gmail query default: ${me.ingestionPreferences.query}`);
    } else {
      setPipelineMessage("Auth connected.");
    }

    await fetchArchives();
  } catch {
    clearAuthToken();
    state.auth.user = null;
    state.auth.gmailConnected = false;
    setPipelineMessage("Session expired. Please sign in with Google again.");
  } finally {
    state.auth.loading = false;
    renderAuthUi();
    renderAllDataViews();
  }
}

async function startGoogleAuth() {
  try {
    const redirectUri = `${window.location.origin}${window.location.pathname}`;
    const response = await fetch(
      `${getApiBase()}/api/auth/google/url?redirect_uri=${encodeURIComponent(redirectUri)}`
    );

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Unable to start Google auth flow");
    }

    window.location.assign(payload.authUrl);
  } catch (error) {
    setPipelineMessage(`Google auth start failed: ${error.message}`);
  }
}

async function signOut() {
  try {
    if (state.auth.token) {
      await apiFetch("/api/auth/logout", { method: "POST" });
    }
  } catch {
    // Continue clearing local session regardless of API result.
  }

  clearAuthToken();
  state.auth.user = null;
  state.auth.gmailConnected = false;
  state.archives.items = [];
  state.archives.total = 0;
  setPipelineMessage("Signed out.");
  renderAll();
}

function handleAuthCallbackFromHash() {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) {
    return;
  }

  const params = new URLSearchParams(hash);
  const authState = params.get("auth");

  if (!authState) {
    return;
  }

  if (authState === "success") {
    const token = params.get("token") || "";
    const email = params.get("email") || "";
    if (token) {
      state.auth.token = token;
      localStorage.setItem(STORAGE_KEYS.authToken, token);
      setPipelineMessage(`Google auth successful for ${email || "connected user"}.`);
    }
  }

  if (authState === "error") {
    const message = params.get("message") || "Google auth failed";
    setPipelineMessage(`Google auth error: ${message}`);
  }

  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

async function fetchArchives() {
  if (!state.auth.token) {
    state.archives.items = [];
    state.archives.total = 0;
    return;
  }

  try {
    const response = await apiFetch("/api/email-archives?limit=100&offset=0");
    state.archives.items = Array.isArray(response.items) ? response.items : [];
    state.archives.total = Number(response.total ?? state.archives.items.length);
    state.archives.fetchedAt = new Date().toISOString();
    hydrateBrokerFilter();
    hydrateCompanySelect();
  } catch (error) {
    setPipelineMessage(`Failed to load archives: ${error.message}`);
  }
}

async function fetchNotifications() {
  state.notifications.loading = true;
  state.notifications.error = "";
  renderNotifications();

  const symbol = (refs.notificationsSymbolInput?.value ?? "").trim().toUpperCase();
  const limitInput = Number.parseInt(refs.notificationsLimitSelect?.value ?? "50", 10);
  const limit = Number.isFinite(limitInput) ? Math.max(1, Math.min(500, limitInput)) : 50;

  state.notifications.symbol = symbol;
  state.notifications.limit = limit;

  const params = new URLSearchParams({
    limit: String(limit)
  });

  if (symbol) {
    params.set("symbol", symbol);
  }

  try {
    const payload = await apiFetch(`/api/notifications/announcements?${params.toString()}`);
    state.notifications.items = Array.isArray(payload.announcements) ? payload.announcements : [];
    state.notifications.total = Number(payload.total ?? state.notifications.items.length);
    state.notifications.lastSyncAt = typeof payload.lastNseSyncAt === "string" ? payload.lastNseSyncAt : null;
    state.notifications.lastSyncStats =
      payload.lastNseSyncStats && typeof payload.lastNseSyncStats === "object" ? payload.lastNseSyncStats : null;
  } catch (error) {
    try {
      const fallbackResponse = await fetch("./backend/data/nse_announcements.json", { cache: "no-store" });
      if (!fallbackResponse.ok) {
        throw new Error(`Fallback file not found (${fallbackResponse.status})`);
      }

      const fallbackPayload = await fallbackResponse.json();
      const allItems = Array.isArray(fallbackPayload?.announcements) ? fallbackPayload.announcements : [];
      const filteredItems = symbol
        ? allItems.filter((item) => String(item.symbol ?? "").toUpperCase() === symbol)
        : allItems;

      state.notifications.items = filteredItems.slice(0, limit);
      state.notifications.total = filteredItems.length;
      state.notifications.lastSyncAt = typeof fallbackPayload?.lastNseSyncAt === "string" ? fallbackPayload.lastNseSyncAt : null;
      state.notifications.lastSyncStats =
        fallbackPayload?.lastNseSyncStats && typeof fallbackPayload.lastNseSyncStats === "object"
          ? fallbackPayload.lastNseSyncStats
          : null;
      state.notifications.error = "";
    } catch {
      state.notifications.items = [];
      state.notifications.total = 0;
      state.notifications.error = error instanceof Error ? error.message : "Unknown error";
    }
  } finally {
    state.notifications.loading = false;
    renderNotifications();
  }
}

function getVisibleArchives() {
  let records = [...state.archives.items];

  if (state.archives.brokerFilter !== "All") {
    records = records.filter((item) => item.broker === state.archives.brokerFilter);
  }

  if (state.archives.search) {
    records = records.filter((item) => {
      const haystack = `${item.subject || ""} ${item.from || ""} ${item.snippet || ""}`.toLowerCase();
      return haystack.includes(state.archives.search);
    });
  }

  return records;
}

async function apiFetch(endpoint, options = {}) {
  const request = {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  };

  if (options.body !== undefined) {
    request.body = options.body;
  }

  if (state.auth.token) {
    request.headers.Authorization = `Bearer ${state.auth.token}`;
  }

  const response = await fetch(`${getApiBase()}${endpoint}`, request);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      clearAuthToken();
      renderAuthUi();
    }
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return payload;
}

function getApiBase() {
  return state.apiBase.replace(/\/$/, "");
}

function toApiAbsolute(relativeOrAbsoluteUrl) {
  if (!relativeOrAbsoluteUrl || relativeOrAbsoluteUrl === "#") {
    return "#";
  }

  if (/^https?:\/\//i.test(relativeOrAbsoluteUrl)) {
    return relativeOrAbsoluteUrl;
  }

  if (relativeOrAbsoluteUrl.startsWith("/")) {
    return `${getApiBase()}${relativeOrAbsoluteUrl}`;
  }

  return relativeOrAbsoluteUrl;
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

  renderAllDataViews();
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

function clearAuthToken() {
  state.auth.token = "";
  localStorage.removeItem(STORAGE_KEYS.authToken);
}

async function copyToClipboard(text) {
  if (!navigator.clipboard || !window.isSecureContext) {
    return;
  }
  await navigator.clipboard.writeText(text);
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
