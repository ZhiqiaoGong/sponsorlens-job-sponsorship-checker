(function sponsorLensReviewBridgeFactory(root, factory) {
  "use strict";

  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root && root.document) {
    root.SponsorLensReviewBridge = api;
    root.exportPending = api.exportPending;
    root.importReviews = api.importReviews;
    if (root.console && typeof root.console.info === "function") {
      root.console.info(
        "SponsorLens review bridge loaded. Run exportPending() or importReviews()."
      );
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createReviewBridge(root) {
  "use strict";

  const FORMAT = "sponsorlens-review-queue";
  const VERSION = 1;
  const LABELS = new Set(["irrelevant", "no", "conditional", "yes", "review"]);
  const PAGE_STATUSES = new Set([
    "no",
    "conditional",
    "yes",
    "review",
    "unknown",
    "not-job"
  ]);

  function stringValue(value) {
    return String(value || "");
  }

  function candidatesOf(item) {
    return Array.isArray(item && item.candidates) ? item.candidates : [];
  }

  function candidateReview(item, candidateId) {
    const values = item && item.review && item.review.candidates;
    if (Array.isArray(values)) {
      return values.find((value) => value && value.candidateId === candidateId) || null;
    }
    return values && typeof values === "object" ? values[candidateId] || null : null;
  }

  function finalPageStatus(item) {
    const baseStatus = stringValue(item && item.baseResult && item.baseResult.status);
    const feedback = item && item.pageFeedback && typeof item.pageFeedback === "object"
      ? item.pageFeedback
      : {};
    if (
      ["confirmed", "corrected"].includes(feedback.action) &&
      PAGE_STATUSES.has(feedback.selectedStatus)
    ) {
      return feedback.selectedStatus;
    }
    return PAGE_STATUSES.has(baseStatus) ? baseStatus : "unknown";
  }

  function evidenceText(value) {
    return value && value.evidence && typeof value.evidence.text === "string"
      ? value.evidence.text
      : null;
  }

  function createExport(items, exportedAt) {
    const list = Array.isArray(items) ? items : [];
    const pending = list.filter((item) => {
      return item && stringValue(item.state || "pending").toLowerCase() === "pending" &&
        candidatesOf(item).length > 0;
    });
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: exportedAt || new Date().toISOString(),
      instructions: [
        "Edit only apply, groupId, pageResult.finalStatus, and each candidate's label/evidenceText.",
        "Set apply=true only when the entire item is complete and should be imported.",
        "Allowed labels: irrelevant, no, conditional, yes, review.",
        "For irrelevant use evidenceText=null. Every other label needs an exact substring of text.",
        "Use the shortest self-contained evidence. Make it longer if the same substring appears twice.",
        "Allowed finalStatus values: no, conditional, yes, review, unknown, not-job.",
        "Do not change captureId, pageFingerprintHash, candidateId, text, or suggested fields.",
        "Leave apply=false whenever context is insufficient."
      ],
      counts: {
        queueItems: list.length,
        pendingWithPassages: pending.length,
        omitted: list.length - pending.length
      },
      items: pending.map((item) => {
        const currentGroupId = stringValue(item.review && item.review.groupId || item.groupId).trim();
        return {
          apply: false,
          captureId: stringValue(item.captureId),
          pageFingerprintHash: stringValue(item.pageFingerprintHash),
          title: stringValue(item.page && item.page.title),
          origin: stringValue(item.page && item.page.origin),
          groupId: currentGroupId,
          pageResult: {
            scannerStatus: stringValue(item.baseResult && item.baseResult.status) || "unknown",
            finalStatus: finalPageStatus(item)
          },
          candidates: candidatesOf(item).map((candidate, index) => {
            const candidateId = stringValue(candidate && candidate.candidateId || `candidate-${index}`);
            const saved = candidateReview(item, candidateId);
            const suggestion = candidate && candidate.suggestion || {};
            return {
              candidateId,
              text: stringValue(candidate && candidate.text),
              suggestedLabel: LABELS.has(suggestion.label) ? suggestion.label : null,
              suggestedEvidenceText: evidenceText(suggestion),
              label: saved && LABELS.has(saved.label) ? saved.label : null,
              evidenceText: saved && LABELS.has(saved.label) ? evidenceText(saved) : null
            };
          })
        };
      })
    };
  }

  function uniqueEvidence(text, rawEvidence) {
    const evidence = typeof rawEvidence === "string" ? rawEvidence.trim() : "";
    if (!evidence) throw new Error("Evidence text is required.");
    const start = text.indexOf(evidence);
    if (start < 0) throw new Error("Evidence is not an exact substring of the passage.");
    if (text.indexOf(evidence, start + evidence.length) >= 0) {
      throw new Error("Evidence appears more than once; select a longer unique substring.");
    }
    return { start, end: start + evidence.length, text: evidence };
  }

  function validateImportHeader(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("The review file must contain one JSON object.");
    }
    if (payload.format !== FORMAT || Number(payload.version) !== VERSION) {
      throw new Error("This is not a supported SponsorLens review file.");
    }
    if (!Array.isArray(payload.items)) {
      throw new Error("The review file has no items array.");
    }
    return payload;
  }

  function buildReviewAction(current, imported) {
    if (!imported || imported.apply !== true) {
      return { skipped: true, reason: "apply-is-false" };
    }
    if (!current || typeof current !== "object") {
      throw new Error("The capture no longer exists on this device.");
    }
    if (stringValue(current.state || "pending").toLowerCase() !== "pending") {
      return { skipped: true, reason: "capture-is-already-reviewed" };
    }
    if (stringValue(imported.captureId) !== stringValue(current.captureId)) {
      throw new Error("Capture ID does not match.");
    }
    if (stringValue(imported.pageFingerprintHash) !== stringValue(current.pageFingerprintHash)) {
      throw new Error("The captured passage changed after this file was exported.");
    }

    const groupId = stringValue(imported.groupId).trim();
    if (groupId.length < 3 || groupId.length > 120) {
      throw new Error("Group ID must contain 3 to 120 characters.");
    }
    const desiredFinalStatus = stringValue(
      imported.pageResult && imported.pageResult.finalStatus
    );
    if (!PAGE_STATUSES.has(desiredFinalStatus)) {
      throw new Error("Choose a valid final page result.");
    }

    const importedCandidates = Array.isArray(imported.candidates)
      ? imported.candidates
      : [];
    const currentCandidates = candidatesOf(current);
    if (importedCandidates.length !== currentCandidates.length) {
      throw new Error("The candidate count changed after this file was exported.");
    }
    const importedById = new Map();
    importedCandidates.forEach((candidate) => {
      const id = stringValue(candidate && candidate.candidateId);
      if (!id || importedById.has(id)) throw new Error("Candidate IDs are missing or duplicated.");
      importedById.set(id, candidate);
    });

    const reviews = {};
    currentCandidates.forEach((candidate, index) => {
      const candidateId = stringValue(candidate && candidate.candidateId || `candidate-${index}`);
      const importedCandidate = importedById.get(candidateId);
      if (!importedCandidate) throw new Error(`Candidate ${candidateId} is missing.`);
      const text = stringValue(candidate && candidate.text);
      if (stringValue(importedCandidate.text) !== text) {
        throw new Error(`Candidate ${candidateId} text was modified.`);
      }
      const label = stringValue(importedCandidate.label);
      if (!LABELS.has(label)) throw new Error(`Candidate ${candidateId} needs a valid label.`);
      reviews[candidateId] = {
        label,
        evidence: label === "irrelevant"
          ? null
          : uniqueEvidence(text, importedCandidate.evidenceText)
      };
    });

    return {
      skipped: false,
      captureId: stringValue(current.captureId),
      baseStatus: stringValue(current.baseResult && current.baseResult.status) || "unknown",
      currentFinalStatus: finalPageStatus(current),
      desiredFinalStatus,
      review: {
        groupId,
        candidates: reviews,
        reviewedAt: null
      }
    };
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      if (!root || !root.chrome || !root.chrome.runtime || !root.chrome.runtime.sendMessage) {
        reject(new Error("Run this script in the SponsorLens Review page DevTools console."));
        return;
      }
      root.chrome.runtime.sendMessage(message, (response) => {
        if (root.chrome.runtime.lastError) {
          reject(new Error(root.chrome.runtime.lastError.message));
          return;
        }
        if (!response || response.ok !== true) {
          reject(new Error(response && response.error || "SponsorLens rejected the request."));
          return;
        }
        resolve(response);
      });
    });
  }

  function downloadJson(payload) {
    const blob = new root.Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: "application/json"
    });
    const url = root.URL.createObjectURL(blob);
    const anchor = root.document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = `sponsorlens-review-queue-${stamp}.json`;
    anchor.click();
    root.setTimeout(() => root.URL.revokeObjectURL(url), 1000);
  }

  async function exportPending() {
    const response = await runtimeMessage({ type: "SPONSORLENS_COLLECTION_LIST" });
    const payload = createExport(response.items);
    downloadJson(payload);
    if (root.console && typeof root.console.info === "function") {
      root.console.info(
        `Downloaded ${payload.items.length} Pending SponsorLens review item(s).`
      );
    }
    return payload;
  }

  function chooseJsonFile() {
    return new Promise((resolve, reject) => {
      const input = root.document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        if (file) resolve(file);
        else reject(new Error("No review file was selected."));
      }, { once: true });
      input.click();
    });
  }

  async function parseReviewInput(input) {
    let value = input;
    if (value === undefined || value === null) value = await chooseJsonFile();
    if (typeof value === "string") return validateImportHeader(JSON.parse(value));
    if (value && typeof value.text === "function") {
      return validateImportHeader(JSON.parse(await value.text()));
    }
    return validateImportHeader(value);
  }

  async function applyReviewAction(action) {
    if (action.desiredFinalStatus !== action.currentFinalStatus) {
      const restoreBase = action.desiredFinalStatus === action.baseStatus;
      await runtimeMessage({
        type: "SPONSORLENS_COLLECTION_PAGE_RESULT_UPDATE",
        captureId: action.captureId,
        action: restoreBase ? "clear" : "corrected",
        ...(restoreBase ? {} : { selectedStatus: action.desiredFinalStatus })
      });
    }
    if (action.desiredFinalStatus === "not-job") {
      return { ready: false, diagnostic: true };
    }
    const response = await runtimeMessage({
      type: "SPONSORLENS_COLLECTION_UPDATE",
      captureId: action.captureId,
      review: action.review
    });
    if (response.ready !== true) {
      throw new Error(
        Array.isArray(response.errors) && response.errors.length
          ? response.errors.join(" ")
          : "The imported review is incomplete."
      );
    }
    return { ready: true, diagnostic: false };
  }

  async function importReviews(input) {
    const payload = await parseReviewInput(input);
    const response = await runtimeMessage({ type: "SPONSORLENS_COLLECTION_LIST" });
    const currentById = new Map(
      (Array.isArray(response.items) ? response.items : [])
        .map((item) => [stringValue(item && item.captureId), item])
    );
    const summary = {
      requested: 0,
      ready: 0,
      diagnostic: 0,
      skipped: 0,
      failed: 0,
      errors: []
    };

    for (const imported of payload.items) {
      if (!imported || imported.apply !== true) {
        summary.skipped += 1;
        continue;
      }
      summary.requested += 1;
      const captureId = stringValue(imported.captureId);
      try {
        const action = buildReviewAction(currentById.get(captureId), imported);
        if (action.skipped) {
          summary.skipped += 1;
          continue;
        }
        const result = await applyReviewAction(action);
        if (result.ready) summary.ready += 1;
        if (result.diagnostic) summary.diagnostic += 1;
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({ captureId, error: error && error.message || String(error) });
      }
    }

    if (root.console && typeof root.console.table === "function" && summary.errors.length) {
      root.console.table(summary.errors);
    }
    if (root.console && typeof root.console.info === "function") {
      root.console.info("SponsorLens review import finished:", summary);
    }
    return summary;
  }

  return {
    FORMAT,
    VERSION,
    createExport,
    buildReviewAction,
    exportPending,
    importReviews
  };
});
