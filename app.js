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
const notificationsApiBaseFallback = "https://pkeday-ai-webapp-api.onrender.com";

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
  section: "brokerage",
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
    total: 0,
    page: 1,
    pageSize: 20
  },
  notifications: {
    items: [],
    total: 0,
    limit: 50,
    page: 1,
    totalPages: 1,
    exchange: "NSE",
    symbol: "",
    source: "",
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
  sectionButtons: Array.from(document.querySelectorAll(".section-tab")),
  brokerageViewTabs: document.getElementById("brokerage-view-tabs"),
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
  archivePrevBtn: document.getElementById("archive-prev-btn"),
  archiveNextBtn: document.getElementById("archive-next-btn"),
  archivePageLabel: document.getElementById("archive-page-label"),
  notificationsExchangeSelect: document.getElementById("notifications-exchange-select"),
  notificationsSymbolInput: document.getElementById("notifications-symbol-input"),
  notificationsLimitSelect: document.getElementById("notifications-limit-select"),
  notificationsRefreshBtn: document.getElementById("notifications-refresh-btn"),
  notificationsMeta: document.getElementById("notifications-meta"),
  notificationsTable: document.getElementById("notifications-table"),
  notificationsPrevBtn: document.getElementById("notifications-prev-btn"),
  notificationsNextBtn: document.getElementById("notifications-next-btn"),
  notificationsPageLabel: document.getElementById("notifications-page-label"),
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

let notificationsRequestSeq = 0;
let notificationsAbortController = null;

init();

async function init() {
  handleAuthCallbackFromHash();
  hydrateBrokerFilter();
  hydrateCompanySelect();
  bindEvents();
  renderAll();
  await Promise.allSettled([checkBackendStatus(), refreshAuthState(), fetchNotifications()]);
}

function bindEvents() {
  const scheduleArchiveSearch = debounce(() => {
    state.archives.page = 1;
    renderArchiveView();
  }, 140);
  const scheduleNotificationsSearch = debounce(() => {
    state.notifications.page = 1;
    void fetchNotifications();
  }, 220);

  for (const button of refs.sectionButtons) {
    button.addEventListener("click", () => {
      const section = button.dataset.section;
      if (!section) {
        return;
      }

      const normalizedSection = section === "notifications" ? "notifications" : "brokerage";
      if (normalizedSection === state.section) {
        return;
      }

      state.section = normalizedSection;
      renderViewState();

      if (state.section === "notifications" && state.notifications.items.length === 0 && !state.notifications.loading) {
        void fetchNotifications();
      }
    });
  }

  for (const button of refs.tabButtons) {
    button.addEventListener("click", () => {
      const view = button.dataset.view;
      if (!view) {
        return;
      }
      state.section = "brokerage";
      state.view = view;
      renderViewState();
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
    state.section = "brokerage";
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
    state.archives.page = 1;
    renderArchiveView();
  });

  refs.archiveSearch.addEventListener("input", (event) => {
    state.archives.search = event.target.value.trim().toLowerCase();
    scheduleArchiveSearch();
  });

  refs.archiveRefreshBtn.addEventListener("click", async () => {
    state.archives.page = 1;
    await fetchArchives();
    renderArchiveView();
  });

  refs.archivePrevBtn.addEventListener("click", () => {
    if (state.archives.page <= 1) {
      return;
    }

    state.archives.page -= 1;
    renderArchiveView();
  });

  refs.archiveNextBtn.addEventListener("click", () => {
    const totalPages = getArchiveTotalPages();
    if (state.archives.page >= totalPages) {
      return;
    }

    state.archives.page += 1;
    renderArchiveView();
  });

  refs.notificationsRefreshBtn.addEventListener("click", async () => {
    await fetchNotifications();
  });

  refs.notificationsExchangeSelect.addEventListener("change", async () => {
    state.notifications.page = 1;
    await fetchNotifications();
  });

  refs.notificationsLimitSelect.addEventListener("change", async () => {
    state.notifications.page = 1;
    await fetchNotifications();
  });

  refs.notificationsSymbolInput.addEventListener("input", () => {
    scheduleNotificationsSearch();
  });

  refs.notificationsSymbolInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    state.notifications.page = 1;
    await fetchNotifications();
  });

  refs.notificationsPrevBtn.addEventListener("click", async () => {
    if (state.notifications.page <= 1) {
      return;
    }

    state.notifications.page -= 1;
    await fetchNotifications();
  });

  refs.notificationsNextBtn.addEventListener("click", async () => {
    if (state.notifications.page >= state.notifications.totalPages) {
      return;
    }

    state.notifications.page += 1;
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
    const isBrokerageView = viewName !== "notifications";
    const isActive =
      state.section === "notifications"
        ? viewName === "notifications"
        : isBrokerageView && viewName === state.view;
    element.classList.toggle("active", isActive);
  }

  for (const button of refs.sectionButtons) {
    button.classList.toggle("active", button.dataset.section === state.section);
  }

  if (refs.brokerageViewTabs) {
    refs.brokerageViewTabs.classList.toggle("hidden", state.section !== "brokerage");
  }

  const brokerageActionOnly = state.section === "brokerage";
  refs.runIngestBtn.classList.toggle("hidden", !brokerageActionOnly);
  refs.sendDigestBtn.classList.toggle("hidden", !brokerageActionOnly);

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
  const totalPages = getArchiveTotalPages(records.length);
  state.archives.page = Math.min(Math.max(state.archives.page, 1), totalPages);
  const startIndex = (state.archives.page - 1) * state.archives.pageSize;
  const pageItems = records.slice(startIndex, startIndex + state.archives.pageSize);

  const brokers = Array.from(new Set(state.archives.items.map((item) => item.broker))).sort();
  refs.archiveBrokerFilter.innerHTML = [
    `<option value="All">All</option>`,
    ...brokers.map((broker) => `<option value="${escapeAttribute(broker)}">${escapeHtml(broker)}</option>`)
  ].join("");
  refs.archiveBrokerFilter.value = state.archives.brokerFilter;

  const fetchedText = state.archives.fetchedAt ? new Date(state.archives.fetchedAt).toLocaleString() : "not fetched yet";
  refs.archiveSummary.innerHTML = `<strong>${records.length}</strong> visible archives (${state.archives.total} total loaded). Last fetch: ${escapeHtml(
    fetchedText
  )}. Page ${state.archives.page} of ${totalPages}.`;
  if (refs.archivePageLabel) {
    refs.archivePageLabel.textContent = `Page ${state.archives.page} of ${totalPages}`;
  }
  if (refs.archivePrevBtn) {
    refs.archivePrevBtn.disabled = state.archives.page <= 1;
  }
  if (refs.archiveNextBtn) {
    refs.archiveNextBtn.disabled = state.archives.page >= totalPages;
  }

  if (records.length === 0) {
    refs.archiveTable.innerHTML =
      '<tr><td colspan="5"><div class="empty-state">No archived emails yet. Sign in and run ingest to populate this table.</div></td></tr>';
    return;
  }

  refs.archiveTable.innerHTML = pageItems
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

  if (refs.notificationsExchangeSelect) {
    const normalizedExchange = state.notifications.exchange === "BSE+NSE" ? "NSE+BSE" : state.notifications.exchange;
    refs.notificationsExchangeSelect.value = normalizedExchange;
  }

  const stats = state.notifications.lastSyncStats;
  const syncedLabel = state.notifications.lastSyncAt
    ? new Date(state.notifications.lastSyncAt).toLocaleString()
    : "not synced yet";

  const details = [
    `exchange: ${state.notifications.exchange}`,
    `${state.notifications.total} total announcements`,
    `showing ${state.notifications.items.length}`,
    `page ${state.notifications.page} of ${state.notifications.totalPages}`,
    `last sync: ${syncedLabel}`
  ];

  if (state.notifications.source) {
    details.push(`source: ${state.notifications.source}`);
  }

  if (stats?.fromDate && stats?.toDate) {
    details.push(`range: ${stats.fromDate} to ${stats.toDate}`);
  }

  if (state.notifications.exchange === "NSE+BSE" && stats) {
    if (Number.isFinite(stats.inputCount)) {
      details.push(`source records: ${stats.inputCount}`);
    }

    if (Number.isFinite(stats.sourceDedupedCount)) {
      details.push(`source duplicates removed: ${stats.sourceDedupedCount}`);
    }
  }

  if (state.notifications.exchange === "DEDUP" && stats) {
    if (Number.isFinite(stats.inputCount)) {
      details.push(`deduped: ${state.notifications.total} unique from ${stats.inputCount} source records`);
    }

    if (Number.isFinite(stats.dedupCount)) {
      details.push(`duplicates removed: ${stats.dedupCount}`);
    }

    if (Number.isFinite(stats.withPdfHashCount)) {
      details.push(`hashed: ${stats.withPdfHashCount}`);
    }
  }

  refs.notificationsMeta.textContent = details.join(" | ");
  if (refs.notificationsPageLabel) {
    refs.notificationsPageLabel.textContent = `Page ${state.notifications.page} of ${state.notifications.totalPages}`;
  }
  if (refs.notificationsPrevBtn) {
    refs.notificationsPrevBtn.disabled = state.notifications.loading || state.notifications.page <= 1;
  }
  if (refs.notificationsNextBtn) {
    refs.notificationsNextBtn.disabled =
      state.notifications.loading ||
      state.notifications.page >= state.notifications.totalPages ||
      state.notifications.total === 0;
  }

  if (state.notifications.loading) {
    refs.notificationsTable.innerHTML = '<tr><td colspan="6"><div class="empty-state">Loading announcements...</div></td></tr>';
    return;
  }

  if (state.notifications.error) {
    refs.notificationsTable.innerHTML = `<tr><td colspan="6"><div class="empty-state">Failed to load announcements: ${escapeHtml(
      state.notifications.error
    )}</div></td></tr>`;
    return;
  }

  if (state.notifications.items.length === 0) {
    refs.notificationsTable.innerHTML =
      '<tr><td colspan="6"><div class="empty-state">No announcements found for the selected filter.</div></td></tr>';
    return;
  }

  refs.notificationsTable.innerHTML = state.notifications.items
    .map((item) => {
      const selectedExchange = String(state.notifications.exchange ?? "NSE").toUpperCase();
      const exchange = String(item.exchange ?? selectedExchange).toUpperCase();
      const combinedView =
        selectedExchange === "NSE+BSE" ||
        selectedExchange === "DEDUP" ||
        exchange === "NSE+BSE" ||
        exchange === "BSE+NSE" ||
        exchange === "COMBINED" ||
        exchange === "DEDUP";

      let exchangeLabel = exchange;
      let timestamp = "-";
      let symbol = "-";
      let company = "-";
      let type = "-";
      let attachmentUrl = null;

      if (combinedView) {
        const sourceExchanges = Array.isArray(item.exchanges)
          ? item.exchanges.map((value) => String(value).toUpperCase()).filter(Boolean)
          : [];
        const orderedExchanges = [...sourceExchanges].sort((left, right) => {
          if (left === right) {
            return 0;
          }
          if (left === "NSE") {
            return -1;
          }
          if (right === "NSE") {
            return 1;
          }
          return left.localeCompare(right);
        });
        exchangeLabel =
          orderedExchanges.length > 0
            ? orderedExchanges.join("+")
            : exchange === "COMBINED"
              ? "NSE+BSE"
              : exchange;
        if (exchangeLabel === "BSE+NSE") {
          exchangeLabel = "NSE+BSE";
        }
        timestamp = item.timestamp || "-";
        symbol = item.symbol || "-";
        company = item.company || "-";
        type = item.type || "-";
        attachmentUrl = item.attachment_url || null;

        const mergedCount = Number.parseInt(String(item.mergedFromCount ?? "0"), 10);
        if (Number.isFinite(mergedCount) && mergedCount > 1) {
          type = `${type} (merged ${mergedCount}x)`;
        }
      } else if (exchange === "BSE") {
        exchangeLabel = "BSE";
        timestamp = item.datetime || item.news_date || "-";
        symbol = item.scrip_code || "-";
        company = item.company_name || "-";
        type = item.category || item.subcategory || item.subject || "-";
        attachmentUrl = item.attachment_url || item.attachment_url_fallback || null;
      } else {
        exchangeLabel = "NSE";
        timestamp = item.an_dt || item.exchdisstime || "-";
        symbol = item.symbol || "-";
        company = item.sm_name || "-";
        type = item.desc || "-";
        attachmentUrl = item.attchmntfile || null;
      }

      const attachment = attachmentUrl
        ? `<a class="link-btn" href="${escapeAttribute(attachmentUrl)}" target="_blank" rel="noopener">Open</a>`
        : "-";
      const timestampLabel = formatNotificationTimestamp(timestamp);

      return `
        <tr>
          <td>${escapeHtml(timestampLabel)}</td>
          <td>${escapeHtml(exchangeLabel)}</td>
          <td>${escapeHtml(symbol)}</td>
          <td>${escapeHtml(company)}</td>
          <td>${escapeHtml(type)}</td>
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

function extractExchangeSync(payload, exchange) {
  const normalizedExchange =
    exchange === "NSE+BSE" || exchange === "BSE+NSE" || exchange === "COMBINED"
      ? "COMBINED"
      : exchange === "DEDUP"
        ? "DEDUP"
        : exchange;
  const fallbackAtKey =
    normalizedExchange === "BSE"
      ? "lastBseSyncAt"
      : normalizedExchange === "COMBINED"
        ? "lastCombinedSyncAt"
        : normalizedExchange === "DEDUP"
          ? "lastDedupSyncAt"
          : "lastNseSyncAt";
  const fallbackStatsKey =
    normalizedExchange === "BSE"
      ? "lastBseSyncStats"
      : normalizedExchange === "COMBINED"
        ? "lastCombinedSyncStats"
        : normalizedExchange === "DEDUP"
          ? "lastDedupSyncStats"
          : "lastNseSyncStats";
  let syncAt = null;
  let syncStats = null;

  if (typeof payload?.lastSyncAt === "string") {
    syncAt = payload.lastSyncAt;
  } else if (payload?.lastSyncAt && typeof payload.lastSyncAt === "object") {
    const objectSyncAt = payload.lastSyncAt;
    if (typeof objectSyncAt[exchange] === "string") {
      syncAt = objectSyncAt[exchange];
    } else if (typeof objectSyncAt[normalizedExchange] === "string") {
      syncAt = objectSyncAt[normalizedExchange];
    }
  } else if (typeof payload?.[fallbackAtKey] === "string") {
    syncAt = payload[fallbackAtKey];
  }

  if (payload?.lastSyncStats && typeof payload.lastSyncStats === "object" && !Array.isArray(payload.lastSyncStats)) {
    if (payload.lastSyncStats.exchange === exchange || payload.lastSyncStats.exchange === normalizedExchange) {
      syncStats = payload.lastSyncStats;
    } else if (payload.lastSyncStats[exchange] && typeof payload.lastSyncStats[exchange] === "object") {
      syncStats = payload.lastSyncStats[exchange];
    } else if (payload.lastSyncStats[normalizedExchange] && typeof payload.lastSyncStats[normalizedExchange] === "object") {
      syncStats = payload.lastSyncStats[normalizedExchange];
    }
  }

  if (!syncStats && payload?.[fallbackStatsKey] && typeof payload[fallbackStatsKey] === "object") {
    syncStats = payload[fallbackStatsKey];
  }

  return { syncAt, syncStats };
}

function fallbackSymbolMatch(item, exchange, symbol) {
  if (!symbol) {
    return true;
  }

  const query = symbol.toUpperCase();
  if (exchange === "NSE+BSE" || exchange === "BSE+NSE" || exchange === "COMBINED" || exchange === "DEDUP") {
    const combinedSymbol = String(item?.symbol ?? "").toUpperCase();
    const combinedCompany = String(item?.company ?? "").toUpperCase();
    const combinedIsin = String(item?.isin ?? "").toUpperCase();
    if (combinedSymbol === query || combinedCompany.includes(query) || combinedIsin === query) {
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

  const nseSymbol = String(item?.symbol ?? "").toUpperCase();
  const companyName = String(item?.sm_name ?? "").toUpperCase();
  const isin = String(item?.sm_isin ?? "").toUpperCase();
  return nseSymbol === query || companyName.includes(query) || isin === query;
}

async function fetchNotifications() {
  const exchangeInput = String(refs.notificationsExchangeSelect?.value ?? "NSE").trim().toUpperCase();
  const exchange =
    exchangeInput === "BSE"
      ? "BSE"
      : exchangeInput === "DEDUP"
        ? "DEDUP"
        : exchangeInput === "NSE+BSE" || exchangeInput === "BSE+NSE" || exchangeInput === "COMBINED"
          ? "NSE+BSE"
          : "NSE";
  const symbol = (refs.notificationsSymbolInput?.value ?? "").trim().toUpperCase();
  const limitInput = Number.parseInt(refs.notificationsLimitSelect?.value ?? "50", 10);
  const limit = Number.isFinite(limitInput) ? Math.max(1, Math.min(500, limitInput)) : 50;
  const page = Math.max(1, Number.isFinite(state.notifications.page) ? Math.floor(state.notifications.page) : 1);
  const offset = (page - 1) * limit;

  notificationsRequestSeq += 1;
  const requestSeq = notificationsRequestSeq;
  if (notificationsAbortController) {
    notificationsAbortController.abort();
  }
  notificationsAbortController = new AbortController();
  const { signal } = notificationsAbortController;

  state.notifications.exchange = exchange;
  state.notifications.symbol = symbol;
  state.notifications.limit = limit;
  state.notifications.loading = true;
  state.notifications.error = "";
  renderNotifications();

  const params = new URLSearchParams({
    exchange,
    limit: String(limit),
    offset: String(offset)
  });

  if (symbol) {
    params.set("symbol", symbol);
  }

  const notificationsEndpoint = `/api/notifications/announcements?${params.toString()}`;
  const buildApiResult = (payload, sourceLabel) => {
    const items = Array.isArray(payload?.announcements) ? payload.announcements : [];
    const { syncAt, syncStats } = extractExchangeSync(payload, exchange);
    const total = Number(payload?.total ?? items.length);
    const payloadPage = Number(payload?.page ?? page);
    const totalPages = Number(payload?.totalPages ?? Math.max(1, Math.ceil(total / limit)));

    return {
      items,
      total,
      page: Number.isFinite(payloadPage) ? Math.max(1, Math.floor(payloadPage)) : page,
      totalPages: Number.isFinite(totalPages) ? Math.max(1, Math.floor(totalPages)) : Math.max(1, Math.ceil(total / limit)),
      lastSyncAt: syncAt,
      lastSyncStats: syncStats,
      source: sourceLabel
    };
  };

  let apiResult = null;
  let apiError = null;
  let fallbackResult = null;
  let fallbackError = null;

  try {
    const payload = await apiFetch(notificationsEndpoint, { signal });
    if (requestSeq !== notificationsRequestSeq) {
      return;
    }

    apiResult = buildApiResult(
      payload,
      exchange === "NSE+BSE"
        ? "backend API (NSE+BSE no dedup)"
        : exchange === "DEDUP"
          ? "backend API (Dedup: ISIN + PDF hash)"
          : `backend API (${exchange})`
    );
  } catch (error) {
    if (error?.name === "AbortError" || requestSeq !== notificationsRequestSeq) {
      return;
    }
    apiError = error instanceof Error ? error.message : "Unknown API error";
  }

  if (!apiResult) {
    const currentBase = getApiBase();
    const fallbackBase = notificationsApiBaseFallback.replace(/\/$/, "");

    if (currentBase !== fallbackBase) {
      try {
        const payload = await apiFetchFromBase(notificationsEndpoint, fallbackBase, { signal });
        if (requestSeq !== notificationsRequestSeq) {
          return;
        }

        apiResult = buildApiResult(
          payload,
          exchange === "NSE+BSE"
            ? "core API fallback (NSE+BSE no dedup)"
            : exchange === "DEDUP"
              ? "core API fallback (Dedup: ISIN + PDF hash)"
              : `core API fallback (${exchange})`
        );
      } catch (error) {
        if (error?.name === "AbortError" || requestSeq !== notificationsRequestSeq) {
          return;
        }
        const fallbackApiError = error instanceof Error ? error.message : "Unknown core API fallback error";
        apiError = apiError ? `${apiError}; ${fallbackApiError}` : fallbackApiError;
      }
    }
  }

  try {
    const fallbackFile =
      exchange === "BSE"
        ? "./backend/data/bse_announcements.json"
        : exchange === "NSE+BSE"
          ? "./backend/data/combined_announcements.json"
          : exchange === "DEDUP"
            ? "./backend/data/dedup_announcements.json"
          : "./backend/data/nse_announcements.json";
    const fallbackResponse = await fetch(fallbackFile, { cache: "no-store", signal });
    if (!fallbackResponse.ok) {
      throw new Error(`Fallback file not found (${fallbackResponse.status})`);
    }

    const fallbackPayload = await fallbackResponse.json();
    const allItems = Array.isArray(fallbackPayload?.announcements) ? fallbackPayload.announcements : [];
    const filteredItems = allItems.filter((item) => fallbackSymbolMatch(item, exchange, symbol));
    const normalizedItems = filteredItems.map((item) => ({
      ...item,
      exchange: item.exchange || exchange
    }));
    const { syncAt, syncStats } = extractExchangeSync(fallbackPayload, exchange);

    fallbackResult = {
      items: normalizedItems.slice(offset, offset + limit),
      total: normalizedItems.length,
      page,
      totalPages: Math.max(1, Math.ceil(normalizedItems.length / limit)),
      lastSyncAt: syncAt,
      lastSyncStats: syncStats,
      source:
        exchange === "NSE+BSE"
          ? "bundled NSE+BSE snapshot (no dedup)"
          : exchange === "DEDUP"
            ? "bundled Dedup snapshot"
            : `bundled ${exchange} snapshot`
    };
  } catch (error) {
    if (error?.name === "AbortError" || requestSeq !== notificationsRequestSeq) {
      return;
    }
    fallbackError = error instanceof Error ? error.message : "Unknown fallback error";
  }

  const apiLooksReady = apiResult && (apiResult.total > 0 || apiResult.lastSyncAt);
  const chosenResult = apiLooksReady ? apiResult : fallbackResult ?? apiResult;
  if (requestSeq !== notificationsRequestSeq) {
    return;
  }

  if (chosenResult) {
    const totalPages = Math.max(1, Number(chosenResult.totalPages ?? Math.ceil(chosenResult.total / limit)));
    const nextPage = Math.min(Math.max(Number(chosenResult.page ?? page), 1), totalPages);

    state.notifications.items = chosenResult.items;
    state.notifications.total = chosenResult.total;
    state.notifications.page = nextPage;
    state.notifications.totalPages = totalPages;
    state.notifications.lastSyncAt = chosenResult.lastSyncAt;
    state.notifications.lastSyncStats = chosenResult.lastSyncStats;
    state.notifications.source = chosenResult.source;
    state.notifications.error = "";

    if (nextPage !== page) {
      state.notifications.loading = false;
      renderNotifications();
      await fetchNotifications();
      return;
    }
  } else {
    state.notifications.items = [];
    state.notifications.total = 0;
    state.notifications.page = 1;
    state.notifications.totalPages = 1;
    state.notifications.lastSyncAt = null;
    state.notifications.lastSyncStats = null;
    state.notifications.source = "";
    state.notifications.error = apiError || fallbackError || "Unable to load announcements";
  }

  if (requestSeq !== notificationsRequestSeq) {
    return;
  }

  state.notifications.loading = false;
  renderNotifications();
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

function getArchiveTotalPages(totalRecords = null) {
  const total = totalRecords === null ? getVisibleArchives().length : Number(totalRecords);
  const pageSize = Math.max(1, Number.isFinite(state.archives.pageSize) ? Math.floor(state.archives.pageSize) : 20);
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

async function apiFetch(endpoint, options = {}) {
  return apiFetchFromBase(endpoint, getApiBase(), options, true);
}

async function apiFetchFromBase(endpoint, apiBase, options = {}, clearAuthOnUnauthorized = false) {
  const request = {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    signal: options.signal
  };

  if (options.body !== undefined) {
    request.body = options.body;
  }

  if (state.auth.token) {
    request.headers.Authorization = `Bearer ${state.auth.token}`;
  }

  const normalizedBase = String(apiBase || "").replace(/\/$/, "");
  const response = await fetch(`${normalizedBase}${endpoint}`, request);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (clearAuthOnUnauthorized && response.status === 401) {
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

function debounce(callback, waitMs = 200) {
  let timeoutId = null;

  return (...args) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      timeoutId = null;
      callback(...args);
    }, waitMs);
  };
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatShortDate(value) {
  return new Date(value).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

function parseNotificationTimestamp(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "-") {
    return null;
  }

  const parsedMillis = Date.parse(normalized);
  if (Number.isFinite(parsedMillis)) {
    return new Date(parsedMillis);
  }

  const compactDateTime = normalized.match(/^(\d{2})(\d{2})(\d{4})(\d{2})(\d{2})(\d{2})$/);
  if (compactDateTime) {
    const [, day, month, year, hour, minute, second] = compactDateTime;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  }

  return null;
}

function formatNotificationTimestamp(value) {
  const parsed = parseNotificationTimestamp(value);
  if (!parsed || Number.isNaN(parsed.getTime())) {
    const fallback = String(value ?? "").trim();
    return fallback || "-";
  }

  const day = String(parsed.getDate()).padStart(2, "0");
  const month = parsed.toLocaleString("en-US", { month: "short" });
  const hour = String(parsed.getHours()).padStart(2, "0");
  const minute = String(parsed.getMinutes()).padStart(2, "0");
  return `${day}-${month} ${hour}:${minute}`;
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
