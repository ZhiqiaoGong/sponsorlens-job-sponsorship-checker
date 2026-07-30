"use strict";

const CATEGORY_META = {
  no: { label: "No sponsorship", color: "#dc2626" },
  conditional: { label: "Conditional", color: "#d97706" },
  yes: { label: "Available", color: "#15803d" },
  review: { label: "Review", color: "#ca8a04" }
};

const PAGE_SCAN_META = {
  no: {
    label: "Negative sponsorship language found",
    summary: "One or more negative sponsorship phrases were found in the visible page text."
  },
  conditional: {
    label: "Conditional language found",
    summary: "The visible page text contains language suggesting sponsorship may have conditions."
  },
  yes: {
    label: "Positive sponsorship language found",
    summary: "One or more positive sponsorship phrases were found in the visible page text."
  },
  review: {
    label: "Related language found",
    summary: "The visible page text mentions related eligibility requirements without a clear sponsorship answer."
  },
  unknown: {
    label: "No sponsorship language found",
    summary: "No sponsorship-related language was found in the visible page text."
  }
};

let activeTabId = null;
let currentScanMode = "";

const elements = {
  loading: document.getElementById("loadingState"),
  unavailable: document.getElementById("unavailableState"),
  nonJob: document.getElementById("nonJobState"),
  result: document.getElementById("resultState"),
  verdict: document.getElementById("verdict"),
  resultOverline: document.getElementById("resultOverline"),
  statusLabel: document.getElementById("statusLabel"),
  statusSummary: document.getElementById("statusSummary"),
  pageHint: document.getElementById("pageHint"),
  evidenceList: document.getElementById("evidenceList"),
  evidenceCount: document.getElementById("evidenceCount"),
  emptyEvidence: document.getElementById("emptyEvidence"),
  emptyEvidenceTitle: document.getElementById("emptyEvidenceTitle"),
  emptyEvidenceText: document.getElementById("emptyEvidenceText"),
  rescan: document.getElementById("rescanButton"),
  rescanLabel: document.getElementById("rescanLabel"),
  scanAnyway: document.getElementById("scanAnywayButton"),
  settings: document.getElementById("settingsButton")
};

function showOnly(name) {
  elements.loading.classList.toggle("hidden", name !== "loading");
  elements.unavailable.classList.toggle("hidden", name !== "unavailable");
  elements.nonJob.classList.toggle("hidden", name !== "nonjob");
  elements.result.classList.toggle("hidden", name !== "result");
  elements.rescan.classList.toggle("hidden", name !== "result");
}

function sendToActiveTab(message) {
  return new Promise((resolve, reject) => {
    if (!activeTabId) {
      reject(new Error("No active tab"));
      return;
    }
    chrome.tabs.sendMessage(activeTabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(response);
    });
  });
}

function makeEvidenceCard(evidence, result) {
  const meta = CATEGORY_META[evidence.category] || CATEGORY_META.review;
  const card = document.createElement("article");
  card.className = "evidence-card";
  card.style.setProperty("--evidence-color", meta.color);

  const header = document.createElement("div");
  header.className = "evidence-meta";
  const pill = document.createElement("span");
  pill.className = "category-pill";
  pill.textContent = meta.label;
  const title = document.createElement("span");
  title.className = "evidence-title";
  title.textContent = evidence.title;
  header.append(pill, title);

  const quote = document.createElement("p");
  quote.className = "evidence-quote";
  quote.textContent = `“${evidence.snippet}”`;

  const locate = document.createElement("button");
  locate.type = "button";
  locate.className = "locate-button";
  locate.textContent = "Find on page";
  locate.addEventListener("click", async () => {
    const response = await sendToActiveTab({
      type: "SPONSORLENS_LOCATE",
      evidenceId: evidence.id,
      evidence: {
        id: evidence.id,
        matchedText: evidence.matchedText,
        snippet: evidence.snippet,
        index: evidence.index
      },
      scanContext: {
        textLength: result.textLength,
        detectedAt: result.detectedAt,
        url: result.page && result.page.url
      }
    }).catch(() => null);
    locate.textContent = response && response.ok
      ? response.action === "expand"
        ? "Open “… more”"
        : response.matchMode === "exact"
          ? "Found"
          : "Closest match"
      : response && response.reason === "page-changed"
        ? "Page changed"
        : response && response.reason === "not-visible"
          ? "Match is hidden"
        : "Text not found";
    if (response && response.ok) {
      setTimeout(() => window.close(), 500);
    }
  });

  card.append(header, quote, locate);
  return card;
}

function renderResult(result) {
  if (!result) {
    showOnly("unavailable");
    return;
  }
  if (
    result.scanMode === "skipped" ||
    (!result.isLikelyJobPage && result.scanMode !== "page")
  ) {
    currentScanMode = "skipped";
    showOnly("nonjob");
    return;
  }

  const pageWide = result.scanMode === "page";
  const pageMeta = PAGE_SCAN_META[result.status] || PAGE_SCAN_META.unknown;
  currentScanMode = pageWide ? "page" : "job";
  showOnly("result");
  elements.verdict.style.setProperty("--status", result.color || "#64748b");
  elements.resultOverline.textContent = pageWide ? "Page-wide scan" : "Scan result";
  elements.statusLabel.textContent = pageWide ? pageMeta.label : result.label;
  elements.statusSummary.textContent = pageWide ? pageMeta.summary : result.summary;
  elements.evidenceList.replaceChildren();
  elements.evidenceCount.textContent = result.evidence.length
    ? `${result.evidence.length} found`
    : "";

  result.evidence.forEach((evidence) => {
    elements.evidenceList.append(makeEvidenceCard(evidence, result));
  });
  const hasNoEvidence = result.evidence.length === 0;
  elements.result.classList.toggle("has-no-evidence", hasNoEvidence);
  elements.result.classList.toggle("page-wide-result", pageWide);
  elements.emptyEvidence.classList.toggle("hidden", !hasNoEvidence);
  elements.emptyEvidenceTitle.textContent = pageWide
    ? "No matching language to review."
    : "No evidence to review.";
  elements.emptyEvidenceText.textContent = pageWide
    ? "The scan covered all visible text on this page."
    : "This is not confirmation that sponsorship is available.";

  elements.pageHint.classList.toggle("hidden", !pageWide);
  elements.pageHint.classList.toggle("page-wide", pageWide);
  elements.pageHint.textContent = pageWide
    ? "This result covers all visible text and may combine unrelated jobs, legends, or documentation."
    : "";
  elements.rescanLabel.textContent = pageWide ? "Scan page again" : "Scan again";
}

async function loadResult(mode) {
  showOnly("loading");
  try {
    const type = mode === "page"
      ? "SPONSORLENS_SCAN_ANYWAY"
      : mode === "force"
        ? "SPONSORLENS_FORCE_SCAN"
        : "SPONSORLENS_GET_RESULT";
    const response = await sendToActiveTab({
      type
    });
    renderResult(response && response.result);
  } catch (_error) {
    showOnly("unavailable");
  }
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  activeTabId = tabs[0] && tabs[0].id;
  loadResult("get");
});

elements.rescan.addEventListener("click", () => {
  loadResult(currentScanMode === "page" ? "page" : "force");
});
elements.scanAnyway.addEventListener("click", () => loadResult("page"));
elements.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
