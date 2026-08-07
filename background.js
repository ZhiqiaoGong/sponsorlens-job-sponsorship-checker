"use strict";

if (typeof importScripts === "function") {
  importScripts("lib/collector.js");
}

const collector = globalThis.SponsorLensCollector || null;

const DEFAULT_SETTINGS = {
  pageIndicator: true,
  autoRescan: true,
  enableBadge: true,
  showUnknownOnJobPages: true,
  customNoPhrases: [],
  customYesPhrases: []
};

const BADGES = {
  no: { text: "NO", color: "#dc2626", title: "SponsorLens: sponsorship is not available" },
  conditional: { text: "?", color: "#d97706", title: "SponsorLens: sponsorship is conditional" },
  yes: { text: "YES", color: "#15803d", title: "SponsorLens: sponsorship is available" },
  review: { text: "?", color: "#ca8a04", title: "SponsorLens: eligibility requirements need review" },
  unknown: { text: "", color: "#64748b", title: "SponsorLens: sponsorship is not mentioned" }
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    chrome.storage.sync.set(settings);
  });
});

let collectionMutation = Promise.resolve();

function localGet(keys) {
  return new Promise((resolve, reject) => {
    if (!chrome.storage.local) {
      reject(new Error("Local storage is unavailable."));
      return;
    }
    chrome.storage.local.get(keys, (values) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(values || {});
    });
  });
}

function localSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function localRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function serializeCollectionMutation(task) {
  const next = collectionMutation.then(task, task);
  collectionMutation = next.catch(() => {});
  return next;
}

function isCollectorPage(sender) {
  if (!sender || typeof sender.url !== "string") return false;
  if (typeof chrome.runtime.getURL === "function") {
    return sender.url.startsWith(chrome.runtime.getURL("collector/"));
  }
  return /^chrome-extension:\/\/[^/]+\/collector\//.test(sender.url);
}

function hasOnlyKeys(value, allowedKeys) {
  return value &&
    typeof value === "object" &&
    Object.keys(value).every((key) => allowedKeys.includes(key));
}

function hasExactEvidence(text, evidence) {
  if (evidence === null) return true;
  if (!hasOnlyKeys(evidence, ["start", "end", "text"])) return false;
  const start = Number(evidence.start);
  const end = Number(evidence.end);
  return Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= text.length &&
    text.slice(start, end) === evidence.text;
}

function isValidCapture(capture) {
  if (!collector || !capture || typeof capture !== "object") return false;
  const allowedCaptureKeys = new Set([
    "captureSchemaVersion",
    "captureId",
    "jobKeyHash",
    "capturedAt",
    "lastSeenAt",
    "updatedAt",
    "observationCount",
    "sampleReason",
    "pageFingerprintHash",
    "page",
    "versions",
    "baseResult",
    "candidates",
    "pageFeedback",
    "review",
    "state",
    "exportedAt",
    "privacy"
  ]);
  if (Object.keys(capture).some((key) => !allowedCaptureKeys.has(key))) return false;
  if (JSON.stringify(capture).length > 12000) return false;
  if (capture.captureSchemaVersion !== collector.CAPTURE_SCHEMA_VERSION) return false;
  if (!/^cap-[a-z0-9]{10,80}$/.test(String(capture.captureId || ""))) return false;
  if (!/^[a-z0-9]{10,80}$/.test(String(capture.jobKeyHash || ""))) return false;
  if (capture.captureId !== `cap-${capture.jobKeyHash}`) return false;
  if (!/^[a-z0-9]{10,80}$/.test(String(capture.pageFingerprintHash || ""))) {
    return false;
  }
  if (capture.observationCount !== 1) return false;
  if (![
    "rule-conflict",
    "needs-review",
    "unknown-sample",
    "monitoring-sample",
    "automatic-observation",
    "user-feedback"
  ].includes(capture.sampleReason)) return false;
  if ([capture.capturedAt, capture.lastSeenAt, capture.updatedAt].some((value) => {
    return typeof value !== "string" || value.length < 10 || value.length > 40;
  })) return false;
  if (!hasOnlyKeys(capture.page, ["origin", "siteFamily", "title"])) return false;
  if (typeof capture.page.title !== "string" || capture.page.title.length > 180) {
    return false;
  }
  if (
    typeof capture.page.siteFamily !== "string" ||
    capture.page.siteFamily.length < 1 ||
    capture.page.siteFamily.length > 120 ||
    !/^[a-z0-9.-]+$/.test(capture.page.siteFamily)
  ) {
    return false;
  }
  if (collector.containsSensitiveText(capture.page.title || "")) return false;
  if (typeof capture.page.origin !== "string") return false;
  const origin = capture.page.origin;
  if (origin !== "unknown") {
    try {
      const parsedOrigin = new URL(origin);
      if (!/^https?:$/.test(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
        return false;
      }
    } catch (_error) {
      return false;
    }
  }
  if (!hasOnlyKeys(capture.versions, [
    "extension",
    "analyzer",
    "candidateExtractor",
    "collector"
  ]) || Object.keys(capture.versions).length !== 4) return false;
  if (Object.values(capture.versions).some((value) => {
    return typeof value !== "string" || value.length < 1 || value.length > 30;
  })) return false;
  if (!hasOnlyKeys(capture.baseResult, [
    "status",
    "ruleIds",
    "isLikelyJobPage"
  ])) return false;
  if (capture.baseResult.isLikelyJobPage !== true) return false;
  if (!["no", "conditional", "yes", "review", "unknown"].includes(
    capture.baseResult.status
  )) return false;
  if (!Array.isArray(capture.baseResult.ruleIds) || capture.baseResult.ruleIds.length > 24) {
    return false;
  }
  if (capture.baseResult.ruleIds.some((ruleId) => {
    return typeof ruleId !== "string" || ruleId.length < 1 || ruleId.length > 100;
  })) return false;
  if (!hasOnlyKeys(capture.pageFeedback, [
    "action",
    "predictedStatus",
    "selectedStatus",
    "at",
    "source"
  ])) return false;
  const defaultFeedback = collector.defaultPageFeedback(capture.baseResult.status);
  if (JSON.stringify(capture.pageFeedback) !== JSON.stringify(defaultFeedback)) {
    return false;
  }
  if (!hasOnlyKeys(capture.review, ["groupId", "candidates", "reviewedAt"])) {
    return false;
  }
  if (
    capture.state !== "pending" ||
    capture.exportedAt !== null ||
    capture.review.reviewedAt !== null ||
    !capture.review.candidates ||
    Object.keys(capture.review.candidates).length !== 0 ||
    capture.review.groupId !== `job-${capture.jobKeyHash}`
  ) {
    return false;
  }
  if (!hasOnlyKeys(capture.privacy, [
    "fullPageStored",
    "rawUrlStored",
    "applicationFlowStored",
    "piiScan"
  ])) return false;
  if (
    capture.privacy.fullPageStored !== false ||
    capture.privacy.rawUrlStored !== false ||
    capture.privacy.applicationFlowStored !== false ||
    capture.privacy.piiScan !== "passed"
  ) {
    return false;
  }
  if (!Array.isArray(capture.candidates)) return false;
  if (
    capture.candidates.length > collector.MAX_CANDIDATES ||
    (capture.candidates.length < 1 && capture.sampleReason !== "user-feedback")
  ) {
    return false;
  }
  if (capture.pageFingerprintHash !== collector.captureFingerprint(capture)) return false;
  return capture.candidates.every((candidate) => {
    const allowedCandidateKeys = new Set([
      "candidateId",
      "text",
      "pageStart",
      "pageEnd",
      "signals",
      "suggestion"
    ]);
    if (!(candidate &&
      Object.keys(candidate).every((key) => allowedCandidateKeys.has(key)) &&
      /^win-[a-z0-9]{10,80}$/.test(String(candidate.candidateId || "")) &&
      typeof candidate.text === "string" &&
      candidate.text.length >= 3 &&
      candidate.text.length <= 1000 &&
      !collector.containsSensitiveText(candidate.text))) {
      return false;
    }
    if (
      candidate.candidateId !==
        `win-${collector.hashToken(collector.normalizeForHash(candidate.text))}` ||
      !Number.isInteger(candidate.pageStart) ||
      !Number.isInteger(candidate.pageEnd) ||
      candidate.pageStart < 0 ||
      candidate.pageEnd !== candidate.pageStart + candidate.text.length
    ) {
      return false;
    }
    const signals = Array.isArray(candidate.signals) ? candidate.signals : [];
    if (signals.length > 12 || !signals.every((signal) => {
      return hasOnlyKeys(signal, ["start", "end", "text"]) &&
        hasExactEvidence(candidate.text, signal);
    })) {
      return false;
    }
    const suggestion = candidate.suggestion;
    if (!hasOnlyKeys(suggestion, ["label", "ruleId", "evidence", "source"])) {
      return false;
    }
    if (
      suggestion.label !== null &&
      !collector.LABELS.includes(suggestion.label)
    ) {
      return false;
    }
    if (
      suggestion.ruleId !== null &&
      (
        typeof suggestion.ruleId !== "string" ||
        suggestion.ruleId.length < 1 ||
        suggestion.ruleId.length > 100
      )
    ) {
      return false;
    }
    if (!["none", "rule", "rule-conflict"].includes(suggestion.source)) {
      return false;
    }
    return hasExactEvidence(candidate.text, suggestion.evidence);
  });
}

async function saveCapture(capture) {
  const collectionSetting = await localGet({ [collector.SETTING_KEY]: false });
  if (!collectionSetting[collector.SETTING_KEY]) {
    return {
      ok: false,
      disabled: true,
      error: "Local observation collection is disabled."
    };
  }
  if (!isValidCapture(capture)) {
    return { ok: false, error: "Invalid local capture." };
  }
  const key = collector.storageKey(capture.captureId);
  const existingValues = await localGet(key);
  const existing = existingValues[key];
  if (existing && existing.pageFingerprintHash === capture.pageFingerprintHash) {
    const normalizedExisting = collector.applyAutomaticPageConfirmation(
      collector.normalizeStoredCapture(existing)
    );
    if (
      existing.captureSchemaVersion !== normalizedExisting.captureSchemaVersion ||
      !existing.pageFeedback ||
      JSON.stringify(existing.pageFeedback) !==
        JSON.stringify(normalizedExisting.pageFeedback)
    ) {
      await localSet({ [key]: normalizedExisting });
    }
    return {
      ok: true,
      added: 0,
      updated: 0,
      duplicate: 1,
      captureId: normalizedExisting.captureId,
      pageFeedback: collector.normalizePageFeedback(
        normalizedExisting.pageFeedback,
        normalizedExisting.baseResult && normalizedExisting.baseResult.status
      )
    };
  }
  if (!existing) {
    const allValues = await localGet(null);
    const itemCount = collector.itemsFromStorage(allValues).length;
    if (itemCount >= collector.MAX_ITEMS) {
      return {
        ok: false,
        error: "The local collection is full. Review or delete observations before collecting more.",
        full: true,
        itemCount,
        maxItems: collector.MAX_ITEMS
      };
    }
  }
  const merged = collector.mergeCapture(existing, capture);
  const item = collector.applyAutomaticPageConfirmation(merged);
  await localSet({ [key]: item });
  return {
    ok: true,
    added: existing ? 0 : 1,
    updated: existing ? 1 : 0,
    captureId: item.captureId,
    pageFeedback: collector.normalizePageFeedback(
      item.pageFeedback,
      item.baseResult && item.baseResult.status
    )
  };
}

async function savePageFeedback(capture, rawFeedback) {
  const collectionSetting = await localGet({ [collector.SETTING_KEY]: false });
  if (!collectionSetting[collector.SETTING_KEY]) {
    return {
      ok: false,
      disabled: true,
      error: "Local observation collection is disabled."
    };
  }
  if (!isValidCapture(capture)) {
    return { ok: false, error: "Invalid local capture." };
  }
  const key = collector.storageKey(capture && capture.captureId);
  if (!key) return { ok: false, error: "Capture not found." };
  const values = await localGet(key);
  const existing = values[key];
  const current = existing && existing.pageFingerprintHash === capture.pageFingerprintHash
    ? existing
    : collector.mergeCapture(existing, capture);
  const updated = collector.applyPageFeedback(current, rawFeedback);
  const item = rawFeedback && rawFeedback.action === "clear"
    ? collector.applyAutomaticPageConfirmation(updated)
    : updated;
  if (
    rawFeedback &&
    rawFeedback.action === "clear" &&
    (!Array.isArray(item.candidates) || item.candidates.length === 0) &&
    item.sampleReason === "user-feedback"
  ) {
    if (existing) await localRemove(key);
    return {
      ok: true,
      captureId: item.captureId,
      removed: Boolean(existing),
      trainable: false,
      pageFeedback: collector.defaultPageFeedback(item.baseResult && item.baseResult.status)
    };
  }
  if (!existing) {
    const allValues = await localGet(null);
    const itemCount = collector.itemsFromStorage(allValues).length;
    if (itemCount >= collector.MAX_ITEMS) {
      return {
        ok: false,
        error: "The local collection is full. Review or delete observations before collecting more.",
        full: true,
        itemCount,
        maxItems: collector.MAX_ITEMS
      };
    }
  }
  await localSet({ [key]: item });
  return {
    ok: true,
    captureId: item.captureId,
    item,
    removed: false,
    trainable: Array.isArray(item.candidates) && item.candidates.length > 0,
    pageFeedback: item.pageFeedback
  };
}

async function getPageFeedback(capture) {
  const collectionSetting = await localGet({ [collector.SETTING_KEY]: false });
  if (!collectionSetting[collector.SETTING_KEY]) {
    return {
      ok: false,
      disabled: true,
      error: "Local observation collection is disabled."
    };
  }
  if (!isValidCapture(capture)) {
    return { ok: false, error: "Invalid local capture." };
  }
  const key = collector.storageKey(capture.captureId);
  const values = await localGet(key);
  const item = values[key];
  if (!item) {
    return {
      ok: true,
      found: false,
      trainable: false,
      captureId: capture.captureId,
      pageFeedback: collector.defaultPageFeedback(capture.baseResult.status)
    };
  }
  const normalizedItem = collector.applyAutomaticPageConfirmation(
    collector.normalizeStoredCapture(item)
  );
  if (
    item.captureSchemaVersion !== normalizedItem.captureSchemaVersion ||
    JSON.stringify(item.pageFeedback) !== JSON.stringify(normalizedItem.pageFeedback)
  ) {
    await localSet({ [key]: normalizedItem });
  }
  let pageFeedback = normalizedItem.pageFeedback;
  if (
    pageFeedback.action === "confirmed" &&
    pageFeedback.predictedStatus !== capture.baseResult.status
  ) {
    pageFeedback = collector.defaultPageFeedback(capture.baseResult.status);
  }
  return {
    ok: true,
    found: true,
    trainable: Array.isArray(item.candidates) && item.candidates.length > 0,
    captureId: item.captureId,
    pageFeedback
  };
}

async function listCaptures() {
  const values = await localGet(null);
  let items = collector.itemsFromStorage(values);
  if (values[collector.SETTING_KEY]) {
    items = items.map(collector.applyAutomaticPageConfirmation);
    const migrations = {};
    items.forEach((item) => {
      const key = collector.storageKey(item.captureId);
      const stored = values[key];
      if (
        stored && (
          stored.captureSchemaVersion !== item.captureSchemaVersion ||
          JSON.stringify(stored.pageFeedback) !== JSON.stringify(item.pageFeedback)
        )
      ) {
        migrations[key] = item;
      }
    });
    if (Object.keys(migrations).length) await localSet(migrations);
  }
  return {
    ok: true,
    items,
    maxItems: collector.MAX_ITEMS,
    lastExport: collector.exportReceiptSummary(
      values[collector.LAST_EXPORT_KEY]
    )
  };
}

async function getLastExport() {
  const values = await localGet(collector.LAST_EXPORT_KEY);
  const receipt = collector.normalizeExportReceipt(
    values[collector.LAST_EXPORT_KEY]
  );
  if (!receipt) {
    return { ok: false, error: "No previous export is available on this device." };
  }
  return { ok: true, receipt };
}

async function updateCapture(captureId, review) {
  const key = collector.storageKey(captureId);
  if (!key) return { ok: false, error: "Capture not found." };
  const values = await localGet(key);
  const current = values[key];
  if (!current) return { ok: false, error: "Capture not found." };
  const updated = collector.applyReview(current, review);
  await localSet({ [key]: updated.item });
  return {
    ok: true,
    item: updated.item,
    ready: updated.validation.ready,
    errors: updated.validation.errors
  };
}

async function deleteCapture(captureId) {
  const key = collector.storageKey(captureId);
  if (!key) return { ok: false, error: "Capture not found." };
  await localRemove(key);
  return { ok: true };
}

async function clearCaptures() {
  const values = await localGet(null);
  const keys = Object.keys(values).filter(collector.isItemKey);
  const removalKeys = [...keys];
  if (values[collector.LAST_EXPORT_KEY]) {
    removalKeys.push(collector.LAST_EXPORT_KEY);
  }
  if (removalKeys.length) await localRemove(removalKeys);
  return { ok: true, removed: keys.length };
}

async function markCapturesExported(captureIds) {
  const ids = Array.from(new Set(
    (Array.isArray(captureIds) ? captureIds : [])
      .map((value) => String(value || ""))
      .filter(Boolean)
  )).slice(0, collector.MAX_ITEMS);
  const keys = ids.map(collector.storageKey).filter(Boolean);
  if (!keys.length) return { ok: true, updated: 0 };
  const values = await localGet(null);
  const timestamp = new Date().toISOString();
  const requestedKeys = new Set(keys);
  const allItems = collector.itemsFromStorage(values);
  const readyItems = allItems.filter((item) => {
    return item &&
      item.state === "ready" &&
      requestedKeys.has(collector.storageKey(item.captureId));
  });
  const exportedItems = allItems.filter((item) => item && item.state === "exported");
  const plan = collector.planTrainingExport(
    [...exportedItems, ...readyItems],
    values[collector.EXPORT_LEDGER_KEY]
  );
  const nextLedger = collector.addRowsToExportLedger(
    plan.ledger,
    plan.rows,
    timestamp
  );
  const updates = {};
  readyItems.forEach((item) => {
    updates[collector.storageKey(item.captureId)] = collector.markExported(
      item,
      timestamp
    );
  });
  updates[collector.EXPORT_LEDGER_KEY] = nextLedger;
  let lastExport = collector.exportReceiptSummary(
    values[collector.LAST_EXPORT_KEY]
  );
  if (plan.rows.length) {
    const receipt = collector.createExportReceipt(plan.rows, timestamp);
    updates[collector.LAST_EXPORT_KEY] = receipt;
    lastExport = collector.exportReceiptSummary(receipt);
  }
  await localSet(updates);
  return {
    ok: true,
    rows: plan.rows,
    requested: keys.length,
    updated: readyItems.length,
    skipped: keys.length - readyItems.length,
    newRows: plan.rows.length - plan.revisionRowCount,
    revisionRows: plan.revisionRowCount,
    duplicateRows: plan.duplicateRowCount,
    lastExport
  };
}

function respondAsync(promise, sendResponse) {
  promise
    .then((value) => sendResponse(value))
    .catch((error) => {
      const response = {
        ok: false,
        error: error && error.message ? error.message : "Local collection failed."
      };
      ["code", "captureIds", "labels", "textPreview", "historical"].forEach((key) => {
        if (error && error[key] !== undefined) response[key] = error[key];
      });
      sendResponse(response);
    });
  return true;
}

function updateBadge(tabId, result) {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    if (
      !result ||
      !result.isLikelyJobPage ||
      result.scanMode === "skipped" ||
      result.scanMode === "page"
    ) {
      chrome.action.setBadgeText({ tabId, text: "" });
      chrome.action.setTitle({
        tabId,
        title: "SponsorLens: this is not an individual job listing"
      });
      return;
    }
    const badge = BADGES[result.status] || BADGES.unknown;
    const text = settings.enableBadge ? badge.text : "";
    chrome.action.setBadgeText({ tabId, text });
    chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
    chrome.action.setTitle({ tabId, title: badge.title });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message &&
    message.type === "SPONSORLENS_RESULT" &&
    sender.tab &&
    Number.isInteger(sender.tab.id)
  ) {
    updateBadge(sender.tab.id, message.result);
    return false;
  }
  if (!message || !collector) return false;

  if (message.type === "SPONSORLENS_CAPTURE_SAMPLES") {
    if (!sender.tab || !Number.isInteger(sender.tab.id)) {
      sendResponse({ ok: false, error: "Captures must come from a browser tab." });
      return false;
    }
    return respondAsync(
      serializeCollectionMutation(() => saveCapture(message.capture)),
      sendResponse
    );
  }

  if (message.type === "SPONSORLENS_COLLECTION_FEEDBACK") {
    if (!sender.tab || !Number.isInteger(sender.tab.id)) {
      sendResponse({ ok: false, error: "Feedback must come from a browser tab." });
      return false;
    }
    return respondAsync(
      serializeCollectionMutation(() => savePageFeedback(
        message.capture,
        message.feedback
      )),
      sendResponse
    );
  }

  if (message.type === "SPONSORLENS_COLLECTION_FEEDBACK_GET") {
    if (!sender.tab || !Number.isInteger(sender.tab.id)) {
      sendResponse({ ok: false, error: "Feedback must come from a browser tab." });
      return false;
    }
    return respondAsync(
      serializeCollectionMutation(() => getPageFeedback(message.capture)),
      sendResponse
    );
  }

  const collectionMessages = new Set([
    "SPONSORLENS_COLLECTION_LIST",
    "SPONSORLENS_COLLECTION_GET_LAST_EXPORT",
    "SPONSORLENS_COLLECTION_UPDATE",
    "SPONSORLENS_COLLECTION_DELETE",
    "SPONSORLENS_COLLECTION_CLEAR",
    "SPONSORLENS_COLLECTION_MARK_EXPORTED"
  ]);
  if (!collectionMessages.has(message.type)) return false;
  if (!isCollectorPage(sender)) {
    sendResponse({ ok: false, error: "This action is only available on the Review page." });
    return false;
  }

  if (message.type === "SPONSORLENS_COLLECTION_LIST") {
    return respondAsync(serializeCollectionMutation(listCaptures), sendResponse);
  }
  if (message.type === "SPONSORLENS_COLLECTION_GET_LAST_EXPORT") {
    return respondAsync(collectionMutation.then(getLastExport), sendResponse);
  }
  if (message.type === "SPONSORLENS_COLLECTION_UPDATE") {
    return respondAsync(
      serializeCollectionMutation(() => updateCapture(
        message.captureId,
        message.review
      )),
      sendResponse
    );
  }
  if (message.type === "SPONSORLENS_COLLECTION_DELETE") {
    return respondAsync(
      serializeCollectionMutation(() => deleteCapture(message.captureId)),
      sendResponse
    );
  }
  if (message.type === "SPONSORLENS_COLLECTION_CLEAR") {
    return respondAsync(
      serializeCollectionMutation(clearCaptures),
      sendResponse
    );
  }
  if (message.type === "SPONSORLENS_COLLECTION_MARK_EXPORTED") {
    return respondAsync(
      serializeCollectionMutation(() => markCapturesExported(message.captureIds)),
      sendResponse
    );
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes.enableBadge) return;
  if (!changes.enableBadge.newValue) {
    chrome.action.setBadgeText({ text: "" });
  }
});
