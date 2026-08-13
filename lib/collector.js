(function sponsorLensCollectorFactory(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.SponsorLensCollector = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCollector() {
  "use strict";

  const VERSION = "0.4.0";
  const CAPTURE_SCHEMA_VERSION = 2;
  const ITEM_PREFIX = "sponsorlens.collector.item.v1.";
  const EXPORT_LEDGER_KEY = "sponsorlens.collector.exportLedger.v1";
  const EXPORT_LEDGER_VERSION = 1;
  const LAST_EXPORT_KEY = "sponsorlens.collector.lastExport.v1";
  const LAST_EXPORT_VERSION = 1;
  const SETTING_KEY = "collectLocalTrainingSamples";
  const MAX_ITEMS = 500;
  const MAX_CANDIDATES = 3;
  const MAX_EXPORT_LEDGER_ENTRIES = 10000;
  const MAX_TITLE_LENGTH = 180;
  const MAX_GROUP_ID_LENGTH = 120;
  const LABELS = ["irrelevant", "no", "conditional", "yes", "review"];
  const LABEL_SET = new Set(LABELS);
  const PAGE_RESULT_STATUSES = [
    "no",
    "conditional",
    "yes",
    "review",
    "unknown",
    "not-job"
  ];
  const PAGE_RESULT_STATUS_SET = new Set(PAGE_RESULT_STATUSES);
  const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  const PHONE_PATTERN = /(?:^|\D)(?:\+?\d{1,3}[ .-]+)?(?:\(?\d{2,4}\)?[ .-]+){2,4}\d{3,4}(?:\s*(?:x|ext\.?)[ .-]?\d{1,6})?(?:\D|$)/i;

  function clampString(value, maximum) {
    return String(value || "").trim().slice(0, maximum);
  }

  function normalizeForHash(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function hash32(value, seed) {
    let hash = seed >>> 0;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
      hash ^= hash >>> 13;
    }
    return (hash >>> 0).toString(36).padStart(7, "0");
  }

  function hashToken(value) {
    const text = String(value || "");
    return [
      hash32(text, 2166136261),
      hash32(text, 2246822507),
      hash32(text, 3266489909)
    ].join("");
  }

  function stableFraction(value) {
    const token = hash32(value, 374761393);
    return parseInt(token, 36) / 0xffffffff;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function sanitizePage(rawPage) {
    const page = rawPage || {};
    let origin = "unknown";
    let siteFamily = "other";
    try {
      const url = new URL(String(page.url || ""));
      if (url.protocol === "http:" || url.protocol === "https:") {
        origin = url.origin;
        const host = url.hostname.toLowerCase().replace(/^www\./, "");
        siteFamily = host.split(".").slice(-2).join(".") || "other";
      }
    } catch (_error) {
      // Invalid URLs are intentionally reduced to an opaque fallback.
    }
    const title = clampString(page.title, MAX_TITLE_LENGTH);
    return {
      origin,
      siteFamily,
      title: containsSensitiveText(title) ? "" : title
    };
  }

  function containsSensitiveText(value) {
    const text = String(value || "");
    return EMAIL_PATTERN.test(text) || PHONE_PATTERN.test(text);
  }

  function defaultPageFeedback(predictedStatus) {
    const predicted = PAGE_RESULT_STATUS_SET.has(predictedStatus) &&
      predictedStatus !== "not-job"
      ? predictedStatus
      : "unknown";
    return {
      action: "none",
      predictedStatus: predicted,
      selectedStatus: null,
      at: null,
      source: null
    };
  }

  function normalizePageFeedback(value, predictedStatus) {
    const fallback = defaultPageFeedback(predictedStatus);
    if (!value || typeof value !== "object") return fallback;
    const storedPredictedStatus = PAGE_RESULT_STATUS_SET.has(value.predictedStatus) &&
      value.predictedStatus !== "not-job"
      ? value.predictedStatus
      : fallback.predictedStatus;
    const action = ["none", "confirmed", "corrected"].includes(value.action)
      ? value.action
      : "none";
    if (action === "none") return fallback;
    const selectedStatus = action === "confirmed"
      ? storedPredictedStatus
      : PAGE_RESULT_STATUS_SET.has(value.selectedStatus)
        ? value.selectedStatus
        : null;
    if (!selectedStatus) return fallback;
    const at = clampString(value.at, 40);
    return {
      action,
      predictedStatus: storedPredictedStatus,
      selectedStatus,
      at: at || null,
      source: value.source === "indicator" || value.source === "automatic"
        ? value.source
        : null
    };
  }

  function finalPageStatus(item) {
    const predictedStatus = item && item.baseResult && item.baseResult.status;
    const feedback = normalizePageFeedback(
      item && item.pageFeedback,
      predictedStatus
    );
    return feedback.action === "none"
      ? defaultPageFeedback(predictedStatus).predictedStatus
      : feedback.selectedStatus;
  }

  function isReviewLocked(item) {
    if (!item || typeof item !== "object") return false;
    const reviewedAt = clampString(
      item.review && item.review.reviewedAt,
      40
    );
    return Boolean(reviewedAt) || item.state === "ready" || item.state === "exported";
  }

  function isTrainableCapture(item) {
    return Boolean(
      item &&
      Array.isArray(item.candidates) &&
      item.candidates.length > 0 &&
      finalPageStatus(item) !== "not-job"
    );
  }

  function applyAutomaticPageConfirmation(item) {
    if (!item || typeof item !== "object") return item;
    const predictedStatus = item.baseResult && item.baseResult.status;
    const pageFeedback = normalizePageFeedback(item.pageFeedback, predictedStatus);
    const hasCandidates = Array.isArray(item.candidates) && item.candidates.length > 0;
    if (!hasCandidates || pageFeedback.action !== "none") {
      return {
        ...item,
        captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
        pageFeedback
      };
    }
    const selectedStatus = defaultPageFeedback(predictedStatus).predictedStatus;
    return {
      ...item,
      captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
      pageFeedback: {
        action: "confirmed",
        predictedStatus: selectedStatus,
        selectedStatus,
        at: null,
        source: "automatic"
      }
    };
  }

  function applyPageFeedback(item, rawFeedback, timestamp) {
    if (!item || typeof item !== "object") throw new Error("Capture not found.");
    const raw = rawFeedback && typeof rawFeedback === "object" ? rawFeedback : {};
    const predictedStatus = item.baseResult && item.baseResult.status;
    const priorFinalStatus = finalPageStatus(item);
    const at = clampString(timestamp, 40) || nowIso();
    if (raw.action === "clear") {
      const cleared = applyAutomaticPageConfirmation({
        ...item,
        captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
        pageFeedback: defaultPageFeedback(predictedStatus),
        updatedAt: at
      });
      if (priorFinalStatus !== finalPageStatus(cleared)) {
        cleared.state = "pending";
        cleared.exportedAt = null;
      }
      return cleared;
    }
    if (!["confirmed", "corrected"].includes(raw.action)) {
      throw new Error("Choose whether the result is correct or select a replacement.");
    }
    let action = raw.action;
    let selectedStatus = action === "confirmed"
      ? predictedStatus
      : raw.selectedStatus;
    if (!PAGE_RESULT_STATUS_SET.has(selectedStatus)) {
      throw new Error("Choose a valid corrected result.");
    }
    if (action === "corrected" && selectedStatus === predictedStatus) {
      action = "confirmed";
    }
    const next = {
      ...item,
      captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
      pageFeedback: {
        action,
        predictedStatus,
        selectedStatus,
        at,
        source: "indicator"
      },
      updatedAt: at
    };
    if (priorFinalStatus !== selectedStatus) {
      next.state = "pending";
      next.exportedAt = null;
    }
    return next;
  }

  function normalizeStoredCapture(item) {
    if (!item || typeof item !== "object") return item;
    return {
      ...item,
      captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
      pageFeedback: normalizePageFeedback(
        item.pageFeedback,
        item.baseResult && item.baseResult.status
      )
    };
  }

  function overlapSuggestion(candidate, evidenceItems) {
    const overlaps = (Array.isArray(evidenceItems) ? evidenceItems : [])
      .filter((evidence) => {
        if (!evidence || !LABEL_SET.has(evidence.category)) return false;
        const start = Number(evidence.index);
        const length = String(evidence.matchedText || "").length;
        if (!Number.isFinite(start) || length < 1) return false;
        return Math.max(start, candidate.index) <
          Math.min(start + length, candidate.end);
      })
      .map((evidence) => {
        const rawText = String(evidence.matchedText || "");
        let start = Math.max(0, Number(evidence.index) - candidate.index);
        let end = Math.min(candidate.text.length, start + rawText.length);
        let exactText = candidate.text.slice(start, end);
        if (exactText.toLowerCase() !== rawText.toLowerCase()) {
          const found = candidate.text.toLowerCase().indexOf(rawText.toLowerCase());
          if (found < 0) return null;
          start = found;
          end = found + rawText.length;
          exactText = candidate.text.slice(start, end);
        }
        return {
          label: evidence.category,
          ruleId: clampString(evidence.ruleId, 100) || null,
          evidence: { start, end, text: exactText }
        };
      })
      .filter(Boolean);

    if (!overlaps.length) {
      return { label: null, ruleId: null, evidence: null, source: "none" };
    }
    const labels = new Set(overlaps.map((item) => item.label));
    if (labels.size > 1) {
      return {
        label: "review",
        ruleId: null,
        evidence: null,
        source: "rule-conflict"
      };
    }
    return { ...overlaps[0], source: "rule" };
  }

  function sanitizeSignals(candidate) {
    return (Array.isArray(candidate.signalSpans) ? candidate.signalSpans : [])
      .map((span) => {
        const start = Number(span && span.start) - candidate.index;
        const end = Number(span && span.end) - candidate.index;
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 0 ||
          end <= start ||
          end > candidate.text.length
        ) {
          return null;
        }
        return {
          start,
          end,
          text: candidate.text.slice(start, end)
        };
      })
      .filter(Boolean)
      .slice(0, 12);
  }

  function sanitizeCandidate(candidate, resultEvidence) {
    if (!candidate || typeof candidate.text !== "string") return null;
    const text = candidate.text;
    const index = Number(candidate.index);
    const end = Number(candidate.end);
    if (
      text.trim().length < 3 ||
      text.length > 1000 ||
      !Number.isInteger(index) ||
      !Number.isInteger(end) ||
      index < 0 ||
      end <= index ||
      containsSensitiveText(text)
    ) {
      return null;
    }
    return {
      candidateId: `win-${hashToken(normalizeForHash(text))}`,
      text,
      pageStart: index,
      pageEnd: end,
      signals: sanitizeSignals(candidate),
      suggestion: overlapSuggestion(candidate, resultEvidence)
    };
  }

  function getSamplingReason(result, jobKey, candidateCount) {
    if (!result || candidateCount < 1) return null;
    const counts = result.counts || {};
    const decisiveCount = ["no", "conditional", "yes"]
      .filter((label) => Number(counts[label]) > 0).length;
    if (decisiveCount > 1) return "rule-conflict";
    if (result.status === "review") return "needs-review";
    return jobKey ? "automatic-observation" : null;
  }

  function captureFingerprint(capture) {
    const baseResult = capture && capture.baseResult || {};
    const candidates = Array.isArray(capture && capture.candidates)
      ? capture.candidates
      : [];
    return hashToken([
      baseResult.status || "unknown",
      (Array.isArray(baseResult.ruleIds) ? baseResult.ruleIds : []).join(","),
      ...candidates.map((candidate) => {
        const suggestion = candidate.suggestion || {};
        const evidence = suggestion.evidence || {};
        return [
          candidate.candidateId,
          suggestion.label || "",
          suggestion.ruleId || "",
          evidence.start ?? "",
          evidence.end ?? "",
          evidence.text || ""
        ].join(":");
      })
    ].join("\0"));
  }

  function buildCapture(input) {
    const value = input || {};
    const result = value.result || {};
    const jobKey = String(value.jobKey || "");
    if (
      !jobKey ||
      !result.isLikelyJobPage ||
      result.scanMode !== "job" ||
      !value.reason
    ) {
      return null;
    }
    const candidates = (Array.isArray(value.candidates) ? value.candidates : [])
      .slice(0, MAX_CANDIDATES)
      .map((candidate) => sanitizeCandidate(candidate, result.evidence))
      .filter(Boolean);
    const feedbackOnly = value.reason === "user-feedback";
    if (!candidates.length && !feedbackOnly) return null;

    const timestamp = clampString(value.capturedAt, 40) || nowIso();
    const jobKeyHash = hashToken(jobKey);
    const captureId = `cap-${jobKeyHash}`;
    const ruleIds = Array.from(new Set(
      (Array.isArray(result.evidence) ? result.evidence : [])
        .map((item) => clampString(item && item.ruleId, 100))
        .filter(Boolean)
    )).slice(0, 24);
    const capture = {
      captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
      captureId,
      jobKeyHash,
      capturedAt: timestamp,
      lastSeenAt: timestamp,
      updatedAt: timestamp,
      observationCount: 1,
      sampleReason: clampString(value.reason, 40),
      pageFingerprintHash: "",
      page: sanitizePage(value.page || result.page),
      versions: {
        extension: clampString(value.extensionVersion, 30) || "unknown",
        analyzer: clampString(result.version, 30) || "unknown",
        candidateExtractor: clampString(value.candidateExtractorVersion, 30) || "unknown",
        collector: VERSION
      },
      baseResult: {
        status: clampString(result.status, 20) || "unknown",
        ruleIds,
        isLikelyJobPage: true
      },
      candidates,
      pageFeedback: defaultPageFeedback(result.status),
      review: {
        groupId: `job-${jobKeyHash}`,
        candidates: {},
        reviewedAt: null
      },
      state: "pending",
      exportedAt: null,
      privacy: {
        fullPageStored: false,
        rawUrlStored: false,
        applicationFlowStored: false,
        piiScan: "passed"
      }
    };
    capture.pageFingerprintHash = captureFingerprint(capture);
    return capture;
  }

  function storageKey(captureId) {
    const id = clampString(captureId, 100);
    return id ? `${ITEM_PREFIX}${id}` : "";
  }

  function isItemKey(key) {
    return typeof key === "string" && key.startsWith(ITEM_PREFIX);
  }

  function itemsFromStorage(values) {
    return Object.entries(values || {})
      .filter(([key, value]) => isItemKey(key) && value && typeof value === "object")
      .map(([, value]) => normalizeStoredCapture(value))
      .sort((left, right) => {
        const dateOrder = String(right.capturedAt || "")
          .localeCompare(String(left.capturedAt || ""));
        return dateOrder || String(left.captureId).localeCompare(String(right.captureId));
      });
  }

  function emptyExportLedger() {
    return { version: EXPORT_LEDGER_VERSION, entries: {} };
  }

  function normalizeExportLedger(value) {
    if (value === undefined || value === null) return emptyExportLedger();
    if (
      !value ||
      typeof value !== "object" ||
      value.version !== EXPORT_LEDGER_VERSION ||
      !value.entries ||
      typeof value.entries !== "object" ||
      Array.isArray(value.entries) ||
      Object.keys(value).some((key) => !["version", "entries"].includes(key))
    ) {
      throw new Error("The local export history is invalid.");
    }
    const sourceEntries = Object.entries(value.entries);
    if (sourceEntries.length > MAX_EXPORT_LEDGER_ENTRIES) {
      throw new Error("The local export history is too large.");
    }
    const entries = {};
    sourceEntries.sort(([left], [right]) => left.localeCompare(right));
    sourceEntries.forEach(([id, entry]) => {
      if (
        !/^local-[a-z0-9]{10,80}$/.test(id) ||
        !entry ||
        typeof entry !== "object" ||
        Object.keys(entry).some((key) => {
          return !["label", "exportedAt", "rowHash", "captureId"].includes(key);
        }) ||
        !LABEL_SET.has(entry.label) ||
        typeof entry.exportedAt !== "string" ||
        entry.exportedAt.length < 10 ||
        entry.exportedAt.length > 40 ||
        !(entry.rowHash === undefined || /^[a-z0-9]{10,80}$/.test(entry.rowHash)) ||
        !(entry.captureId === undefined || /^cap-[a-z0-9]{10,80}$/.test(entry.captureId))
      ) {
        throw new Error("The local export history contains an invalid entry.");
      }
      entries[id] = {
        label: entry.label,
        exportedAt: entry.exportedAt,
        ...(entry.rowHash ? { rowHash: entry.rowHash } : {}),
        ...(entry.captureId ? { captureId: entry.captureId } : {})
      };
    });
    return { version: EXPORT_LEDGER_VERSION, entries };
  }

  function normalizeExportReceipt(value) {
    if (value === undefined || value === null) return null;
    let serialized = "";
    try {
      serialized = JSON.stringify(value);
    } catch (_error) {
      throw new Error("The last local export receipt is invalid.");
    }
    if (
      !value ||
      typeof value !== "object" ||
      serialized.length > 3500000 ||
      value.version !== LAST_EXPORT_VERSION ||
      !/^export-[a-z0-9]{10,80}$/.test(String(value.exportId || "")) ||
      typeof value.createdAt !== "string" ||
      value.createdAt.length < 10 ||
      value.createdAt.length > 40 ||
      !Array.isArray(value.rows) ||
      value.rows.length < 1 ||
      value.rows.length > MAX_ITEMS * MAX_CANDIDATES ||
      value.rowCount !== value.rows.length ||
      Object.keys(value).some((key) => {
        return !["version", "exportId", "createdAt", "rowCount", "rows"].includes(key);
      })
    ) {
      throw new Error("The last local export receipt is invalid.");
    }
    const rows = value.rows.map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        Object.keys(row).some((key) => {
          return ![
            "id",
            "group_id",
            "text",
            "label",
            "evidence",
            "source",
            "rule_id",
            "verified",
            "metadata"
          ].includes(key);
        }) ||
        !/^local-[a-z0-9]{10,80}$/.test(String(row.id || "")) ||
        typeof row.group_id !== "string" ||
        row.group_id.length < 3 ||
        row.group_id.length > MAX_GROUP_ID_LENGTH ||
        typeof row.text !== "string" ||
        row.text.length < 3 ||
        row.text.length > 1000 ||
        containsSensitiveText(row.text) ||
        !LABEL_SET.has(row.label) ||
        row.source !== "sponsorlens_local_review" ||
        row.verified !== true ||
        !(row.rule_id === null || (
          typeof row.rule_id === "string" && row.rule_id.length <= 100
        )) ||
        !row.metadata ||
        typeof row.metadata !== "object" ||
        Array.isArray(row.metadata)
      ) {
        throw new Error("The last local export receipt contains an invalid row.");
      }
      const evidence = validateEvidence(row.text, row.label, row.evidence);
      if (!evidence.ok) {
        throw new Error("The last local export receipt contains invalid evidence.");
      }
      return JSON.parse(JSON.stringify(row));
    });
    return {
      version: LAST_EXPORT_VERSION,
      exportId: value.exportId,
      createdAt: value.createdAt,
      rowCount: rows.length,
      rows
    };
  }

  function createExportReceipt(rows, timestamp) {
    const createdAt = clampString(timestamp, 40) || nowIso();
    const list = Array.isArray(rows) ? rows : [];
    const exportId = `export-${hashToken([
      createdAt,
      ...list.map((row) => `${row && row.id}:${row && row.label}`)
    ].join("\0"))}`;
    return normalizeExportReceipt({
      version: LAST_EXPORT_VERSION,
      exportId,
      createdAt,
      rowCount: list.length,
      rows: list
    });
  }

  function exportReceiptSummary(value) {
    const receipt = normalizeExportReceipt(value);
    return receipt ? {
      exportId: receipt.exportId,
      createdAt: receipt.createdAt,
      rowCount: receipt.rowCount
    } : null;
  }

  function mergeCapture(existing, incoming) {
    if (!existing || existing.captureId !== incoming.captureId) {
      return applyAutomaticPageConfirmation(normalizeStoredCapture(incoming));
    }
    // A completed human review is immutable to automatic rescans. This keeps
    // rule and extractor upgrades from silently changing verified examples.
    if (isReviewLocked(existing)) return existing;
    existing = normalizeStoredCapture(existing);
    incoming = normalizeStoredCapture(incoming);
    const priorCandidates = Array.isArray(existing.candidates)
      ? existing.candidates
      : [];
    const freshCandidates = Array.isArray(incoming.candidates)
      ? incoming.candidates
      : [];
    const review = existing.review && typeof existing.review === "object"
      ? existing.review
      : incoming.review;
    const mergeablePriorCandidates = priorCandidates.filter((candidate) => {
      if (getCandidateReview(review, candidate.candidateId)) return true;
      return !freshCandidates.some((fresh) => {
        return fresh.text.length > candidate.text.length &&
          fresh.text.includes(candidate.text);
      });
    });
    const freshById = new Map(
      freshCandidates.map((candidate) => [candidate.candidateId, candidate])
    );
    const orderedCandidates = existing.state === "pending"
      ? [...freshCandidates, ...mergeablePriorCandidates]
      : [...mergeablePriorCandidates, ...freshCandidates];
    const selectedCandidates = new Map();
    orderedCandidates.forEach((candidate) => {
      const prior = selectedCandidates.get(candidate.candidateId);
      if (!prior) {
        selectedCandidates.set(candidate.candidateId, candidate);
        return;
      }
      const fresh = freshById.get(candidate.candidateId);
      if (fresh && prior.text === fresh.text) {
        selectedCandidates.set(candidate.candidateId, {
          ...prior,
          ...fresh
        });
      }
    });
    const candidates = Array.from(selectedCandidates.values()).slice(0, MAX_CANDIDATES);
    const priorCandidateIds = new Set(
      priorCandidates.map((candidate) => candidate.candidateId)
    );
    const addedCandidate = candidates.some((candidate) => {
      return !priorCandidateIds.has(candidate.candidateId);
    });
    const existingFeedback = normalizePageFeedback(
      existing.pageFeedback,
      existing.baseResult && existing.baseResult.status
    );
    const incomingPredictedStatus = defaultPageFeedback(
      incoming.baseResult && incoming.baseResult.status
    ).predictedStatus;
    const staleConfirmation = existingFeedback.action === "confirmed" &&
      existingFeedback.predictedStatus !== incomingPredictedStatus;
    const pageFeedback = existingFeedback.action === "none" || staleConfirmation
      ? defaultPageFeedback(incoming.baseResult && incoming.baseResult.status)
      : existingFeedback;
    const validation = validateReview({ ...existing, candidates, review });
    const feedbackNeedsReview = pageFeedback.action === "corrected" && (
      !review.reviewedAt ||
      String(review.reviewedAt).localeCompare(String(pageFeedback.at || "")) < 0
    );
    const state = addedCandidate || feedbackNeedsReview
      ? "pending"
      : validation.ready
        ? (existing.state === "exported" ? "exported" : "ready")
        : "pending";
    return applyAutomaticPageConfirmation({
      ...existing,
      captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
      lastSeenAt: incoming.lastSeenAt,
      updatedAt: incoming.updatedAt,
      observationCount: Math.max(1, Number(existing.observationCount) || 1) + 1,
      sampleReason: incoming.sampleReason || existing.sampleReason,
      pageFingerprintHash: incoming.pageFingerprintHash,
      page: incoming.page,
      versions: incoming.versions,
      baseResult: incoming.baseResult,
      candidates,
      pageFeedback,
      review,
      state,
      exportedAt: state === "exported" ? existing.exportedAt : null
    });
  }

  function getCandidateReview(review, candidateId) {
    const values = review && review.candidates;
    if (Array.isArray(values)) {
      return values.find((item) => item && item.candidateId === candidateId) || null;
    }
    return values && typeof values === "object" ? values[candidateId] || null : null;
  }

  function validateEvidence(text, label, evidence) {
    if (label === "irrelevant") {
      return evidence === null || evidence === undefined
        ? { ok: true, value: null }
        : { ok: false, error: "Irrelevant samples cannot have evidence." };
    }
    if (!evidence || typeof evidence !== "object") {
      return { ok: false, error: "Select evidence or use the full passage." };
    }
    const start = Number(evidence.start);
    const end = Number(evidence.end);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > text.length
    ) {
      return { ok: false, error: "Evidence offsets are outside the passage." };
    }
    const exact = text.slice(start, end);
    if (exact !== evidence.text) {
      return { ok: false, error: "Evidence must exactly match the selected passage." };
    }
    return { ok: true, value: { start, end, text: exact } };
  }

  function validateReview(item) {
    const errors = [];
    const review = item && item.review;
    const groupId = clampString(review && review.groupId, MAX_GROUP_ID_LENGTH);
    if (groupId.length < 3) errors.push("Group ID must contain at least 3 characters.");
    const candidates = Array.isArray(item && item.candidates) ? item.candidates : [];
    if (finalPageStatus(item) === "not-job") {
      errors.push("A page marked as not an individual job listing cannot be exported.");
    }
    if (!candidates.length) errors.push("This capture has no candidate passages.");
    candidates.forEach((candidate) => {
      const candidateReview = getCandidateReview(review, candidate.candidateId);
      const label = candidateReview && candidateReview.label;
      if (!LABEL_SET.has(label)) {
        errors.push(`Choose a label for ${candidate.candidateId}.`);
        return;
      }
      const evidenceResult = validateEvidence(
        candidate.text,
        label,
        candidateReview.evidence
      );
      if (!evidenceResult.ok) {
        errors.push(`${candidate.candidateId}: ${evidenceResult.error}`);
      }
    });
    return { ready: errors.length === 0, errors, groupId };
  }

  function applyReview(item, rawReview) {
    if (!item || typeof item !== "object") {
      throw new Error("Capture not found.");
    }
    item = normalizeStoredCapture(item);
    const incoming = rawReview && typeof rawReview === "object" ? rawReview : {};
    const groupId = clampString(incoming.groupId, MAX_GROUP_ID_LENGTH);
    const candidateReviews = {};
    (Array.isArray(item.candidates) ? item.candidates : []).forEach((candidate) => {
      const value = getCandidateReview(incoming, candidate.candidateId);
      if (!value || !LABEL_SET.has(value.label)) return;
      const evidence = value.label === "irrelevant" ? null : value.evidence;
      const evidenceResult = validateEvidence(candidate.text, value.label, evidence);
      candidateReviews[candidate.candidateId] = {
        label: value.label,
        evidence: evidenceResult.ok ? evidenceResult.value : null
      };
    });
    const timestamp = nowIso();
    const next = {
      ...item,
      review: {
        groupId,
        candidates: candidateReviews,
        reviewedAt: null
      },
      updatedAt: timestamp,
      state: "pending",
      exportedAt: null
    };
    const validation = validateReview(next);
    if (validation.ready) {
      next.review.reviewedAt = timestamp;
      next.state = "ready";
    }
    return { item: next, validation };
  }

  function sameEvidence(left, right) {
    if (!left || !right) return left === right;
    return left.start === right.start &&
      left.end === right.end &&
      left.text === right.text;
  }

  function toTrainingRows(items) {
    const rowsByText = new Map();
    const sortedItems = (Array.isArray(items) ? items : [])
      .map(normalizeStoredCapture)
      .filter((item) => validateReview(item).ready)
      .sort((left, right) => {
        const dateOrder = String(left.capturedAt || "")
          .localeCompare(String(right.capturedAt || ""));
        return dateOrder || String(left.captureId).localeCompare(String(right.captureId));
      });

    sortedItems.forEach((item) => {
      item.candidates.forEach((candidate) => {
        const candidateReview = getCandidateReview(item.review, candidate.candidateId);
        const key = normalizeForHash(candidate.text);
        const existing = rowsByText.get(key);
        if (existing) {
          if (existing.label !== candidateReview.label) {
            const error = new Error(
              "Identical passages have conflicting labels. Resolve them before export."
            );
            error.code = "conflicting-labels";
            error.captureIds = [
              existing.metadata.capture_id,
              item.captureId
            ];
            error.labels = [existing.label, candidateReview.label];
            error.textPreview = candidate.text.slice(0, 180);
            throw error;
          }
          existing.metadata.observation_count += Math.max(
            1,
            Number(item.observationCount) || 1
          );
          return;
        }
        const suggestion = candidate.suggestion || {};
        const pageFeedback = normalizePageFeedback(
          item.pageFeedback,
          item.baseResult && item.baseResult.status
        );
        const ruleMatches = candidateReview.label === suggestion.label &&
          sameEvidence(candidateReview.evidence, suggestion.evidence);
        rowsByText.set(key, {
          id: `local-${hashToken(key)}`,
          group_id: item.review.groupId,
          text: candidate.text,
          label: candidateReview.label,
          evidence: candidateReview.evidence,
          source: "sponsorlens_local_review",
          rule_id: ruleMatches ? suggestion.ruleId || null : null,
          verified: true,
          metadata: {
            captured_at: item.capturedAt,
            reviewed_at: item.review.reviewedAt,
            page_origin: item.page && item.page.origin,
            site_family: item.page && item.page.siteFamily,
            analyzer_version: item.versions && item.versions.analyzer,
            candidate_extractor_version:
              item.versions && item.versions.candidateExtractor,
            collector_version: VERSION,
            base_status: item.baseResult && item.baseResult.status,
            suggested_label: suggestion.label || null,
            suggested_rule_id: suggestion.ruleId || null,
            sample_reason: item.sampleReason,
            page_feedback_action: pageFeedback.action,
            page_feedback_status: pageFeedback.selectedStatus,
            page_feedback_source: pageFeedback.source,
            capture_id: item.captureId,
            observation_count: Math.max(1, Number(item.observationCount) || 1)
          }
        });
      });
    });
    return Array.from(rowsByText.values()).sort((left, right) => {
      const dateOrder = String(left.metadata.captured_at || "")
        .localeCompare(String(right.metadata.captured_at || ""));
      return dateOrder || left.id.localeCompare(right.id);
    });
  }

  function exportConflict(row, historicalLabel, captureIds) {
    const error = new Error(
      "This passage has a different label in an earlier export. Resolve the exported dataset before exporting it again."
    );
    error.code = "conflicting-labels";
    error.captureIds = Array.from(new Set(
      (Array.isArray(captureIds) ? captureIds : [row.metadata.capture_id])
        .filter(Boolean)
    ));
    error.labels = [historicalLabel, row.label];
    error.textPreview = row.text.slice(0, 180);
    error.historical = true;
    return error;
  }

  function trainingRowRevisionHash(row) {
    const evidence = row && row.evidence;
    return hashToken(JSON.stringify({
      groupId: row && row.group_id || "",
      label: row && row.label || "",
      evidence: evidence ? {
        start: evidence.start,
        end: evidence.end,
        text: evidence.text
      } : null
    }));
  }

  function addRowsToExportLedger(rawLedger, rows, timestamp) {
    const ledger = normalizeExportLedger(rawLedger);
    const entries = { ...ledger.entries };
    const exportedAt = clampString(timestamp, 40) || nowIso();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (
        !row ||
        !/^local-[a-z0-9]{10,80}$/.test(String(row.id || "")) ||
        !LABEL_SET.has(row.label)
      ) {
        throw new Error("The export contains an invalid training row.");
      }
      const historical = entries[row.id];
      if (historical && historical.label !== row.label) {
        throw exportConflict(row, historical.label);
      }
      const rowHash = trainingRowRevisionHash(row);
      const captureId = row.metadata && row.metadata.capture_id;
      if (!historical) {
        if (Object.keys(entries).length >= MAX_EXPORT_LEDGER_ENTRIES) {
          throw new Error(
            "The local export history is full. Start a new collection profile before exporting more rows."
          );
        }
        entries[row.id] = { label: row.label, exportedAt, rowHash, captureId };
      } else if (
        historical.captureId === captureId &&
        historical.rowHash !== rowHash
      ) {
        entries[row.id] = { label: row.label, exportedAt, rowHash, captureId };
      } else if (!historical.rowHash || !historical.captureId) {
        entries[row.id] = {
          ...historical,
          rowHash: historical.rowHash || rowHash,
          captureId: historical.captureId || captureId
        };
      }
    });
    return normalizeExportLedger({ version: EXPORT_LEDGER_VERSION, entries });
  }

  function planTrainingExport(items, rawLedger) {
    const allItems = Array.isArray(items) ? items : [];
    const exportedItems = allItems.filter((item) => item && item.state === "exported");
    const readyItems = allItems.filter((item) => item && item.state === "ready");
    const historicalRows = toTrainingRows(exportedItems);
    const readyRows = toTrainingRows(readyItems);
    const ledger = addRowsToExportLedger(rawLedger, historicalRows);
    const rows = [];
    let duplicateRowCount = 0;
    let revisionRowCount = 0;
    readyRows.forEach((row) => {
      const historical = ledger.entries[row.id];
      if (!historical) {
        rows.push(row);
        return;
      }
      if (historical.label !== row.label) {
        throw exportConflict(row, historical.label);
      }
      const sameCapture = historical.captureId === row.metadata.capture_id;
      const currentRowHash = trainingRowRevisionHash(row);
      if (sameCapture && historical.rowHash !== currentRowHash) {
        rows.push(row);
        revisionRowCount += 1;
        return;
      }
      duplicateRowCount += 1;
    });
    return {
      rows,
      captureIds: readyItems.map((item) => item.captureId),
      duplicateRowCount,
      revisionRowCount,
      ledger
    };
  }

  function markExported(item, timestamp) {
    if (!validateReview(item).ready) return item;
    item = normalizeStoredCapture(item);
    return {
      ...item,
      state: "exported",
      exportedAt: clampString(timestamp, 40) || nowIso(),
      updatedAt: clampString(timestamp, 40) || nowIso()
    };
  }

  return {
    VERSION,
    CAPTURE_SCHEMA_VERSION,
    ITEM_PREFIX,
    EXPORT_LEDGER_KEY,
    EXPORT_LEDGER_VERSION,
    LAST_EXPORT_KEY,
    LAST_EXPORT_VERSION,
    SETTING_KEY,
    MAX_ITEMS,
    MAX_CANDIDATES,
    MAX_EXPORT_LEDGER_ENTRIES,
    LABELS,
    PAGE_RESULT_STATUSES,
    hashToken,
    normalizeForHash,
    sanitizePage,
    containsSensitiveText,
    defaultPageFeedback,
    normalizePageFeedback,
    finalPageStatus,
    isReviewLocked,
    isTrainableCapture,
    normalizeStoredCapture,
    applyAutomaticPageConfirmation,
    applyPageFeedback,
    getSamplingReason,
    captureFingerprint,
    buildCapture,
    storageKey,
    isItemKey,
    itemsFromStorage,
    emptyExportLedger,
    normalizeExportLedger,
    addRowsToExportLedger,
    trainingRowRevisionHash,
    normalizeExportReceipt,
    createExportReceipt,
    exportReceiptSummary,
    mergeCapture,
    validateReview,
    applyReview,
    toTrainingRows,
    planTrainingExport,
    markExported
  };
});
