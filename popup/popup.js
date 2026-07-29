"use strict";

const CATEGORY_META = {
  no: { label: "No sponsorship", color: "#dc2626" },
  conditional: { label: "Conditional", color: "#d97706" },
  yes: { label: "Available", color: "#15803d" },
  review: { label: "Review", color: "#ca8a04" }
};

let activeTabId = null;

const elements = {
  loading: document.getElementById("loadingState"),
  unavailable: document.getElementById("unavailableState"),
  result: document.getElementById("resultState"),
  verdict: document.getElementById("verdict"),
  statusLabel: document.getElementById("statusLabel"),
  statusSummary: document.getElementById("statusSummary"),
  pageHint: document.getElementById("pageHint"),
  evidenceList: document.getElementById("evidenceList"),
  evidenceCount: document.getElementById("evidenceCount"),
  emptyEvidence: document.getElementById("emptyEvidence"),
  rescan: document.getElementById("rescanButton"),
  settings: document.getElementById("settingsButton")
};

function showOnly(name) {
  elements.loading.classList.toggle("hidden", name !== "loading");
  elements.unavailable.classList.toggle("hidden", name !== "unavailable");
  elements.result.classList.toggle("hidden", name !== "result");
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

function makeEvidenceCard(evidence) {
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
      evidenceId: evidence.id
    }).catch(() => null);
    locate.textContent = response && response.ok ? "Found" : "Text not found";
    if (response && response.ok) {
      setTimeout(() => window.close(), 350);
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

  showOnly("result");
  elements.verdict.style.setProperty("--status", result.color || "#64748b");
  elements.statusLabel.textContent = result.label;
  elements.statusSummary.textContent = result.summary;
  elements.evidenceList.replaceChildren();
  elements.evidenceCount.textContent = result.evidence.length
    ? `${result.evidence.length} found`
    : "";

  result.evidence.forEach((evidence) => {
    elements.evidenceList.append(makeEvidenceCard(evidence));
  });
  const hasNoEvidence = result.evidence.length === 0;
  elements.result.classList.toggle("has-no-evidence", hasNoEvidence);
  elements.emptyEvidence.classList.toggle("hidden", !hasNoEvidence);

  const shouldWarnPageType = !result.isLikelyJobPage;
  elements.pageHint.classList.toggle("hidden", !shouldWarnPageType);
  elements.pageHint.textContent =
    "This page may not be a job listing. Treat the result as a reference only.";
}

async function loadResult(force) {
  showOnly("loading");
  try {
    const response = await sendToActiveTab({
      type: force ? "SPONSORLENS_FORCE_SCAN" : "SPONSORLENS_GET_RESULT"
    });
    renderResult(response && response.result);
  } catch (_error) {
    showOnly("unavailable");
  }
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  activeTabId = tabs[0] && tabs[0].id;
  loadResult(false);
});

elements.rescan.addEventListener("click", () => loadResult(true));
elements.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
