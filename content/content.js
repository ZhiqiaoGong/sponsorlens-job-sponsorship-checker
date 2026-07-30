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
  const HIGHLIGHT_ID = "sponsorlens-highlight-v1";
  const AUTO_COLLAPSE_DELAY = 4800;
  const RESUME_COLLAPSE_DELAY = 2400;
  const SESSION_PRESENTED_KEY = "__sponsorlens_presented_jobs_v1";
  const LOCATOR_MAX_ANCESTOR_DEPTH = 8;
  const LOCATOR_MAX_CONTEXT_LENGTH = 2800;
  const LOCATOR_STOP_WORDS = new Set([
    "about",
    "after",
    "also",
    "and",
    "are",
    "because",
    "been",
    "before",
    "being",
    "but",
    "can",
    "could",
    "does",
    "for",
    "from",
    "have",
    "into",
    "its",
    "may",
    "must",
    "not",
    "only",
    "our",
    "should",
    "that",
    "the",
    "their",
    "there",
    "this",
    "through",
    "under",
    "was",
    "were",
    "will",
    "with",
    "without",
    "would",
    "you",
    "your"
  ]);
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
    highlightOverlay: null,
    highlightRange: null,
    highlightUpdateFrame: null,
    highlightScrollHandler: null,
    highlightResizeHandler: null,
    highlightResizeObserver: null,
    highlightMutationObserver: null,
    highlightExpectedText: "",
    highlightPageUrl: "",
    pendingDisclosure: null,
    pendingDisclosureHandler: null,
    pendingLocateTimer: null,
    locatorGeneration: 0,
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
    if (!result.isLikelyJobPage || result.scanMode !== "job") return false;
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
        const response = locateEvidence(topEvidence, {
          textLength: result.textLength,
          detectedAt: result.detectedAt,
          url: result.page && result.page.url
        });
        if (!response.ok) {
          locate.textContent = response.reason === "not-visible"
            ? "Match is hidden"
            : "Text not found";
          return;
        }
        locate.textContent = response.action === "expand"
          ? "Open “… more”"
          : response.matchMode === "exact"
            ? "Found"
            : "Closest match";
        setTimeout(collapseIndicator, 450);
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
    state.locatorGeneration += 1;
    clearTimeout(state.pendingLocateTimer);
    state.pendingLocateTimer = null;
    clearTimeout(state.highlightRestoreTimer);
    state.highlightRestoreTimer = null;
    if (state.pendingDisclosure && state.pendingDisclosureHandler) {
      state.pendingDisclosure.removeEventListener(
        "click",
        state.pendingDisclosureHandler,
        true
      );
    }
    state.pendingDisclosure = null;
    state.pendingDisclosureHandler = null;
    if (state.highlightScrollHandler) {
      document.removeEventListener(
        "scroll",
        state.highlightScrollHandler,
        true
      );
      state.highlightScrollHandler = null;
    }
    if (state.highlightResizeHandler) {
      window.removeEventListener("resize", state.highlightResizeHandler);
      state.highlightResizeHandler = null;
    }
    if (state.highlightResizeObserver) {
      state.highlightResizeObserver.disconnect();
      state.highlightResizeObserver = null;
    }
    if (state.highlightMutationObserver) {
      state.highlightMutationObserver.disconnect();
      state.highlightMutationObserver = null;
    }
    if (state.highlightUpdateFrame !== null) {
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(state.highlightUpdateFrame);
      } else {
        clearTimeout(state.highlightUpdateFrame);
      }
      state.highlightUpdateFrame = null;
    }
    state.highlightRange = null;
    state.highlightExpectedText = "";
    state.highlightPageUrl = "";
    if (state.highlightOverlay) {
      state.highlightOverlay.remove();
      state.highlightOverlay = null;
    }
    if (state.highlightedElement) {
      const element = state.highlightedElement;
      const previous = element.__sponsorLensPreviousStyle;
      if (previous) {
        Object.entries(previous).forEach(([property, snapshot]) => {
          if (!snapshot.value && !snapshot.priority) {
            element.style.removeProperty(property);
            return;
          }
          element.style.setProperty(property, snapshot.value, snapshot.priority);
        });
        delete element.__sponsorLensPreviousStyle;
      }
      state.highlightedElement = null;
    }
  }

  function getInlineStyleSnapshot(element, property) {
    return {
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property)
    };
  }

  function getLocatorTokens(value) {
    const matches = analyzer.normalizeText(value)
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9.'’/+_-]*/g) || [];
    return Array.from(new Set(matches.filter((word) => {
      return word.length >= 3 && !LOCATOR_STOP_WORDS.has(word);
    })));
  }

  function getLocatorElementText(element) {
    if (!element) return "";
    return analyzer.normalizeText(element.innerText || "");
  }

  function getLocatorComparableText(value) {
    return analyzer.normalizeText(value).toLowerCase().replace(/\s+/g, " ");
  }

  function isLocatorElementVisible(element, visibilityCache) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || !element.isConnected) {
      return false;
    }
    if (visibilityCache.has(element)) return visibilityCache.get(element);
    if (
      element.id === HOST_ID ||
      (element.closest && element.closest(`#${HOST_ID}`))
    ) {
      visibilityCache.set(element, false);
      return false;
    }

    let current = element;
    let visible = true;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      if (
        current.hidden ||
        String(current.getAttribute && current.getAttribute("aria-hidden")).toLowerCase() === "true"
      ) {
        visible = false;
        break;
      }
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      ) {
        visible = false;
        break;
      }
      current = current.parentElement;
    }

    if (visible) {
      visible = Array.from(element.getClientRects()).some((rect) => {
        return rect.width > 0 && rect.height > 0;
      });
    }
    visibilityCache.set(element, visible);
    return visible;
  }

  function getLocatorContext(element) {
    let current = element;
    let best = getLocatorElementText(element);
    let depth = 0;

    while (
      current &&
      current.parentElement &&
      current.parentElement !== document.body &&
      depth < 5
    ) {
      const parentText = getLocatorElementText(current.parentElement);
      if (!parentText || parentText.length > LOCATOR_MAX_CONTEXT_LENGTH) break;
      if (parentText.length >= best.length) best = parentText;
      current = current.parentElement;
      depth += 1;
    }
    return best;
  }

  function tokenCoverage(tokens, value) {
    if (!tokens.length) return 0;
    const haystack = new Set(getLocatorTokens(value));
    const matched = tokens.filter((token) => haystack.has(token));
    return matched.length / tokens.length;
  }

  function makeLocatorRange(node, target) {
    if (!node || typeof document.createRange !== "function") return null;
    const rawText = String(node.nodeValue || "");
    const rawOffset = rawText.toLowerCase().indexOf(target);
    if (rawOffset < 0) return null;
    try {
      const range = document.createRange();
      range.setStart(node, rawOffset);
      range.setEnd(node, rawOffset + target.length);
      return range;
    } catch (_error) {
      return null;
    }
  }

  function mapLocatorTextNode(node) {
    const rawText = String((node && node.nodeValue) || "");
    let text = "";
    const offsets = [];
    let pendingWhitespace = -1;

    for (let index = 0; index < rawText.length; index += 1) {
      const character = rawText[index];
      if (/[\s\u00a0]/.test(character)) {
        if (text && pendingWhitespace < 0) pendingWhitespace = index;
        continue;
      }
      if (pendingWhitespace >= 0) {
        text += " ";
        offsets.push(pendingWhitespace);
        pendingWhitespace = -1;
      }
      text += character;
      offsets.push(index);
    }
    return { node, text, offsets };
  }

  function makeMappedLocatorRange(segments, start, end) {
    if (typeof document.createRange !== "function") return null;
    const startSegment = segments.find((segment) => {
      return start >= segment.start && start < segment.end;
    });
    const endSegment = segments.find((segment) => {
      return end > segment.start && end <= segment.end;
    });
    if (!startSegment || !endSegment) return null;
    const startOffset = startSegment.offsets[start - startSegment.start];
    const endOffset = endSegment.offsets[end - endSegment.start - 1];
    if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset)) return null;

    try {
      const range = document.createRange();
      range.setStart(startSegment.node, startOffset);
      range.setEnd(endSegment.node, endOffset + 1);
      return range;
    } catch (_error) {
      return null;
    }
  }

  function getAnchorWords(target, snippet) {
    const targetTokens = getLocatorTokens(target);
    const fallbackTokens = getLocatorTokens(snippet);
    const combined = targetTokens.length ? targetTokens : fallbackTokens;
    if (combined.length) {
      return combined
        .slice()
        .sort((left, right) => right.length - left.length)
        .slice(0, 8);
    }
    return target.split(/\s+/).filter(Boolean).slice(0, 4);
  }

  function addLocatorCandidate(
    candidates,
    element,
    entry,
    visibilityCache
  ) {
    if (
      !element ||
      element === document.body ||
      element === document.documentElement ||
      !isLocatorElementVisible(element, visibilityCache)
    ) {
      return;
    }
    let candidate = candidates.get(element);
    if (!candidate) {
      candidate = { element, entries: [] };
      candidates.set(element, candidate);
    }
    candidate.entries.push(entry);
  }

  function collectLocatorCandidates(target, snippet) {
    if (!document.body || typeof document.createTreeWalker !== "function") {
      return { candidates: [], approximateTextLength: 0 };
    }

    const candidates = new Map();
    const visibilityCache = new WeakMap();
    const anchorWords = getAnchorWords(target, snippet);
    const streamSegments = [];
    let textStream = "";
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT
    );
    let approximateTextLength = 0;
    let node = walker.nextNode();

    while (node) {
      const parent = node.parentElement;
      const mapped = mapLocatorTextNode(node);
      const text = mapped.text;
      const lowerText = text.toLowerCase();
      const irrelevant = parent && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName);
      const visible = parent && !irrelevant &&
        isLocatorElementVisible(parent, visibilityCache);

      if (visible && text) {
        if (textStream) textStream += " ";
        const streamStart = textStream.length;
        textStream += text;
        streamSegments.push({
          node,
          start: streamStart,
          end: textStream.length,
          offsets: mapped.offsets
        });
        const exactOffset = lowerText.indexOf(target);
        const matchedAnchors = anchorWords.filter((word) => lowerText.includes(word));
        const isAnchor = exactOffset >= 0 || matchedAnchors.length > 0;
        const anchorOffset = exactOffset >= 0
          ? exactOffset
          : matchedAnchors.length
            ? Math.max(0, lowerText.indexOf(matchedAnchors[0]))
            : 0;

        if (isAnchor) {
          const entry = {
            position: streamStart + anchorOffset,
            focusElement: parent,
            directExact: exactOffset >= 0,
            range: exactOffset >= 0 ? makeLocatorRange(node, target) : null
          };
          let element = parent;
          let depth = 0;
          while (element && depth <= LOCATOR_MAX_ANCESTOR_DEPTH) {
            addLocatorCandidate(
              candidates,
              element,
              entry,
              visibilityCache
            );
            if (
              element === document.body ||
              element === document.documentElement
            ) {
              break;
            }
            element = element.parentElement;
            depth += 1;
          }
        }
        approximateTextLength = textStream.length;
      }
      node = walker.nextNode();
    }

    let streamMatchIndex = textStream.toLowerCase().indexOf(target);
    while (streamMatchIndex >= 0) {
      const range = makeMappedLocatorRange(
        streamSegments,
        streamMatchIndex,
        streamMatchIndex + target.length
      );
      if (range) {
        let commonAncestor = range.commonAncestorContainer;
        if (commonAncestor && commonAncestor.nodeType === Node.TEXT_NODE) {
          commonAncestor = commonAncestor.parentElement;
        }
        const focusElement = range.startContainer &&
          range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : commonAncestor;
        const entry = {
          position: streamMatchIndex,
          focusElement,
          directExact: true,
          range
        };
        let element = commonAncestor;
        let depth = 0;
        while (element && depth <= LOCATOR_MAX_ANCESTOR_DEPTH) {
          addLocatorCandidate(
            candidates,
            element,
            entry,
            visibilityCache
          );
          if (
            element === document.body ||
            element === document.documentElement
          ) {
            break;
          }
          element = element.parentElement;
          depth += 1;
        }
      }
      streamMatchIndex = textStream.toLowerCase().indexOf(
        target,
        streamMatchIndex + Math.max(1, target.length)
      );
    }

    return {
      candidates: Array.from(candidates.values()),
      approximateTextLength
    };
  }

  function scoreLocatorCandidate(
    candidate,
    evidence,
    scanContext,
    target,
    targetTokens,
    snippetTokens,
    approximateTextLength
  ) {
    const text = getLocatorElementText(candidate.element);
    if (!text) return null;
    const lowerText = getLocatorComparableText(text);
    const exact = lowerText.includes(target);
    const targetMatch = tokenCoverage(targetTokens, text);
    if (!exact) {
      const requiredCoverage = targetTokens.length <= 1 ? 1 : 0.6;
      if (targetMatch < requiredCoverage) return null;
    }

    const context = getLocatorContext(candidate.element);
    const contextMatch = tokenCoverage(snippetTokens, context);
    const scanTextLength = Number(scanContext && scanContext.textLength);
    const evidenceIndex = Number(evidence.index);
    const hasPosition = Number.isFinite(scanTextLength) &&
      scanTextLength > 0 &&
      Number.isFinite(evidenceIndex) &&
      evidenceIndex >= 0 &&
      approximateTextLength > 0;
    const expectedPosition = hasPosition
      ? Math.min(1, evidenceIndex / scanTextLength) * approximateTextLength
      : null;
    let bestEntry = candidate.entries[0];
    if (hasPosition) {
      bestEntry = candidate.entries.reduce((best, entry) => {
        return Math.abs(entry.position - expectedPosition) <
          Math.abs(best.position - expectedPosition)
          ? entry
          : best;
      }, bestEntry);
    }
    const positionMatch = hasPosition
      ? Math.max(
        0,
        1 - Math.abs(bestEntry.position - expectedPosition) /
          Math.max(1, approximateTextLength * 0.45)
      )
      : 0.5;
    const sizePenalty = Math.min(150, Math.log2(text.length + 1) * 12) +
      (text.length > 3000 ? 420 : 0) +
      (text.length > 10000 ? 260 : 0);
    const score =
      (exact ? 1000 : 0) +
      targetMatch * 430 +
      contextMatch * 380 +
      positionMatch * 900 +
      (bestEntry.directExact ? 90 : 0) -
      sizePenalty;

    return {
      element: text.length > 1200 && bestEntry.focusElement
        ? bestEntry.focusElement
        : candidate.element,
      container: candidate.element,
      matchMode: exact ? "exact" : "context",
      score,
      range: bestEntry.range,
      positionMatch,
      contextMatch,
      textLength: text.length
    };
  }

  function findBestElement(evidence, scanContext) {
    const target = getLocatorComparableText(evidence.matchedText);
    if (!target) return null;
    const snippet = analyzer.normalizeText(evidence.snippet || evidence.matchedText);
    const targetTokens = getLocatorTokens(target);
    const snippetTokens = getLocatorTokens(snippet);
    const collected = collectLocatorCandidates(target, snippet);
    const scored = collected.candidates
      .map((candidate) => scoreLocatorCandidate(
        candidate,
        evidence,
        scanContext || {},
        target,
        targetTokens,
        snippetTokens,
        collected.approximateTextLength
      ))
      .filter(Boolean);
    if (!scored.length) return null;

    const exactMatches = scored.filter((candidate) => {
      return candidate.matchMode === "exact";
    });
    const pool = exactMatches.length ? exactMatches : scored;
    pool.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.positionMatch !== left.positionMatch) {
        return right.positionMatch - left.positionMatch;
      }
      if (right.contextMatch !== left.contextMatch) {
        return right.contextMatch - left.contextMatch;
      }
      return left.textLength - right.textLength;
    });
    return pool[0];
  }

  function getLocatorRangeRects(range) {
    if (!range || typeof range.getClientRects !== "function") return [];
    try {
      return Array.from(range.getClientRects()).filter((rect) => {
        return rect.width > 0 && rect.height > 0;
      });
    } catch (_error) {
      return [];
    }
  }

  function getLocatorTargetRects(range, fallbackElement) {
    if (range) return getLocatorRangeRects(range);
    if (!fallbackElement || typeof fallbackElement.getClientRects !== "function") {
      return [];
    }
    try {
      return Array.from(fallbackElement.getClientRects()).filter((rect) => {
        return rect.width > 0 && rect.height > 0;
      });
    } catch (_error) {
      return [];
    }
  }

  function getLocatorRangeElement(range, fallbackElement) {
    const startContainer = range && range.startContainer;
    if (startContainer && startContainer.nodeType === Node.TEXT_NODE) {
      return startContainer.parentElement || fallbackElement;
    }
    if (startContainer && startContainer.nodeType === Node.ELEMENT_NODE) {
      return startContainer;
    }
    return fallbackElement;
  }

  function getLocatorOverflow(element) {
    const style = getComputedStyle(element);
    return {
      x: String(style.overflowX || style.overflow || "visible").toLowerCase(),
      y: String(style.overflowY || style.overflow || "visible").toLowerCase()
    };
  }

  function isLocatorOverflowContainer(element) {
    if (
      !element ||
      element === document.body ||
      element === document.documentElement
    ) {
      return false;
    }
    const overflow = getLocatorOverflow(element);
    const clipsY = /^(auto|scroll|overlay)$/.test(overflow.y);
    const clipsX = /^(auto|scroll|overlay)$/.test(overflow.x);
    return (
      (clipsY && element.scrollHeight > element.clientHeight + 2) ||
      (clipsX && element.scrollWidth > element.clientWidth + 2)
    );
  }

  function getLocatorScrollContainers(range, fallbackElement) {
    const containers = [];
    let current = getLocatorRangeElement(range, fallbackElement);
    while (current && current !== document.documentElement) {
      if (isLocatorOverflowContainer(current)) containers.push(current);
      current = current.parentElement;
    }
    return containers;
  }

  function getLocatorClippingAncestors(range, fallbackElement) {
    const ancestors = [];
    let current = getLocatorRangeElement(range, fallbackElement);
    while (current && current !== document.documentElement) {
      const overflow = getLocatorOverflow(current);
      if (
        /^(auto|scroll|overlay|hidden|clip)$/.test(overflow.x) ||
        /^(auto|scroll|overlay|hidden|clip)$/.test(overflow.y)
      ) {
        ancestors.push({
          element: current,
          bounds: current.getBoundingClientRect(),
          overflow
        });
      }
      current = current.parentElement;
    }
    return ancestors;
  }

  function isLocatorRectContained(rect, bounds, overflow) {
    const tolerance = 1;
    const containedX = !/^(hidden|clip)$/.test(overflow.x) ||
      (
        rect.left >= bounds.left - tolerance &&
        rect.right <= bounds.right + tolerance
      );
    const containedY = !/^(hidden|clip)$/.test(overflow.y) ||
      (
        rect.top >= bounds.top - tolerance &&
        rect.bottom <= bounds.bottom + tolerance
      );
    return containedX && containedY;
  }

  function getCollapsedLocatorAncestor(range, fallbackElement) {
    const rects = getLocatorTargetRects(range, fallbackElement);
    if (!rects.length) return null;
    return getLocatorClippingAncestors(range, fallbackElement)
      .find((ancestor) => {
        const hidden = /^(hidden|clip)$/.test(ancestor.overflow.x) ||
          /^(hidden|clip)$/.test(ancestor.overflow.y);
        const uncertainClippedTarget = !range &&
          ancestor.element === fallbackElement &&
          (
            (
              /^(hidden|clip)$/.test(ancestor.overflow.y) &&
              ancestor.element.scrollHeight >
                ancestor.element.clientHeight + 2
            ) ||
            (
              /^(hidden|clip)$/.test(ancestor.overflow.x) &&
              ancestor.element.scrollWidth >
                ancestor.element.clientWidth + 2
            )
          );
        return hidden && (
          uncertainClippedTarget ||
          !rects.every((rect) => {
            return isLocatorRectContained(
              rect,
              ancestor.bounds,
              ancestor.overflow
            );
          })
        );
      }) || null;
  }

  function isLocatorRangeRevealed(range, fallbackElement) {
    const rangeElement = getLocatorRangeElement(range, fallbackElement);
    return Boolean(
      rangeElement &&
      rangeElement.isConnected &&
      getLocatorTargetRects(range, fallbackElement).length &&
      !getCollapsedLocatorAncestor(range, fallbackElement)
    );
  }

  function isLocatorMoreControl(control) {
    const labels = [
      control.innerText || control.textContent || "",
      control.getAttribute && control.getAttribute("aria-label"),
      control.getAttribute && control.getAttribute("title")
    ].map((value) => analyzer.normalizeText(value || "")).filter(Boolean);
    return labels.some((label) => {
      if (label.length > 80) return false;
      return /^(?:(?:…|\.{3})\s*)?(?:(?:show|see|read|view)\s+)?more(?:\s+(?:details|description|text))?$/i
        .test(label);
    });
  }

  function findLocatorDisclosure(range, fallbackElement) {
    const targetElement = getLocatorRangeElement(range, fallbackElement);
    if (!targetElement) return null;
    const clipped = getCollapsedLocatorAncestor(range, fallbackElement);
    const clippedContainer = clipped && clipped.element;
    if (!clippedContainer) return null;

    let scope = null;
    if (typeof clippedContainer.closest === "function") {
      try {
        scope = clippedContainer.closest("[id^='JobDetails_AboutTheJob_']") ||
          clippedContainer.closest("section, article");
      } catch (_error) {
        scope = null;
      }
    }
    scope = scope || clippedContainer.parentElement || clippedContainer;
    if (!scope || typeof scope.querySelectorAll !== "function") return null;

    const controls = Array.from(
      scope.querySelectorAll("button, [role='button']")
    ).filter((control) => {
      if (!isLocatorMoreControl(control)) return false;
      return Array.from(control.getClientRects()).some((rect) => {
        return rect.width > 0 && rect.height > 0;
      });
    });
    if (!controls.length) return null;

    const clippedRect = clippedContainer.getBoundingClientRect();
    controls.sort((left, right) => {
      const leftInside = typeof clippedContainer.contains === "function" &&
        clippedContainer.contains(left) ? 1 : 0;
      const rightInside = typeof clippedContainer.contains === "function" &&
        clippedContainer.contains(right) ? 1 : 0;
      if (rightInside !== leftInside) return rightInside - leftInside;
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return Math.abs(leftRect.bottom - clippedRect.bottom) -
        Math.abs(rightRect.bottom - clippedRect.bottom);
    });
    return controls[0];
  }

  function scrollLocatorContainerToTarget(
    container,
    range,
    fallbackElement
  ) {
    const rects = getLocatorTargetRects(range, fallbackElement);
    if (!rects.length || typeof container.getBoundingClientRect !== "function") {
      return false;
    }
    const targetRect = rects[0];
    const containerRect = container.getBoundingClientRect();
    const currentTop = Number(container.scrollTop) || 0;
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const desiredTop = currentTop +
      targetRect.top -
      containerRect.top -
      container.clientHeight * 0.42;
    const nextTop = Math.max(0, Math.min(maxTop, desiredTop));
    if (Math.abs(nextTop - currentTop) < 1) return false;
    if (typeof container.scrollTo === "function") {
      container.scrollTo({
        top: nextTop,
        left: Number(container.scrollLeft) || 0,
        behavior: "auto"
      });
    } else {
      container.scrollTop = nextTop;
    }
    return true;
  }

  function scrollLocatorMatchIntoView(range, fallbackElement) {
    if (!range && !fallbackElement) return false;
    const containers = getLocatorScrollContainers(range, fallbackElement);
    let scrolled = false;
    containers.forEach((container) => {
      scrolled = scrollLocatorContainerToTarget(
        container,
        range,
        fallbackElement
      ) || scrolled;
    });

    const rects = getLocatorTargetRects(range, fallbackElement);
    const firstRect = rects[0];
    const root = document.documentElement;
    const body = document.body;
    const viewportHeight = Number(window.innerHeight) || 0;
    const documentHeight = Math.max(
      Number(root && root.scrollHeight) || 0,
      Number(body && body.scrollHeight) || 0
    );
    const pageCanScroll = viewportHeight > 0 &&
      documentHeight > viewportHeight + 2;
    if (
      firstRect &&
      pageCanScroll &&
      typeof window.scrollTo === "function" &&
      (firstRect.top < 0 || firstRect.bottom > viewportHeight)
    ) {
      window.scrollTo({
        top: Math.max(
          0,
          (Number(window.scrollY) || 0) +
            firstRect.top -
            viewportHeight * 0.42
        ),
        behavior: "auto"
      });
      scrolled = true;
    }
    return scrolled;
  }

  function intersectLocatorRect(rect, bounds, overflow) {
    const clipsX = /^(auto|scroll|overlay|hidden|clip)$/.test(overflow.x);
    const clipsY = /^(auto|scroll|overlay|hidden|clip)$/.test(overflow.y);
    const top = clipsY ? Math.max(rect.top, bounds.top) : rect.top;
    const bottom = clipsY ? Math.min(rect.bottom, bounds.bottom) : rect.bottom;
    const left = clipsX ? Math.max(rect.left, bounds.left) : rect.left;
    const right = clipsX ? Math.min(rect.right, bounds.right) : rect.right;
    if (bottom <= top || right <= left) return null;
    return {
      top,
      bottom,
      left,
      right,
      width: right - left,
      height: bottom - top
    };
  }

  function getVisibleLocatorRangeRects(range) {
    const viewportWidth = Number(window.innerWidth) || 0;
    const viewportHeight = Number(window.innerHeight) || 0;
    const viewport = {
      top: 0,
      bottom: viewportHeight || Number.POSITIVE_INFINITY,
      left: 0,
      right: viewportWidth || Number.POSITIVE_INFINITY
    };
    const rangeElement = getLocatorRangeElement(range, null);
    if (
      !rangeElement ||
      !rangeElement.isConnected ||
      !isLocatorElementVisible(rangeElement, new WeakMap())
    ) {
      return [];
    }
    const clippingAncestors = getLocatorClippingAncestors(
      range,
      rangeElement
    );

    return getLocatorRangeRects(range)
      .map((rect) => intersectLocatorRect(
        rect,
        viewport,
        { x: "hidden", y: "hidden" }
      ))
      .map((rect) => {
        return clippingAncestors.reduce((visibleRect, ancestor) => {
          return visibleRect &&
            intersectLocatorRect(
              visibleRect,
              ancestor.bounds,
              ancestor.overflow
            );
        }, rect);
      })
      .filter(Boolean);
  }

  function makeRangeHighlightMarker(rect) {
    const marker = document.createElement("span");
    marker.style.setProperty("position", "absolute", "important");
    marker.style.setProperty("top", `${rect.top}px`, "important");
    marker.style.setProperty("left", `${rect.left}px`, "important");
    marker.style.setProperty("width", `${rect.width}px`, "important");
    marker.style.setProperty("height", `${rect.height}px`, "important");
    marker.style.setProperty("background", "rgba(254, 243, 199, 0.82)", "important");
    marker.style.setProperty("outline", "3px solid #f59e0b", "important");
    marker.style.setProperty("outline-offset", "2px", "important");
    marker.style.setProperty("border-radius", "2px", "important");
    marker.style.setProperty("box-sizing", "border-box", "important");
    return marker;
  }

  function updateRangeHighlight() {
    if (!state.highlightOverlay || !state.highlightRange) return;
    if (state.highlightPageUrl && state.highlightPageUrl !== location.href) {
      restoreHighlight();
      return;
    }
    if (
      state.highlightExpectedText &&
      typeof state.highlightRange.toString === "function"
    ) {
      let currentText = "";
      try {
        currentText = getLocatorComparableText(
          state.highlightRange.toString()
        );
      } catch (_error) {
        restoreHighlight();
        return;
      }
      if (currentText !== state.highlightExpectedText) {
        restoreHighlight();
        return;
      }
    }
    const markers = getVisibleLocatorRangeRects(state.highlightRange)
      .slice(0, 8)
      .map(makeRangeHighlightMarker);
    state.highlightOverlay.replaceChildren(...markers);
  }

  function scheduleRangeHighlightUpdate() {
    if (state.highlightUpdateFrame !== null) return;
    const update = () => {
      state.highlightUpdateFrame = null;
      updateRangeHighlight();
    };
    if (typeof window.requestAnimationFrame === "function") {
      state.highlightUpdateFrame = window.requestAnimationFrame(update);
    } else {
      state.highlightUpdateFrame = setTimeout(update, 16);
    }
  }

  function isLocatorHighlightNode(node) {
    const element = node && node.nodeType === Node.ELEMENT_NODE
      ? node
      : node && node.parentElement;
    return Boolean(
      element &&
      (
        element.id === HIGHLIGHT_ID ||
        (element.closest && element.closest(`#${HIGHLIGHT_ID}`))
      )
    );
  }

  function renderRangeHighlight(range, expectedText, pageUrl) {
    if (!range || !document.documentElement) return null;
    const overlay = document.createElement("div");
    overlay.id = HIGHLIGHT_ID;
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.setProperty("position", "fixed", "important");
    overlay.style.setProperty("inset", "0 auto auto 0", "important");
    overlay.style.setProperty("width", "0", "important");
    overlay.style.setProperty("height", "0", "important");
    overlay.style.setProperty("pointer-events", "none", "important");
    overlay.style.setProperty("z-index", "2147483646", "important");

    document.documentElement.appendChild(overlay);
    state.highlightRange = range;
    state.highlightExpectedText = getLocatorComparableText(expectedText || "");
    state.highlightPageUrl = pageUrl || location.href;
    state.highlightOverlay = overlay;
    state.highlightScrollHandler = scheduleRangeHighlightUpdate;
    state.highlightResizeHandler = scheduleRangeHighlightUpdate;
    document.addEventListener("scroll", state.highlightScrollHandler, true);
    window.addEventListener("resize", state.highlightResizeHandler);
    if (typeof ResizeObserver === "function") {
      state.highlightResizeObserver = new ResizeObserver(
        scheduleRangeHighlightUpdate
      );
      const observed = new Set([
        getLocatorRangeElement(range, null),
        ...getLocatorClippingAncestors(range, null).map((item) => item.element)
      ]);
      observed.forEach((element) => {
        if (element) state.highlightResizeObserver.observe(element);
      });
    }
    if (typeof MutationObserver === "function") {
      state.highlightMutationObserver = new MutationObserver((mutations) => {
        if (mutations.some((mutation) => {
          return !isLocatorHighlightNode(mutation.target);
        })) {
          scheduleRangeHighlightUpdate();
        }
      });
      state.highlightMutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["aria-hidden", "class", "hidden", "style"],
        characterData: true,
        childList: true,
        subtree: true
      });
    }
    updateRangeHighlight();
    return overlay;
  }

  function highlightLocatorElement(element, kind) {
    element.__sponsorLensPreviousStyle = {
      outline: getInlineStyleSnapshot(element, "outline"),
      "outline-offset": getInlineStyleSnapshot(element, "outline-offset"),
      "background-color": getInlineStyleSnapshot(element, "background-color"),
      "box-shadow": getInlineStyleSnapshot(element, "box-shadow"),
      "scroll-margin-top": getInlineStyleSnapshot(element, "scroll-margin-top")
    };
    element.style.setProperty("outline", "3px solid #f59e0b", "important");
    element.style.setProperty("outline-offset", "4px", "important");
    if (kind === "disclosure") {
      element.style.setProperty(
        "box-shadow",
        "0 0 0 6px rgba(245, 158, 11, 0.2)",
        "important"
      );
    } else {
      element.style.setProperty("background-color", "#fef3c7", "important");
    }
    element.style.setProperty("scroll-margin-top", "96px", "important");
    scrollLocatorMatchIntoView(null, element);
    state.highlightedElement = element;
  }

  function guideToLocatorDisclosure(disclosure, evidence, scanContext, matchMode) {
    highlightLocatorElement(disclosure, "disclosure");
    const handler = () => {
      if (state.pendingDisclosure !== disclosure) return;
      state.pendingDisclosure = null;
      state.pendingDisclosureHandler = null;
      restoreHighlight();
      const generation = state.locatorGeneration;
      waitForLocatorReveal(evidence, scanContext, generation, 0);
    };
    state.pendingDisclosure = disclosure;
    state.pendingDisclosureHandler = handler;
    disclosure.addEventListener("click", handler, {
      once: true,
      capture: true
    });
    state.highlightRestoreTimer = setTimeout(restoreHighlight, 15000);
    return {
      ok: true,
      action: "expand",
      matchMode
    };
  }

  function revealLocatorMatch(match, evidence, scanContext) {
    const element = match.element;
    if (!isLocatorRangeRevealed(match.range, element)) {
      return { ok: false, reason: "not-visible" };
    }
    scrollLocatorMatchIntoView(match.range, element);
    if (match.range && getVisibleLocatorRangeRects(match.range).length) {
      renderRangeHighlight(
        match.range,
        evidence.matchedText,
        scanContext && scanContext.url
      );
    } else if (!match.range) {
      highlightLocatorElement(element, "evidence");
    } else {
      return { ok: false, reason: "not-visible" };
    }
    state.highlightRestoreTimer = setTimeout(restoreHighlight, 7000);
    return {
      ok: true,
      matchMode: match.matchMode,
      stale: Boolean(
        scanContext &&
        scanContext.detectedAt &&
        state.result &&
        state.result.detectedAt !== scanContext.detectedAt
      )
    };
  }

  function waitForLocatorReveal(
    evidence,
    scanContext,
    generation,
    attempt,
    revealedCount
  ) {
    const delays = [100, 140, 180, 220, 280, 360, 420];
    if (
      generation !== state.locatorGeneration ||
      attempt >= delays.length ||
      (
        scanContext &&
        scanContext.url &&
        scanContext.url !== location.href
      )
    ) {
      return;
    }
    state.pendingLocateTimer = setTimeout(() => {
      state.pendingLocateTimer = null;
      if (
        generation !== state.locatorGeneration ||
        (
          scanContext &&
          scanContext.url &&
          scanContext.url !== location.href
        )
      ) {
        return;
      }
      const match = findBestElement(evidence, scanContext);
      const revealed = Boolean(
        match &&
        match.element &&
        isLocatorRangeRevealed(match.range, match.element)
      );
      const nextRevealedCount = revealed
        ? (Number(revealedCount) || 0) + 1
        : 0;
      if (revealed && nextRevealedCount >= 2) {
        revealLocatorMatch(match, evidence, scanContext);
        return;
      }
      waitForLocatorReveal(
        evidence,
        scanContext,
        generation,
        attempt + 1,
        nextRevealedCount
      );
    }, delays[attempt]);
  }

  function locateEvidence(evidence, scanContext) {
    restoreHighlight();
    const match = findBestElement(evidence, scanContext);
    if (!match || !match.element) {
      return { ok: false, reason: "not-found" };
    }
    const disclosure = findLocatorDisclosure(match.range, match.element);
    if (disclosure) {
      return guideToLocatorDisclosure(
        disclosure,
        evidence,
        scanContext,
        match.matchMode
      );
    }
    if (!isLocatorRangeRevealed(match.range, match.element)) {
      return { ok: false, reason: "not-visible" };
    }
    return revealLocatorMatch(match, evidence, scanContext);
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
    if (
      !force &&
      state.result &&
      state.result.scanMode === "page" &&
      state.result.page &&
      state.result.page.url === location.href
    ) {
      state.lastTextFingerprint = nextFingerprint;
      return state.result;
    }
    state.lastTextFingerprint = nextFingerprint;
    const pageWide = Boolean(options && options.pageWide);

    const result = analyzer.analyze(
      text,
      { url: location.href, title: document.title },
      {
        customNoPhrases: state.settings.customNoPhrases,
        customYesPhrases: state.settings.customYesPhrases,
        skipNonJob: !pageWide,
        pageWide
      }
    );
    state.result = result;

    if (pageWide) {
      restoreHighlight();
      removeHost();
      return result;
    }

    const previousJobKey = state.currentJobKey;
    maybeAutoPresent(result, text, Boolean(options && options.reveal));
    if (
      previousJobKey &&
      state.currentJobKey &&
      previousJobKey !== state.currentJobKey
    ) {
      restoreHighlight();
    }
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
        if (isLocatorHighlightNode(mutation.target)) return false;
        if (mutation.type === "characterData") return true;
        return Array.from(mutation.addedNodes).some((node) => {
          if (isLocatorHighlightNode(node)) return false;
          return node.nodeType === Node.TEXT_NODE ||
            (
              node.nodeType === Node.ELEMENT_NODE &&
              node.id !== HOST_ID &&
              node.id !== HIGHLIGHT_ID
            );
        });
      });
      if (meaningful) {
        if (state.highlightRange) scheduleRangeHighlightUpdate();
        scheduleScan(900);
      }
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
    if (message.type === "SPONSORLENS_SCAN_ANYWAY") {
      state.lastTextFingerprint = "";
      sendResponse({ ok: true, result: scanPage(true, { pageWide: true }) });
      return false;
    }
    if (message.type === "SPONSORLENS_LOCATE") {
      const currentEvidence = state.result && state.result.evidence.find(
        (item) => item.id === message.evidenceId
      );
      const evidence = message.evidence && message.evidence.matchedText
        ? message.evidence
        : currentEvidence;
      const scanContext = message.scanContext || {
        textLength: state.result && state.result.textLength,
        detectedAt: state.result && state.result.detectedAt,
        url: state.result && state.result.page && state.result.page.url
      };
      if (
        scanContext.url &&
        scanContext.url !== location.href
      ) {
        sendResponse({ ok: false, reason: "page-changed" });
        return false;
      }
      sendResponse(evidence
        ? locateEvidence(evidence, scanContext)
        : { ok: false, reason: "not-found" });
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
