(function sponsorLensContentScript() {
  "use strict";

  const analyzer = globalThis.SponsorLensAnalyzer;
  if (!analyzer || globalThis.__sponsorLensLoaded) return;
  globalThis.__sponsorLensLoaded = true;

  const DEFAULT_SETTINGS = {
    pageIndicator: true,
    autoRescan: true,
    enableBadge: true,
    showUnknownOnJobPages: true,
    customNoPhrases: [],
    customYesPhrases: []
  };

  const HOST_ID = "sponsorlens-root-v1";
  const AUTO_COLLAPSE_DELAY = 4800;
  const RESUME_COLLAPSE_DELAY = 2400;
  const SESSION_PRESENTED_KEY = "__sponsorlens_presented_jobs_v1";
  const EDGE_LABELS = {
    no: "NO",
    conditional: "LIMITED",
    yes: "YES",
    review: "UNCLEAR",
    unknown: "NO INFO"
  };

  const state = {
    result: null,
    settings: { ...DEFAULT_SETTINGS },
    host: null,
    shadow: null,
    scanTimer: null,
    observer: null,
    lastTextFingerprint: "",
    highlightedElement: null,
    highlightRestoreTimer: null,
    collapseTimer: null,
    autoCollapseDeadline: 0,
    indicatorExpanded: false,
    expansionMode: "",
    indicatorDismissed: false,
    currentJobKey: "",
    presentedJobKeys: new Set()
  };

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
        state.settings = settings;
        resolve(settings);
      });
    });
  }

  function getPageText() {
    if (!document.body) return "";
    return document.body.innerText || document.body.textContent || "";
  }

  function fingerprint(text) {
    const normalized = analyzer.normalizeText(text);
    let hash = 2166136261;
    const stride = Math.max(1, Math.floor(normalized.length / 2000));
    for (let index = 0; index < normalized.length; index += stride) {
      hash ^= normalized.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${location.href}|${normalized.length}|${hash >>> 0}`;
  }

  function hashValue(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function loadPresentedJobKeys() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_PRESENTED_KEY) || "[]");
      state.presentedJobKeys = new Set(Array.isArray(saved) ? saved.slice(-60) : []);
    } catch (_error) {
      state.presentedJobKeys = new Set();
    }
  }

  function rememberPresentedJob(jobKey) {
    const token = hashValue(jobKey);
    state.presentedJobKeys.add(token);
    try {
      sessionStorage.setItem(
        SESSION_PRESENTED_KEY,
        JSON.stringify(Array.from(state.presentedJobKeys).slice(-60))
      );
    } catch (_error) {
      // Session storage may be unavailable on privacy-restricted pages.
    }
  }

  function hasPresentedJob(jobKey) {
    return state.presentedJobKeys.has(hashValue(jobKey));
  }

  function getJobIdentity(text) {
    let url;
    try {
      url = new URL(location.href);
    } catch (_error) {
      return `page:${location.href}`;
    }

    const identityParameters = new Set([
      "currentjobid",
      "gh_jid",
      "jobid",
      "job_id",
      "job-id",
      "requisitionid",
      "requisition_id",
      "reqid",
      "postingid",
      "positionid"
    ]);

    for (const [name, value] of url.searchParams.entries()) {
      if (identityParameters.has(name.toLowerCase()) && value.trim().length >= 3) {
        return `id:${url.origin}:${value.trim().toLowerCase()}`;
      }
    }

    const decodedPath = decodeURIComponent(url.pathname);
    const pathIdMatch =
      decodedPath.match(/(?:^|[_/-])(R-?\d{3,}|REQ-?\d{3,}|JR-?\d{3,}|JOB-?\d{3,})(?:$|[_/-])/i) ||
      decodedPath.match(/\/jobs?\/(?:[^/]+\/)*([a-z0-9][a-z0-9._-]{4,})\/?$/i);
    if (pathIdMatch) {
      return `path:${url.origin}:${pathIdMatch[1].toLowerCase()}`;
    }

    const textSample = analyzer.normalizeText(text).slice(0, 60000);
    const textIdMatch = textSample.match(
      /\b(?:job|requisition|req)(?:\s+(?:id|number|no\.?))?\s*[:#]\s*([a-z0-9][a-z0-9._-]{2,})\b/i
    );
    if (textIdMatch) {
      return `text:${url.origin}:${textIdMatch[1].toLowerCase()}`;
    }

    const stableParameters = [];
    for (const [name, value] of url.searchParams.entries()) {
      const lowerName = name.toLowerCase();
      if (
        identityParameters.has(lowerName) ||
        lowerName === "job" ||
        lowerName === "position"
      ) {
        stableParameters.push(`${lowerName}=${value.toLowerCase()}`);
      }
    }
    stableParameters.sort();

    const stablePath = url.pathname
      .replace(/\/(?:apply|application)(?:\/.*)?$/i, "")
      .replace(/\/+$/, "");
    const stableQuery = stableParameters.length ? `?${stableParameters.join("&")}` : "";
    return `url:${url.origin}${stablePath}${stableQuery}`;
  }

  function isApplicationFlow(text) {
    const url = String(location.href || "").toLowerCase();
    if (
      /\/(?:apply|application)(?:\/|$)|candidatehome|jobapplication|myapplications/.test(url)
    ) {
      return true;
    }

    const sample = analyzer.normalizeText(text).slice(0, 140000).toLowerCase();
    const signals = [
      /\byour application\b/,
      /\bapplication questions\b/,
      /\breview and submit\b/,
      /\bsave and continue\b/,
      /\bvoluntary self[- ]identification\b/,
      /\bpersonal information\b/,
      /\bmy experience\b/
    ].reduce((total, pattern) => total + (pattern.test(sample) ? 1 : 0), 0);
    const formFieldCount = document.querySelectorAll("input, select, textarea").length;
    return signals >= 2 || (signals >= 1 && formFieldCount >= 4);
  }

  function shouldRenderIndicator(result) {
    if (!state.settings.pageIndicator || state.indicatorDismissed) return false;
    if (result.status !== "unknown") return true;
    return result.isLikelyJobPage && state.settings.showUnknownOnJobPages;
  }

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.style.setProperty("all", "initial", "important");
      document.documentElement.appendChild(host);
    }
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("left", "0", "important");
    host.style.setProperty("right", "auto", "important");
    host.style.setProperty("top", "44%", "important");
    host.style.setProperty("bottom", "auto", "important");
    host.style.setProperty("width", "0", "important");
    host.style.setProperty("height", "0", "important");
    host.style.setProperty("z-index", "2147483647", "important");
    host.style.setProperty("pointer-events", "none", "important");
    state.host = host;
    state.shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    return state.shadow;
  }

  function clearCollapseTimer() {
    clearTimeout(state.collapseTimer);
    state.collapseTimer = null;
  }

  function removeHost(options) {
    clearCollapseTimer();
    if (state.host) state.host.remove();
    state.host = null;
    state.shadow = null;
    state.indicatorExpanded = false;
    state.expansionMode = "";
    state.autoCollapseDeadline = 0;
    if (options && options.dismiss) state.indicatorDismissed = true;
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (typeof text === "string") element.textContent = text;
    return element;
  }

  function applyIndicatorState() {
    if (!state.shadow) return;
    const card = state.shadow.querySelector(".card");
    const edgeTab = state.shadow.querySelector(".edge-tab");
    if (card) card.hidden = !state.indicatorExpanded;
    if (edgeTab) {
      edgeTab.setAttribute("aria-expanded", String(state.indicatorExpanded));
      const resultLabel = state.result ? state.result.label : "Scan result";
      edgeTab.title = state.indicatorExpanded
        ? `SponsorLens · ${resultLabel} · Collapse`
        : `SponsorLens · ${resultLabel}`;
    }
  }

  function collapseIndicator() {
    clearCollapseTimer();
    state.indicatorExpanded = false;
    state.expansionMode = "";
    state.autoCollapseDeadline = 0;
    applyIndicatorState();
  }

  function scheduleCollapse(delay) {
    clearCollapseTimer();
    if (!state.indicatorExpanded || state.expansionMode !== "auto") return;
    if (typeof delay === "number") {
      state.autoCollapseDeadline = Date.now() + delay;
    }
    const remaining = Math.max(0, state.autoCollapseDeadline - Date.now());
    if (!remaining) {
      collapseIndicator();
      return;
    }
    state.collapseTimer = setTimeout(collapseIndicator, remaining);
  }

  function expandIndicator(mode) {
    state.indicatorExpanded = true;
    state.expansionMode = mode || "manual";
    applyIndicatorState();
    if (state.expansionMode === "auto") {
      scheduleCollapse(AUTO_COLLAPSE_DELAY);
    } else {
      clearCollapseTimer();
      state.autoCollapseDeadline = 0;
    }
  }

  function dismissIndicator() {
    removeHost({ dismiss: true });
  }

  function maybeAutoPresent(result, text, forceReveal) {
    const jobKey = getJobIdentity(text);
    state.currentJobKey = jobKey;

    if (forceReveal) {
      state.indicatorDismissed = false;
      state.indicatorExpanded = true;
      state.expansionMode = "auto";
      state.autoCollapseDeadline = Date.now() + AUTO_COLLAPSE_DELAY;
      return true;
    }

    if (
      state.indicatorDismissed ||
      result.status === "unknown" ||
      !result.isLikelyJobPage ||
      isApplicationFlow(text) ||
      hasPresentedJob(jobKey)
    ) {
      return false;
    }

    rememberPresentedJob(jobKey);
    state.indicatorExpanded = true;
    state.expansionMode = "auto";
    state.autoCollapseDeadline = Date.now() + AUTO_COLLAPSE_DELAY;
    return true;
  }

  function renderIndicator(result) {
    if (!shouldRenderIndicator(result)) {
      removeHost();
      return;
    }

    const shadow = ensureHost();
    shadow.replaceChildren();

    const style = document.createElement("style");
    style.textContent = `
      :host { color-scheme: light; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .shell {
        position: relative;
        color: #0f172a;
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .edge-tab {
        position: absolute; left: 0; top: 0; transform: translateY(-50%);
        width: 42px; min-height: 56px; padding: 6px 3px;
        border: 1px solid var(--status); border-left: 0; border-radius: 0 10px 10px 0;
        background: color-mix(in srgb, var(--status) 13%, rgba(255, 255, 255, .98));
        color: #0f172a; cursor: pointer; pointer-events: auto;
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
        box-shadow: 0 8px 22px rgba(15, 23, 42, .14);
        font: 750 10px/1.1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .edge-tab:hover { width: 46px; filter: brightness(.98); }
      .edge-brand { color: #64748b; font-size: 7px; font-weight: 700; letter-spacing: .025em; }
      .edge-label { color: #0f172a; font-size: 8px; white-space: nowrap; }
      .edge-tab[data-status="no"] .edge-label,
      .edge-tab[data-status="yes"] .edge-label { font-size: 12px; }
      .edge-tooltip {
        position: absolute; left: 50px; top: 0; transform: translateY(-50%);
        padding: 7px 9px; border-radius: 8px; background: #0f172a; color: white;
        box-shadow: 0 8px 24px rgba(15, 23, 42, .2); opacity: 0;
        pointer-events: none; white-space: nowrap;
        font: 600 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        transition: opacity .12s ease;
      }
      .edge-tab:hover + .edge-tooltip,
      .edge-tab:focus-visible + .edge-tooltip { opacity: 1; }
      .edge-tab[aria-expanded="true"] + .edge-tooltip { display: none; }
      .card {
        position: absolute; left: 50px; top: 0; transform: translateY(-50%);
        width: 326px; max-height: min(430px, calc(100vh - 32px));
        border: 1px solid rgba(15, 23, 42, .12);
        border-left: 4px solid var(--status); border-radius: 14px;
        background: rgba(255, 255, 255, .98);
        box-shadow: 0 18px 48px rgba(15, 23, 42, .2);
        color: #0f172a;
        overflow: auto; overscroll-behavior: contain; pointer-events: auto;
      }
      .body { padding: 14px; }
      .header { display: flex; align-items: flex-start; gap: 10px; }
      .dot {
        width: 11px; height: 11px; margin-top: 4px; border-radius: 999px;
        background: var(--status); box-shadow: 0 0 0 4px color-mix(in srgb, var(--status) 15%, transparent);
        flex: 0 0 auto;
      }
      .heading { min-width: 0; flex: 1; }
      .eyebrow { color: #64748b; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
      .title { margin-top: 1px; color: #0f172a; font-size: 15px; font-weight: 750; }
      .close {
        width: 26px; height: 26px; border: 0; border-radius: 8px; background: transparent;
        color: #64748b; cursor: pointer; font-size: 18px; line-height: 1;
      }
      .close:hover { background: #f1f5f9; color: #0f172a; }
      .summary { margin: 9px 0 0 21px; color: #475569; }
      .evidence {
        margin: 12px 0 0 21px; padding: 10px 11px; border-radius: 10px;
        background: #f8fafc; border: 1px solid #e2e8f0; color: #334155;
        display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
      }
      .actions { display: flex; align-items: center; gap: 8px; margin: 12px 0 0 21px; }
      .primary {
        border: 0; border-radius: 9px; padding: 7px 10px; background: var(--status);
        color: white; cursor: pointer; font: 700 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .primary:hover { filter: brightness(.94); }
      .secondary {
        border: 0; padding: 7px 2px; background: transparent; color: #64748b;
        cursor: pointer; font: 600 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .secondary:hover { color: #0f172a; text-decoration: underline; }
      .hint { margin: 10px 0 0 21px; color: #94a3b8; font-size: 11px; }
      @media (max-width: 420px) {
        .card { width: calc(100vw - 64px); left: 50px; }
      }
    `;

    const shell = makeElement("div", "shell");
    shell.style.setProperty("--status", result.color);

    const edgeTab = makeElement("button", "edge-tab");
    edgeTab.type = "button";
    edgeTab.dataset.status = result.status;
    edgeTab.setAttribute("aria-label", `SponsorLens: ${result.label}. Open details.`);
    edgeTab.setAttribute("aria-expanded", String(state.indicatorExpanded));
    edgeTab.append(
      makeElement("span", "edge-brand", "SPONSOR"),
      makeElement("span", "edge-label", EDGE_LABELS[result.status] || "?")
    );
    edgeTab.addEventListener("click", () => {
      if (state.indicatorExpanded) {
        collapseIndicator();
      } else {
        expandIndicator("manual");
      }
    });
    const edgeTooltip = makeElement(
      "span",
      "edge-tooltip",
      `SponsorLens · ${result.label}`
    );

    const card = makeElement("section", "card");
    card.setAttribute("aria-label", "SponsorLens result");
    card.hidden = !state.indicatorExpanded;
    card.addEventListener("mouseenter", () => {
      if (state.expansionMode === "auto") clearCollapseTimer();
    });
    card.addEventListener("mouseleave", () => {
      if (state.expansionMode === "auto") scheduleCollapse(RESUME_COLLAPSE_DELAY);
    });

    const body = makeElement("div", "body");
    const header = makeElement("div", "header");
    const dot = makeElement("span", "dot");
    const heading = makeElement("div", "heading");
    heading.append(
      makeElement("div", "eyebrow", "SponsorLens"),
      makeElement("div", "title", result.label)
    );
    const close = makeElement("button", "close", "×");
    close.type = "button";
    close.title = "Collapse";
    close.setAttribute("aria-label", "Collapse SponsorLens");
    close.addEventListener("click", collapseIndicator);
    header.append(dot, heading, close);

    body.append(header, makeElement("p", "summary", result.summary));
    const topEvidence = result.evidence[0];
    const actions = makeElement("div", "actions");
    if (topEvidence) {
      body.append(makeElement("div", "evidence", topEvidence.snippet));
      const locate = makeElement("button", "primary", "Find on page");
      locate.type = "button";
      locate.addEventListener("click", () => {
        locateEvidence(topEvidence);
        collapseIndicator();
      });
      actions.append(locate);
    }
    const hide = makeElement("button", "secondary", "Hide on this page");
    hide.type = "button";
    hide.addEventListener("click", dismissIndicator);
    actions.append(hide);
    body.append(actions);
    body.append(
      makeElement(
        "div",
        "hint",
        result.evidence.length
          ? `${result.evidence.length} ${result.evidence.length === 1 ? "match" : "matches"} · Scanned locally`
          : "Scanned locally"
      )
    );

    card.append(body);
    shell.append(edgeTab, edgeTooltip, card);
    shadow.append(style, shell);
    applyIndicatorState();
    if (state.expansionMode === "auto") scheduleCollapse();
  }

  function restoreHighlight() {
    if (!state.highlightedElement) return;
    const element = state.highlightedElement;
    const previous = element.__sponsorLensPreviousStyle;
    if (previous) {
      element.style.outline = previous.outline;
      element.style.outlineOffset = previous.outlineOffset;
      element.style.backgroundColor = previous.backgroundColor;
      element.style.scrollMarginTop = previous.scrollMarginTop;
      delete element.__sponsorLensPreviousStyle;
    }
    state.highlightedElement = null;
  }

  function findBestElement(evidence) {
    const target = analyzer.normalizeText(evidence.matchedText).toLowerCase();
    if (!target) return null;
    const selector = "p, li, dd, dt, blockquote, article, section, div, span";
    const elements = document.querySelectorAll(selector);
    let best = null;
    let bestLength = Infinity;
    const maxElements = Math.min(elements.length, 10000);

    for (let index = 0; index < maxElements; index += 1) {
      const element = elements[index];
      if (element.closest(`#${HOST_ID}`)) continue;
      const text = analyzer.normalizeText(element.innerText || element.textContent || "");
      if (!text || text.length > 3000) continue;
      if (text.toLowerCase().includes(target) && text.length < bestLength) {
        best = element;
        bestLength = text.length;
      }
    }

    if (best) return best;

    const keywords = target
      .split(/\s+/)
      .filter((word) => word.length >= 6)
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);
    if (keywords.length < 2) return null;

    for (let index = 0; index < maxElements; index += 1) {
      const element = elements[index];
      const text = analyzer.normalizeText(element.innerText || element.textContent || "").toLowerCase();
      if (!text || text.length > 1800) continue;
      if (keywords.every((word) => text.includes(word)) && text.length < bestLength) {
        best = element;
        bestLength = text.length;
      }
    }
    return best;
  }

  function locateEvidence(evidence) {
    restoreHighlight();
    const element = findBestElement(evidence);
    if (!element) return false;

    element.__sponsorLensPreviousStyle = {
      outline: element.style.outline,
      outlineOffset: element.style.outlineOffset,
      backgroundColor: element.style.backgroundColor,
      scrollMarginTop: element.style.scrollMarginTop
    };
    element.style.setProperty("outline", "3px solid #f59e0b", "important");
    element.style.setProperty("outline-offset", "4px", "important");
    element.style.setProperty("background-color", "#fef3c7", "important");
    element.style.setProperty("scroll-margin-top", "96px", "important");
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    state.highlightedElement = element;
    clearTimeout(state.highlightRestoreTimer);
    state.highlightRestoreTimer = setTimeout(restoreHighlight, 7000);
    return true;
  }

  function publishResult(result) {
    try {
      chrome.runtime.sendMessage({
        type: "SPONSORLENS_RESULT",
        result
      });
    } catch (_error) {
      // The extension may have been reloaded while this page stayed open.
    }
  }

  function scanPage(force, options) {
    clearTimeout(state.scanTimer);
    const text = getPageText();
    if (!text.trim()) return null;
    const nextFingerprint = fingerprint(text);
    if (!force && nextFingerprint === state.lastTextFingerprint) return state.result;
    state.lastTextFingerprint = nextFingerprint;

    const result = analyzer.analyze(
      text,
      { url: location.href, title: document.title },
      {
        customNoPhrases: state.settings.customNoPhrases,
        customYesPhrases: state.settings.customYesPhrases
      }
    );
    state.result = result;
    maybeAutoPresent(result, text, Boolean(options && options.reveal));
    renderIndicator(result);
    publishResult(result);
    return result;
  }

  function scheduleScan(delay) {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => scanPage(false), delay || 850);
  }

  function configureObserver() {
    if (state.observer) state.observer.disconnect();
    if (!state.settings.autoRescan || !document.documentElement) return;
    state.observer = new MutationObserver((mutations) => {
      const meaningful = mutations.some((mutation) => {
        if (mutation.type === "characterData") return true;
        return Array.from(mutation.addedNodes).some((node) => {
          return node.nodeType === Node.TEXT_NODE ||
            (node.nodeType === Node.ELEMENT_NODE && node.id !== HOST_ID);
        });
      });
      if (meaningful) scheduleScan(900);
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.type === "SPONSORLENS_GET_RESULT") {
      sendResponse({ ok: true, result: state.result || scanPage(true) });
      return false;
    }
    if (message.type === "SPONSORLENS_FORCE_SCAN") {
      state.lastTextFingerprint = "";
      sendResponse({ ok: true, result: scanPage(true, { reveal: true }) });
      return false;
    }
    if (message.type === "SPONSORLENS_LOCATE") {
      const evidence = state.result && state.result.evidence.find(
        (item) => item.id === message.evidenceId
      );
      sendResponse({ ok: Boolean(evidence && locateEvidence(evidence)) });
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    Object.keys(changes).forEach((key) => {
      state.settings[key] = changes[key].newValue;
    });
    if (changes.pageIndicator && changes.pageIndicator.newValue) {
      state.indicatorDismissed = false;
    }
    configureObserver();
    state.lastTextFingerprint = "";
    scanPage(true);
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!state.indicatorExpanded || !state.host) return;
      if (event.composedPath().includes(state.host)) return;
      collapseIndicator();
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (!state.indicatorExpanded) return;
      if (event.key === "Escape") {
        collapseIndicator();
        return;
      }
      if (
        state.expansionMode === "auto" &&
        (!state.host || !event.composedPath().includes(state.host))
      ) {
        collapseIndicator();
      }
    },
    true
  );

  window.addEventListener(
    "scroll",
    (event) => {
      if (state.indicatorExpanded && state.expansionMode === "auto") {
        if (state.host && event.composedPath().includes(state.host)) return;
        collapseIndicator();
      }
    },
    { passive: true, capture: true }
  );

  getSettings().then(() => {
    loadPresentedJobKeys();
    scanPage(true);
    configureObserver();
    setTimeout(() => scanPage(false), 1400);
  });
})();
