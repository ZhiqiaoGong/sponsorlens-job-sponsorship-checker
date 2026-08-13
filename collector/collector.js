(function sponsorLensCollectorReviewPage() {
  "use strict";

  const collector = globalThis.SponsorLensCollector;
  const LABEL_META = {
    irrelevant: {
      name: "Not relevant",
      short: "Not sponsorship",
      color: "#64748b",
      description: "The passage is unrelated to job sponsorship."
    },
    no: {
      name: "No sponsorship",
      short: "Unavailable",
      color: "#dc2626",
      description: "The passage says sponsorship is unavailable."
    },
    conditional: {
      name: "Conditional",
      short: "Has conditions",
      color: "#d97706",
      description: "The passage answers the question, but only with conditions."
    },
    yes: {
      name: "Available",
      short: "Explicit support",
      color: "#15803d",
      description: "The passage explicitly offers sponsorship or visa support."
    },
    review: {
      name: "Needs review",
      short: "No clear answer",
      color: "#ca8a04",
      description: "The passage is related, but does not answer the sponsorship question."
    }
  };
  const FILTERS = ["all", "pending", "ready", "exported"];

  const elements = {
    capacityCard: document.querySelector(".capacity-card"),
    capacityTrack: document.getElementById("capacityTrack"),
    capacityBar: document.getElementById("capacityBar"),
    capacityText: document.getElementById("capacityText"),
    capacityHint: document.getElementById("capacityHint"),
    exportButton: document.getElementById("exportButton"),
    lastExportButton: document.getElementById("lastExportButton"),
    clearButton: document.getElementById("clearButton"),
    refreshButton: document.getElementById("refreshButton"),
    filters: document.getElementById("filters"),
    countAll: document.getElementById("countAll"),
    countPending: document.getElementById("countPending"),
    countReady: document.getElementById("countReady"),
    countExported: document.getElementById("countExported"),
    visibleCount: document.getElementById("visibleCount"),
    queueList: document.getElementById("queueList"),
    queueEmpty: document.getElementById("queueEmpty"),
    queueEmptyTitle: document.getElementById("queueEmptyTitle"),
    queueEmptyText: document.getElementById("queueEmptyText"),
    loadingState: document.getElementById("loadingState"),
    errorState: document.getElementById("errorState"),
    errorMessage: document.getElementById("errorMessage"),
    retryButton: document.getElementById("retryButton"),
    noSelectionState: document.getElementById("noSelectionState"),
    noSelectionTitle: document.getElementById("noSelectionTitle"),
    noSelectionText: document.getElementById("noSelectionText"),
    reviewDetail: document.getElementById("reviewDetail"),
    detailStatus: document.getElementById("detailStatus"),
    detailPosition: document.getElementById("detailPosition"),
    detailPageTitle: document.getElementById("detailPageTitle"),
    detailMeta: document.getElementById("detailMeta"),
    pageResultCard: document.getElementById("pageResultCard"),
    finalPageResult: document.getElementById("finalPageResult"),
    scannerPageResult: document.getElementById("scannerPageResult"),
    pageResultSource: document.getElementById("pageResultSource"),
    changePageResultButton: document.getElementById("changePageResultButton"),
    resetPageResultButton: document.getElementById("resetPageResultButton"),
    pageResultEditor: document.getElementById("pageResultEditor"),
    pageResultSelect: document.getElementById("pageResultSelect"),
    savePageResultButton: document.getElementById("savePageResultButton"),
    cancelPageResultButton: document.getElementById("cancelPageResultButton"),
    feedbackOnly: document.getElementById("feedbackOnly"),
    feedbackOnlyTitle: document.getElementById("feedbackOnlyTitle"),
    feedbackOnlyText: document.getElementById("feedbackOnlyText"),
    groupField: document.getElementById("groupField"),
    groupIdInput: document.getElementById("groupIdInput"),
    candidateHeading: document.getElementById("candidateHeading"),
    candidateProgress: document.getElementById("candidateProgress"),
    candidateList: document.getElementById("candidateList"),
    validationMessage: document.getElementById("validationMessage"),
    saveButton: document.getElementById("saveButton"),
    detailActions: document.getElementById("detailActions"),
    deleteButton: document.getElementById("deleteButton"),
    notice: document.getElementById("notice"),
    noticeText: document.getElementById("noticeText"),
    dismissNoticeButton: document.getElementById("dismissNoticeButton"),
    liveStatus: document.getElementById("liveStatus"),
    deleteDialog: document.getElementById("deleteDialog"),
    confirmDeleteButton: document.getElementById("confirmDeleteButton"),
    clearDialog: document.getElementById("clearDialog"),
    clearDialogText: document.getElementById("clearDialogText"),
    clearConfirmCheck: document.getElementById("clearConfirmCheck"),
    confirmClearButton: document.getElementById("confirmClearButton")
  };

  const state = {
    items: [],
    maxItems: collector && Number(collector.MAX_ITEMS) || 0,
    lastExport: null,
    filter: "all",
    selectedId: null,
    drafts: new Map(),
    dirtyIds: new Set(),
    saveAttemptedIds: new Set(),
    pendingDeleteId: null,
    editingPageResultId: null,
    busy: false,
    loaded: false,
    noticeTimer: null,
    storageRefreshTimer: null,
    storageRefreshPending: false
  };

  const labels = collector && Array.isArray(collector.LABELS)
    ? collector.LABELS.filter((label) => Object.hasOwn(LABEL_META, label))
    : Object.keys(LABEL_META);

  function captureId(item) {
    return String(item && item.captureId || "");
  }

  function candidatesOf(item) {
    return Array.isArray(item && item.candidates) ? item.candidates : [];
  }

  function hasCandidatePassages(item) {
    return candidatesOf(item).length > 0;
  }

  function pageFeedbackOf(item) {
    const feedback = item && item.pageFeedback && typeof item.pageFeedback === "object"
      ? item.pageFeedback
      : {};
    const action = ["confirmed", "corrected"].includes(feedback.action)
      ? feedback.action
      : "none";
    return {
      action,
      predictedStatus: String(feedback.predictedStatus || ""),
      selectedStatus: String(feedback.selectedStatus || ""),
      source: ["automatic", "indicator"].includes(feedback.source)
        ? feedback.source
        : ""
    };
  }

  function isTrainable(item) {
    if (collector && typeof collector.isTrainableCapture === "function") {
      return collector.isTrainableCapture(item);
    }
    return hasCandidatePassages(item) && finalPageStatus(item) !== "not-job";
  }

  function feedbackPriority(item) {
    const feedback = pageFeedbackOf(item);
    if (feedback.action === "corrected") return 0;
    if (feedback.action === "confirmed" && feedback.source === "indicator") return 1;
    if (feedback.action === "confirmed") return 2;
    return 2;
  }

  function sortByFeedback(items) {
    return items
      .map((item, index) => ({ item, index }))
      .sort((left, right) => {
        return feedbackPriority(left.item) - feedbackPriority(right.item) ||
          left.index - right.index;
      })
      .map((entry) => entry.item);
  }

  function candidateId(candidate, index) {
    return String(candidate && candidate.candidateId || `candidate-${index}`);
  }

  function itemState(item) {
    if (!isTrainable(item)) return "pending";
    const value = String(item && item.state || "pending").toLowerCase();
    return FILTERS.includes(value) && value !== "all" ? value : "pending";
  }

  function statusName(value) {
    if (value === "ready") return "Ready";
    if (value === "exported") return "Exported";
    return "Pending";
  }

  function cloneEvidence(value) {
    if (!value || typeof value !== "object") return null;
    return {
      start: Number(value.start),
      end: Number(value.end),
      text: String(value.text || "")
    };
  }

  function exactEvidence(text, evidence) {
    if (!evidence || typeof evidence !== "object") return null;
    const start = Number(evidence.start);
    const end = Number(evidence.end);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > text.length ||
      text.slice(start, end) !== evidence.text
    ) {
      return null;
    }
    return { start, end, text: text.slice(start, end) };
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        reject(new Error("The SponsorLens extension runtime is unavailable."));
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response || response.ok !== true) {
            const error = new Error(
              response && (response.error || response.message) ||
              "SponsorLens did not accept the request."
            );
            ["code", "captureIds", "labels", "textPreview", "historical"].forEach((key) => {
              if (response && response[key] !== undefined) error[key] = response[key];
            });
            reject(error);
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function setNotice(message, type, timeout) {
    clearTimeout(state.noticeTimer);
    elements.noticeText.textContent = String(message || "");
    elements.notice.classList.remove("hidden", "success", "warning", "error");
    if (["success", "warning", "error"].includes(type)) {
      elements.notice.classList.add(type);
    }
    elements.liveStatus.textContent = String(message || "");
    if (timeout) {
      state.noticeTimer = setTimeout(clearNotice, timeout);
    }
  }

  function clearNotice() {
    clearTimeout(state.noticeTimer);
    elements.notice.classList.add("hidden");
    elements.notice.classList.remove("success", "warning", "error");
  }

  function setPanel(name) {
    elements.loadingState.classList.toggle("hidden", name !== "loading");
    elements.errorState.classList.toggle("hidden", name !== "error");
    elements.noSelectionState.classList.toggle("hidden", name !== "empty");
    elements.reviewDetail.classList.toggle("hidden", name !== "detail");
  }

  function setBusy(value) {
    state.busy = Boolean(value);
    const selected = currentItem();
    const canReview = Boolean(selected && isTrainable(selected));
    const readyCount = state.items.filter((item) => {
      return isTrainable(item) && itemState(item) === "ready";
    }).length;
    elements.exportButton.disabled = state.busy || readyCount === 0;
    elements.lastExportButton.disabled = state.busy || !state.lastExport;
    elements.clearButton.disabled = state.busy || (
      state.items.length === 0 && !state.lastExport
    );
    elements.refreshButton.disabled = state.busy;
    elements.saveButton.disabled = state.busy || !state.selectedId || !canReview;
    elements.deleteButton.disabled = state.busy || !state.selectedId;
    elements.groupIdInput.disabled = state.busy || !canReview;
    elements.changePageResultButton.disabled = state.busy || !state.selectedId;
    elements.resetPageResultButton.disabled = state.busy || !state.selectedId;
    elements.pageResultSelect.disabled = state.busy || !state.selectedId;
    elements.savePageResultButton.disabled = state.busy || !state.selectedId;
    elements.cancelPageResultButton.disabled = state.busy || !state.selectedId;
  }

  function createDraft(item) {
    const review = item && item.review && typeof item.review === "object"
      ? item.review
      : {};
    const savedCandidates = review.candidates && typeof review.candidates === "object"
      ? review.candidates
      : {};
    const candidateReviews = {};
    candidatesOf(item).forEach((candidate, index) => {
      const id = candidateId(candidate, index);
      const saved = savedCandidates[id] && typeof savedCandidates[id] === "object"
        ? savedCandidates[id]
        : {};
      const label = labels.includes(saved.label) ? saved.label : null;
      candidateReviews[id] = {
        label,
        evidence: label === "irrelevant"
          ? null
          : cloneEvidence(saved.evidence),
        localError: ""
      };
    });
    return {
      groupId: String(review.groupId || ""),
      candidates: candidateReviews
    };
  }

  function draftFor(item) {
    const id = captureId(item);
    if (!state.drafts.has(id)) state.drafts.set(id, createDraft(item));
    return state.drafts.get(id);
  }

  function markDirty(item) {
    state.dirtyIds.add(captureId(item));
  }

  function currentItem() {
    return state.items.find((item) => captureId(item) === state.selectedId) || null;
  }

  function filteredItems() {
    const visible = state.filter === "all"
      ? state.items.slice()
      : state.items.filter((item) => itemState(item) === state.filter);
    return sortByFeedback(visible);
  }

  function formatDate(value) {
    const date = new Date(String(value || ""));
    if (!Number.isFinite(date.getTime())) return "Unknown time";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  }

  function sentenceCase(value) {
    return String(value || "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function resultStatusName(value) {
    const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");
    const names = {
      no: "No sponsorship",
      conditional: "Conditional sponsorship",
      yes: "Sponsorship available",
      review: "Needs review",
      unclear: "Needs review",
      unknown: "Not mentioned",
      "no-info": "Not mentioned",
      "not-mentioned": "Not mentioned",
      "not-job": "Not an individual job listing",
      "not-a-job": "Not an individual job listing"
    };
    return names[normalized] || sentenceCase(normalized);
  }

  function scannerPageStatus(item) {
    const value = item && item.baseResult && item.baseResult.status;
    return String(value || "unknown").trim().toLowerCase().replace(/_/g, "-");
  }

  function finalPageStatus(item) {
    if (collector && typeof collector.finalPageStatus === "function") {
      return collector.finalPageStatus(item);
    }
    const feedback = pageFeedbackOf(item);
    return feedback.action === "none"
      ? scannerPageStatus(item)
      : feedback.selectedStatus || scannerPageStatus(item);
  }

  function pageResultProvenance(item, short) {
    const feedback = pageFeedbackOf(item);
    if (feedback.action === "corrected") {
      return short ? "Corrected" : "Corrected by you";
    }
    if (feedback.action === "confirmed" && feedback.source === "indicator") {
      return short ? "Confirmed" : "Confirmed by you";
    }
    return short ? "Assumed" : "Assumed correct";
  }

  function feedbackSummary(item) {
    return `Final result: ${resultStatusName(finalPageStatus(item))} · ${pageResultProvenance(item, true)}`;
  }

  function itemTitle(item) {
    const title = String(item && item.page && item.page.title || "").trim();
    return title || "Collected job example";
  }

  function itemOrigin(item) {
    const origin = String(item && item.page && item.page.origin || "").trim();
    const site = String(item && item.page && item.page.siteFamily || "").trim();
    return site || origin || "Unknown source";
  }

  function queueSnippet(item) {
    if (finalPageStatus(item) === "not-job") {
      return "Excluded because this is not an individual job listing.";
    }
    if (!hasCandidatePassages(item)) {
      return "Correction saved for diagnostics; no trainable passage.";
    }
    const candidate = candidatesOf(item)[0];
    return String(candidate && candidate.text || "No candidate passage available.");
  }

  function updateCapacity() {
    const maximum = Math.max(0, Number(state.maxItems) || 0);
    const count = state.items.length;
    const ratio = maximum > 0 ? count / maximum : 0;
    const percent = Math.min(100, Math.max(0, ratio * 100));
    elements.capacityText.textContent = `${count} / ${maximum || "—"}`;
    elements.capacityBar.style.width = `${percent}%`;
    elements.capacityTrack.setAttribute("aria-valuemax", String(maximum));
    elements.capacityTrack.setAttribute("aria-valuenow", String(count));
    elements.capacityCard.classList.toggle("warning", maximum > 0 && ratio >= .8 && ratio < 1);
    elements.capacityCard.classList.toggle("full", maximum > 0 && ratio >= 1);
    if (!maximum) {
      elements.capacityHint.textContent = "Queue capacity is unavailable.";
    } else if (ratio >= 1) {
      elements.capacityHint.textContent = "The queue is full. Delete examples to make room for new passages; exporting keeps the local copies.";
    } else if (ratio >= .8) {
      elements.capacityHint.textContent = `${maximum - count} spaces remain. Review or export examples soon.`;
    } else {
      elements.capacityHint.textContent = `${maximum - count} spaces remain. New examples are never allowed to overwrite this queue.`;
    }
  }

  function updateCounts() {
    const counts = { all: state.items.length, pending: 0, ready: 0, exported: 0 };
    state.items.forEach((item) => {
      counts[itemState(item)] += 1;
    });
    elements.countAll.textContent = String(counts.all);
    elements.countPending.textContent = String(counts.pending);
    elements.countReady.textContent = String(counts.ready);
    elements.countExported.textContent = String(counts.exported);
    elements.exportButton.textContent = `Export ready (${counts.ready})`;
    elements.exportButton.disabled = state.busy || counts.ready === 0;
    elements.clearButton.disabled = state.busy || (counts.all === 0 && !state.lastExport);
  }

  function makeStatusPill(value, unsaved) {
    const pill = document.createElement("span");
    pill.className = `status-pill ${value}`;
    pill.textContent = unsaved ? "Unsaved" : statusName(value);
    if (unsaved) pill.classList.remove(value);
    return pill;
  }

  function renderQueue() {
    const visible = filteredItems();
    if (!visible.some((item) => captureId(item) === state.selectedId)) {
      state.selectedId = visible[0] ? captureId(visible[0]) : null;
    }

    elements.queueList.replaceChildren();
    visible.forEach((item) => {
      const id = captureId(item);
      const value = itemState(item);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "queue-item";
      button.classList.toggle("selected", id === state.selectedId);
      button.setAttribute("aria-current", id === state.selectedId ? "true" : "false");
      button.dataset.captureId = id;

      const top = document.createElement("span");
      top.className = "queue-item-top";
      const title = document.createElement("strong");
      title.textContent = itemTitle(item);
      top.append(title, makeStatusPill(value, state.dirtyIds.has(id)));

      const snippet = document.createElement("span");
      snippet.className = "queue-item-snippet";
      snippet.textContent = queueSnippet(item);

      const feedbackText = feedbackSummary(item);
      const feedbackValue = pageFeedbackOf(item);
      const feedback = document.createElement("span");
      feedback.className = [
        "queue-item-feedback",
        feedbackValue.action,
        feedbackValue.source,
        `result-${finalPageStatus(item)}`
      ].filter(Boolean).join(" ");
      feedback.textContent = feedbackText;
      feedback.classList.toggle("hidden", !feedbackText);

      const meta = document.createElement("span");
      meta.className = "queue-item-meta";
      const origin = document.createElement("span");
      origin.textContent = itemOrigin(item);
      const count = document.createElement("span");
      const size = candidatesOf(item).length;
      count.textContent = size
        ? `${size} passage${size === 1 ? "" : "s"}`
        : "Diagnostic only";
      meta.append(origin, count);
      button.append(top, snippet, feedback, meta);
      button.addEventListener("click", () => {
        state.selectedId = id;
        state.editingPageResultId = null;
        state.saveAttemptedIds.delete(id);
        renderQueue();
        renderDetail();
      });
      elements.queueList.append(button);
    });

    const hasVisible = visible.length > 0;
    elements.queueList.classList.toggle("hidden", !hasVisible);
    elements.queueEmpty.classList.toggle("hidden", hasVisible);
    elements.visibleCount.textContent = `${visible.length} example${visible.length === 1 ? "" : "s"}`;
    if (!state.items.length) {
      elements.queueEmptyTitle.textContent = "No examples yet";
      elements.queueEmptyText.textContent = "Collected observations will appear here after local collection is enabled.";
    } else if (!hasVisible) {
      elements.queueEmptyTitle.textContent = `No ${state.filter} examples`;
      elements.queueEmptyText.textContent = "Choose another filter to continue reviewing the queue.";
    }
  }

  function candidateValidation(candidate, draftCandidate) {
    const text = String(candidate && candidate.text || "");
    const label = draftCandidate && draftCandidate.label;
    if (!labels.includes(label)) return { complete: false, error: "Choose a label." };
    if (label === "irrelevant") {
      return draftCandidate.evidence === null
        ? { complete: true, error: "" }
        : { complete: false, error: "Not relevant passages cannot have evidence." };
    }
    const evidence = exactEvidence(text, draftCandidate.evidence);
    return evidence
      ? { complete: true, error: "", evidence }
      : { complete: false, error: "Select exact evidence or use the full passage." };
  }

  function selectionEvidence(container, text) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount < 1 || selection.isCollapsed) {
      return { error: "Select words in the passage first." };
    }
    const range = selection.getRangeAt(0);
    const startNode = range.startContainer.nodeType === 1
      ? range.startContainer
      : range.startContainer.parentNode;
    const endNode = range.endContainer.nodeType === 1
      ? range.endContainer
      : range.endContainer.parentNode;
    if (
      !startNode ||
      !endNode ||
      !(startNode === container || container.contains(startNode)) ||
      !(endNode === container || container.contains(endNode))
    ) {
      return { error: "Keep the selection inside this passage." };
    }
    const prefix = range.cloneRange();
    prefix.selectNodeContents(container);
    prefix.setEnd(range.startContainer, range.startOffset);
    let start = prefix.toString().length;
    let end = start + range.toString().length;
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    if (end <= start) return { error: "Select at least one non-space character." };
    const evidence = { start, end, text: text.slice(start, end) };
    selection.removeAllRanges();
    return { evidence };
  }

  function renderPassage(container, text, evidence) {
    container.replaceChildren();
    const exact = exactEvidence(text, evidence);
    if (!exact) {
      container.textContent = text;
      return;
    }
    container.append(document.createTextNode(text.slice(0, exact.start)));
    const mark = document.createElement("mark");
    mark.textContent = exact.text;
    container.append(mark, document.createTextNode(text.slice(exact.end)));
  }

  function refreshCandidate(item, id) {
    const candidates = candidatesOf(item);
    const index = candidates.findIndex((candidate, position) => {
      return candidateId(candidate, position) === id;
    });
    if (index < 0) return;
    const current = Array.from(elements.candidateList.children).find((node) => {
      return node.dataset && node.dataset.candidateId === id;
    });
    if (!current) {
      renderDetail();
      return;
    }
    const top = current.getBoundingClientRect().top;
    const replacement = makeCandidateCard(item, candidates[index], index);
    current.replaceWith(replacement);
    const nextTop = replacement.getBoundingClientRect().top;
    window.scrollBy(0, nextTop - top);
    updateCandidateSummary(item);
  }

  function makeCandidateCard(item, candidate, index) {
    const id = candidateId(candidate, index);
    const text = String(candidate && candidate.text || "");
    const draft = draftFor(item);
    const value = draft.candidates[id] || {
      label: null,
      evidence: null,
      localError: ""
    };
    draft.candidates[id] = value;
    const validation = candidateValidation(candidate, value);
    const suggestion = candidate && candidate.suggestion || {};
    const chosenMeta = LABEL_META[value.label] || LABEL_META.irrelevant;

    const card = document.createElement("section");
    card.className = "candidate-card";
    card.dataset.candidateId = id;
    card.style.setProperty("--label-color", chosenMeta.color);
    card.classList.toggle("complete", validation.complete);
    card.classList.toggle(
      "invalid",
      Boolean(value.localError) ||
      (state.saveAttemptedIds.has(captureId(item)) && !validation.complete)
    );

    const header = document.createElement("header");
    header.className = "candidate-card-header";
    const number = document.createElement("span");
    number.className = "candidate-number";
    number.textContent = `Passage ${index + 1} of ${candidatesOf(item).length}`;
    const suggestionPill = document.createElement("span");
    suggestionPill.className = "suggestion-pill";
    suggestionPill.textContent = labels.includes(suggestion.label)
      ? `Rule suggestion: ${LABEL_META[suggestion.label].name}`
      : "No rule suggestion";
    header.append(number, suggestionPill);

    const body = document.createElement("div");
    body.className = "candidate-body";
    const passageLabel = document.createElement("div");
    passageLabel.className = "passage-label";
    const passageTitle = document.createElement("span");
    passageTitle.textContent = "Passage";
    const selectionHint = document.createElement("span");
    selectionHint.textContent = "Select exact supporting words";
    passageLabel.append(passageTitle, selectionHint);

    const passage = document.createElement("div");
    passage.className = "candidate-passage";
    passage.tabIndex = 0;
    passage.setAttribute("aria-label", `Candidate passage ${index + 1}`);
    renderPassage(passage, text, value.evidence);

    const evidenceTools = document.createElement("div");
    evidenceTools.className = "evidence-tools";
    const useSelection = document.createElement("button");
    useSelection.type = "button";
    useSelection.className = "tool-button";
    useSelection.textContent = "Use selection";
    useSelection.disabled = value.label === "irrelevant";
    useSelection.addEventListener("mousedown", (event) => event.preventDefault());
    useSelection.addEventListener("click", () => {
      const result = selectionEvidence(passage, text);
      if (result.error) {
        value.localError = result.error;
      } else {
        value.evidence = result.evidence;
        value.localError = "";
        markDirty(item);
      }
      refreshCandidate(item, id);
      renderQueue();
    });

    const useFull = document.createElement("button");
    useFull.type = "button";
    useFull.className = "tool-button";
    useFull.textContent = "Use full passage";
    useFull.disabled = value.label === "irrelevant" || text.length === 0;
    useFull.addEventListener("click", () => {
      value.evidence = { start: 0, end: text.length, text };
      value.localError = "";
      markDirty(item);
      refreshCandidate(item, id);
      renderQueue();
    });

    const clearEvidence = document.createElement("button");
    clearEvidence.type = "button";
    clearEvidence.className = "tool-button";
    clearEvidence.textContent = "Clear evidence";
    clearEvidence.disabled = value.label === "irrelevant" || !value.evidence;
    clearEvidence.addEventListener("click", () => {
      value.evidence = null;
      value.localError = "";
      markDirty(item);
      refreshCandidate(item, id);
      renderQueue();
    });

    const evidenceSummary = document.createElement("span");
    evidenceSummary.className = "evidence-summary";
    const selectedEvidence = exactEvidence(text, value.evidence);
    if (value.label === "irrelevant") {
      evidenceSummary.textContent = "Evidence is not required";
    } else if (selectedEvidence) {
      evidenceSummary.classList.add("ready");
      evidenceSummary.textContent = `Evidence: characters ${selectedEvidence.start}–${selectedEvidence.end}`;
    } else {
      evidenceSummary.textContent = "No evidence selected";
    }
    evidenceTools.append(useSelection, useFull, clearEvidence, evidenceSummary);

    const labelHeading = document.createElement("div");
    labelHeading.className = "label-heading";
    labelHeading.textContent = "Label";
    const labelOptions = document.createElement("div");
    labelOptions.className = "label-options";
    labelOptions.setAttribute("role", "radiogroup");
    labelOptions.setAttribute("aria-label", `Label for passage ${index + 1}`);

    labels.forEach((label) => {
      const meta = LABEL_META[label];
      const option = document.createElement("label");
      option.className = "label-option";
      option.style.setProperty("--label-option-color", meta.color);
      option.title = meta.description;
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `label-${captureId(item)}-${id}`;
      input.value = label;
      input.checked = value.label === label;
      const visual = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = meta.name;
      const short = document.createElement("small");
      short.textContent = meta.short;
      visual.append(name, short);
      input.addEventListener("change", () => {
        if (!input.checked) return;
        value.label = label;
        value.localError = "";
        if (label === "irrelevant") {
          value.evidence = null;
        } else if (!exactEvidence(text, value.evidence)) {
          const suggestedEvidence = label === suggestion.label
            ? exactEvidence(text, suggestion.evidence)
            : null;
          value.evidence = suggestedEvidence;
        }
        markDirty(item);
        refreshCandidate(item, id);
        renderQueue();
      });
      option.append(input, visual);
      labelOptions.append(option);
    });

    const error = document.createElement("p");
    error.className = "candidate-error";
    error.setAttribute("role", "status");
    error.textContent = value.localError || (
      state.saveAttemptedIds.has(captureId(item)) ? validation.error : ""
    );

    body.append(
      passageLabel,
      passage,
      evidenceTools,
      labelHeading,
      labelOptions,
      error
    );
    card.append(header, body);
    return card;
  }

  function updateCandidateSummary(item) {
    const draft = draftFor(item);
    const candidates = candidatesOf(item);
    const complete = candidates.filter((candidate, index) => {
      const value = draft.candidates[candidateId(candidate, index)];
      return candidateValidation(candidate, value).complete;
    }).length;
    if (!candidates.length) {
      elements.candidateProgress.textContent = "Not trainable";
      elements.validationMessage.textContent = "A diagnostic correction without a passage cannot be marked Ready or exported.";
      elements.validationMessage.classList.remove("error");
      elements.groupField.classList.remove("invalid");
      return false;
    }
    elements.candidateProgress.textContent = `${complete} of ${candidates.length} complete`;
    const groupValid = draft.groupId.trim().length >= 3;
    const allReady = groupValid && complete === candidates.length && candidates.length > 0;
    elements.validationMessage.classList.toggle(
      "error",
      state.saveAttemptedIds.has(captureId(item)) && !allReady
    );
    if (allReady) {
      elements.validationMessage.textContent = "Ready to save. Export remains a separate action.";
    } else if (!groupValid && state.saveAttemptedIds.has(captureId(item))) {
      elements.validationMessage.textContent = "Enter a Group ID with at least 3 characters.";
    } else {
      const remaining = candidates.length - complete;
      elements.validationMessage.textContent = remaining
        ? `${remaining} passage${remaining === 1 ? "" : "s"} still need a valid label and evidence.`
        : "Review the Group ID before saving.";
    }
    elements.groupField.classList.toggle(
      "invalid",
      state.saveAttemptedIds.has(captureId(item)) && !groupValid
    );
    return allReady;
  }

  function renderDetail() {
    const item = currentItem();
    if (!item) {
      setPanel("empty");
      elements.noSelectionTitle.textContent = state.items.length
        ? `No ${state.filter} example selected`
        : "The review queue is empty";
      elements.noSelectionText.textContent = state.items.length
        ? "Choose another filter or select an item from the queue."
        : "New locally collected passages will appear here.";
      return;
    }
    setPanel("detail");
    const value = itemState(item);
    const position = filteredItems().findIndex((entry) => captureId(entry) === captureId(item));
    const draft = draftFor(item);
    const trainable = isTrainable(item);
    const hasPassages = hasCandidatePassages(item);
    elements.detailStatus.className = `status-pill ${value}`;
    elements.detailStatus.textContent = statusName(value);
    elements.detailPosition.textContent = `Example ${position + 1} of ${filteredItems().length}`;
    elements.detailPageTitle.textContent = itemTitle(item);
    const details = [
      itemOrigin(item),
      formatDate(item.capturedAt),
      sentenceCase(item.sampleReason)
    ].filter(Boolean);
    elements.detailMeta.textContent = details.join(" · ");
    const feedbackValue = pageFeedbackOf(item);
    const finalStatus = finalPageStatus(item);
    elements.pageResultCard.className = `page-result-card result-${finalStatus}`;
    elements.finalPageResult.textContent = resultStatusName(finalStatus);
    elements.scannerPageResult.textContent = resultStatusName(scannerPageStatus(item));
    elements.pageResultSource.textContent = pageResultProvenance(item, false);
    elements.resetPageResultButton.classList.toggle(
      "hidden",
      feedbackValue.action !== "corrected"
    );
    const editingPageResult = state.editingPageResultId === captureId(item);
    elements.pageResultEditor.classList.toggle("hidden", !editingPageResult);
    elements.changePageResultButton.classList.toggle("hidden", editingPageResult);
    if (editingPageResult) elements.pageResultSelect.value = finalStatus;
    elements.feedbackOnly.classList.toggle("hidden", trainable);
    if (finalStatus === "not-job") {
      elements.feedbackOnlyTitle.textContent = "Excluded from training export";
      elements.feedbackOnlyText.textContent = hasPassages
        ? "This record is marked as not an individual job listing. Its passages are kept for diagnostics, but it cannot be marked Ready or exported. Use Change result if this was a real job listing."
        : "This record is marked as not an individual job listing and has no trainable passage. You can keep it for diagnostics or delete it.";
    } else {
      elements.feedbackOnlyTitle.textContent = "Correction saved for diagnostics; no trainable passage";
      elements.feedbackOnlyText.textContent = "This page-level correction can help evaluate detection, but it cannot be marked Ready or included in a training export. You can keep it for reference or delete it.";
    }
    elements.groupField.classList.toggle("hidden", !trainable);
    elements.candidateHeading.classList.toggle("hidden", !trainable);
    elements.candidateList.classList.toggle("hidden", !trainable);
    elements.detailActions.classList.toggle("hidden", !trainable);
    elements.groupIdInput.value = draft.groupId;
    elements.candidateList.replaceChildren();
    candidatesOf(item).forEach((candidate, index) => {
      elements.candidateList.append(makeCandidateCard(item, candidate, index));
    });
    updateCandidateSummary(item);
    setBusy(state.busy);
  }

  function renderAll() {
    updateCapacity();
    updateCounts();
    elements.filters.querySelectorAll("[data-filter]").forEach((button) => {
      const selected = button.dataset.filter === state.filter;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
    renderQueue();
    renderDetail();
    setBusy(state.busy);
  }

  async function loadQueue(options) {
    const settings = options || {};
    setBusy(true);
    if (!state.loaded) setPanel("loading");
    try {
      const response = await runtimeMessage({ type: "SPONSORLENS_COLLECTION_LIST" });
      const incomingItems = Array.isArray(response.items)
        ? response.items.filter((item) => item && captureId(item))
        : [];
      const previousItems = new Map(state.items.map((item) => [captureId(item), item]));
      const items = incomingItems.map((item) => {
        const id = captureId(item);
        return state.dirtyIds.has(id) && previousItems.has(id)
          ? previousItems.get(id)
          : item;
      });
      state.items = items;
      state.lastExport = response.lastExport &&
        typeof response.lastExport.exportId === "string" &&
        Number(response.lastExport.rowCount) > 0
        ? response.lastExport
        : null;
      state.maxItems = Math.max(
        0,
        Number(response.maxItems) || Number(collector && collector.MAX_ITEMS) || 0
      );
      const knownIds = new Set(items.map(captureId));
      Array.from(state.drafts.keys()).forEach((id) => {
        if (!knownIds.has(id)) {
          state.drafts.delete(id);
          state.dirtyIds.delete(id);
          state.saveAttemptedIds.delete(id);
        } else if (!state.dirtyIds.has(id)) {
          state.drafts.delete(id);
          state.saveAttemptedIds.delete(id);
        }
      });
      if (settings.preferredId && knownIds.has(settings.preferredId)) {
        state.selectedId = settings.preferredId;
      } else if (!knownIds.has(state.selectedId)) {
        state.selectedId = null;
      }
      state.loaded = true;
      if (!state.dirtyIds.size) state.storageRefreshPending = false;
      renderAll();
      if (settings.announce) setNotice("Review queue refreshed.", "success", 2200);
      if (settings.automatic) {
        elements.liveStatus.textContent = "The local review queue updated automatically.";
      }
    } catch (error) {
      state.loaded = true;
      elements.errorMessage.textContent = error && error.message
        ? error.message
        : "SponsorLens could not load the examples stored on this device.";
      setPanel("error");
      setNotice(elements.errorMessage.textContent, "error");
    } finally {
      setBusy(false);
    }
  }

  function isCollectorItemKey(key) {
    if (collector && typeof collector.isItemKey === "function") {
      return collector.isItemKey(key);
    }
    const prefix = collector && typeof collector.ITEM_PREFIX === "string"
      ? collector.ITEM_PREFIX
      : "sponsorlens.collector.item.v1.";
    return typeof key === "string" && key.startsWith(prefix);
  }

  function runScheduledStorageRefresh() {
    clearTimeout(state.storageRefreshTimer);
    state.storageRefreshTimer = null;
    if (!state.storageRefreshPending) return;
    if (state.dirtyIds.size) {
      setNotice(
        "New or updated observations are waiting. Auto-refresh is paused to protect your unsaved review. Save it or refresh the queue when you are ready.",
        "warning"
      );
      return;
    }
    if (state.busy) {
      state.storageRefreshTimer = setTimeout(runScheduledStorageRefresh, 280);
      return;
    }
    state.storageRefreshPending = false;
    loadQueue({ preferredId: state.selectedId, automatic: true });
  }

  function scheduleStorageRefresh(changes, areaName) {
    if (areaName !== "local" || !changes || typeof changes !== "object") return;
    if (!Object.keys(changes).some(isCollectorItemKey)) return;
    state.storageRefreshPending = true;
    clearTimeout(state.storageRefreshTimer);
    state.storageRefreshTimer = setTimeout(runScheduledStorageRefresh, 280);
  }

  function nextVisibleId(id) {
    const visible = filteredItems();
    const index = visible.findIndex((item) => captureId(item) === id);
    if (index < 0) return null;
    const next = visible[index + 1] || visible[index - 1];
    return next ? captureId(next) : null;
  }

  function buildReview(item) {
    const draft = draftFor(item);
    const candidateReviews = {};
    candidatesOf(item).forEach((candidate, index) => {
      const id = candidateId(candidate, index);
      const value = draft.candidates[id];
      candidateReviews[id] = {
        label: value.label,
        evidence: value.label === "irrelevant"
          ? null
          : exactEvidence(String(candidate.text || ""), value.evidence)
      };
    });
    return {
      groupId: draft.groupId.trim(),
      candidates: candidateReviews,
      reviewedAt: null
    };
  }

  async function updateCurrentPageResult(action, selectedStatus) {
    const item = currentItem();
    if (!item || state.busy) return;
    const id = captureId(item);
    setBusy(true);
    elements.savePageResultButton.textContent = "Saving…";
    try {
      const response = await runtimeMessage({
        type: "SPONSORLENS_COLLECTION_PAGE_RESULT_UPDATE",
        captureId: id,
        action,
        ...(action === "corrected" ? { selectedStatus } : {})
      });
      if (!response.item || captureId(response.item) !== id) {
        throw new Error("SponsorLens returned an invalid updated example.");
      }
      const index = state.items.findIndex((entry) => captureId(entry) === id);
      if (index >= 0) state.items[index] = response.item;
      state.editingPageResultId = null;
      state.saveAttemptedIds.delete(id);
      renderAll();
      const finalName = resultStatusName(finalPageStatus(response.item));
      setNotice(
        action === "clear"
          ? `Final result restored to the scanner result: ${finalName}.`
          : `Final result changed to ${finalName}. Existing passage labels were kept; save the review again before export.`,
        "success",
        4200
      );
    } catch (error) {
      setNotice(error && error.message || "The page result could not be updated.", "error");
    } finally {
      elements.savePageResultButton.textContent = "Save result";
      setBusy(false);
    }
  }

  async function saveCurrent() {
    const item = currentItem();
    if (!item || state.busy) return;
    if (!isTrainable(item)) {
      setNotice(
        "A diagnostic correction without a passage cannot be marked Ready or exported.",
        "warning",
        4200
      );
      return;
    }
    const id = captureId(item);
    state.saveAttemptedIds.add(id);
    elements.candidateList.replaceChildren();
    candidatesOf(item).forEach((candidate, index) => {
      elements.candidateList.append(makeCandidateCard(item, candidate, index));
    });
    const ready = updateCandidateSummary(item);
    if (!ready) {
      const invalid = elements.candidateList.querySelector(".candidate-card.invalid");
      (invalid || elements.groupIdInput).scrollIntoView({ behavior: "smooth", block: "center" });
      elements.liveStatus.textContent = "Complete every label and evidence selection before saving.";
      return;
    }

    const nextId = nextVisibleId(id);
    setBusy(true);
    elements.saveButton.textContent = "Saving…";
    try {
      const response = await runtimeMessage({
        type: "SPONSORLENS_COLLECTION_UPDATE",
        captureId: id,
        review: buildReview(item)
      });
      if (response.ready !== true) {
        if (response.item && captureId(response.item) === id) {
          const index = state.items.findIndex((entry) => captureId(entry) === id);
          if (index >= 0) state.items[index] = response.item;
        }
        state.dirtyIds.delete(id);
        state.drafts.set(id, createDraft(response.item || item));
        state.selectedId = id;
        renderAll();
        const errors = Array.isArray(response.errors) && response.errors.length
          ? response.errors.join(" ")
          : "The review is incomplete. Check every label and evidence selection.";
        elements.validationMessage.textContent = errors;
        elements.validationMessage.classList.add("error");
        setNotice(errors, "error");
        return;
      }
      state.drafts.delete(id);
      state.dirtyIds.delete(id);
      state.saveAttemptedIds.delete(id);
      await loadQueue({ preferredId: nextId });
      setNotice("Review saved. It is ready to export.", "success", 3200);
    } catch (error) {
      setNotice(error && error.message || "The review could not be saved.", "error");
    } finally {
      elements.saveButton.textContent = "Save & next";
      setBusy(false);
    }
  }

  function localDateStamp(value) {
    const parsed = value ? new Date(value) : new Date();
    const date = Number.isFinite(parsed.getTime()) ? parsed : new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }

  function downloadJsonl(rows, createdAt) {
    const contents = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const blob = new Blob([contents], {
      type: "application/x-ndjson;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `sponsorlens-training-${localDateStamp(createdAt)}.jsonl`;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportReady() {
    if (state.busy) return;
    const readyItems = state.items.filter((item) => {
      return isTrainable(item) && itemState(item) === "ready";
    });
    if (!readyItems.length) return;
    setBusy(true);
    elements.exportButton.textContent = "Preparing export…";
    let committedRows = null;
    try {
      const response = await runtimeMessage({
        type: "SPONSORLENS_COLLECTION_MARK_EXPORTED",
        captureIds: readyItems.map(captureId)
      });
      const rows = response.rows;
      if (!Array.isArray(rows)) {
        throw new Error("SponsorLens returned an invalid export plan.");
      }
      committedRows = rows;
      state.lastExport = response.lastExport || state.lastExport;
      if (rows.length) {
        downloadJsonl(rows, response.lastExport && response.lastExport.createdAt);
      }
      await loadQueue();
      const duplicateCount = Math.max(0, Number(response.duplicateRows) || 0);
      const revisionCount = Math.max(0, Number(response.revisionRows) || 0);
      const skippedCount = Math.max(0, Number(response.skipped) || 0);
      const duplicateNote = duplicateCount
        ? ` ${duplicateCount} passage${duplicateCount === 1 ? " was" : "s were"} already present in an earlier export and skipped.`
        : "";
      const changedNote = skippedCount
        ? ` ${skippedCount} queue example${skippedCount === 1 ? " changed" : "s changed"} before export and ${skippedCount === 1 ? "was" : "were"} skipped.`
        : "";
      const revisionNote = revisionCount
        ? ` ${revisionCount} corrected row${revisionCount === 1 ? " replaces" : "s replace"} an earlier export by the same row ID.`
        : "";
      if (rows.length) {
        setNotice(
          `Exported ${rows.length} training row${rows.length === 1 ? "" : "s"}. The local copies were kept.${revisionNote}${duplicateNote}${changedNote}`,
          skippedCount ? "warning" : "success",
          5600
        );
      } else if (duplicateCount) {
        setNotice(
          `No new rows were downloaded. Every unchanged ready passage was already represented in an earlier export.${changedNote}`,
          skippedCount ? "warning" : "success",
          5600
        );
      } else {
        setNotice(
          `No file was downloaded.${changedNote || " The review queue changed before export."}`,
          "warning",
          5600
        );
      }
    } catch (error) {
      const conflictTitles = error && Array.isArray(error.captureIds)
        ? error.captureIds.map((id) => {
          const item = state.items.find((entry) => captureId(entry) === id);
          return item ? `“${itemTitle(item)}”` : id;
        })
        : [];
      const message = committedRows
        ? `The export was committed, but the Review page could not finish: ${error.message}`
        : error && error.code === "conflicting-labels"
        ? error.historical
          ? `This passage conflicts with a label in an earlier export${conflictTitles.length ? ` (${conflictTitles.join(" and ")})` : ""}. Correct the earlier JSONL dataset before exporting this revised label.`
          : `The same passage has conflicting labels in ${conflictTitles.join(" and ") || "two reviewed examples"}. Make those labels agree before exporting.`
        : error && error.message || "The ready examples could not be exported.";
      setNotice(message, "error");
    } finally {
      updateCounts();
      setBusy(false);
    }
  }

  async function downloadLastExport() {
    if (state.busy || !state.lastExport) return;
    setBusy(true);
    elements.lastExportButton.textContent = "Preparing download…";
    try {
      const response = await runtimeMessage({
        type: "SPONSORLENS_COLLECTION_GET_LAST_EXPORT"
      });
      const receipt = response.receipt;
      if (!receipt || !Array.isArray(receipt.rows) || !receipt.rows.length) {
        throw new Error("The last export receipt is unavailable.");
      }
      state.lastExport = {
        exportId: receipt.exportId,
        createdAt: receipt.createdAt,
        rowCount: receipt.rowCount
      };
      downloadJsonl(receipt.rows, receipt.createdAt);
      setNotice(
        `Downloaded the last export again (${receipt.rows.length} training row${receipt.rows.length === 1 ? "" : "s"}).`,
        "success",
        4200
      );
    } catch (error) {
      setNotice(
        error && error.message || "The last export could not be downloaded.",
        "error"
      );
    } finally {
      elements.lastExportButton.textContent = "Download last export";
      setBusy(false);
    }
  }

  function showDialog(dialog) {
    dialog.returnValue = "";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  async function deleteCapture(id) {
    if (!id || state.busy) return;
    const nextId = nextVisibleId(id);
    setBusy(true);
    try {
      await runtimeMessage({
        type: "SPONSORLENS_COLLECTION_DELETE",
        captureId: id
      });
      state.drafts.delete(id);
      state.dirtyIds.delete(id);
      state.saveAttemptedIds.delete(id);
      if (state.editingPageResultId === id) state.editingPageResultId = null;
      state.selectedId = nextId;
      await loadQueue({ preferredId: nextId });
      setNotice("Example deleted from this device.", "success", 2800);
    } catch (error) {
      setNotice(error && error.message || "The example could not be deleted.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function clearQueue() {
    if (state.busy || (!state.items.length && !state.lastExport)) return;
    const hadLastExport = Boolean(state.lastExport);
    setBusy(true);
    try {
      await runtimeMessage({ type: "SPONSORLENS_COLLECTION_CLEAR" });
      state.items = [];
      state.lastExport = null;
      state.selectedId = null;
      state.drafts.clear();
      state.dirtyIds.clear();
      state.saveAttemptedIds.clear();
      state.editingPageResultId = null;
      renderAll();
      setNotice(
        hadLastExport
          ? "The local review queue and last downloadable export were cleared. Compact duplicate history was kept."
          : "The local review queue was cleared.",
        "success",
        4200
      );
    } catch (error) {
      setNotice(error && error.message || "The queue could not be cleared.", "error");
    } finally {
      setBusy(false);
    }
  }

  elements.filters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button || !FILTERS.includes(button.dataset.filter)) return;
    state.filter = button.dataset.filter;
    state.saveAttemptedIds.clear();
    renderAll();
  });

  elements.groupIdInput.addEventListener("input", () => {
    const item = currentItem();
    if (!item) return;
    draftFor(item).groupId = elements.groupIdInput.value;
    markDirty(item);
    updateCandidateSummary(item);
    renderQueue();
  });

  elements.saveButton.addEventListener("click", saveCurrent);
  elements.changePageResultButton.addEventListener("click", () => {
    const item = currentItem();
    if (!item || state.busy) return;
    state.editingPageResultId = captureId(item);
    elements.pageResultSelect.value = finalPageStatus(item);
    renderDetail();
    elements.pageResultSelect.focus();
  });
  elements.cancelPageResultButton.addEventListener("click", () => {
    state.editingPageResultId = null;
    renderDetail();
  });
  elements.pageResultEditor.addEventListener("submit", (event) => {
    event.preventDefault();
    updateCurrentPageResult("corrected", elements.pageResultSelect.value);
  });
  elements.resetPageResultButton.addEventListener("click", () => {
    updateCurrentPageResult("clear");
  });
  elements.exportButton.addEventListener("click", exportReady);
  elements.lastExportButton.addEventListener("click", downloadLastExport);
  elements.deleteButton.addEventListener("click", () => {
    if (!state.selectedId || state.busy) return;
    state.pendingDeleteId = state.selectedId;
    showDialog(elements.deleteDialog);
  });
  elements.deleteDialog.addEventListener("close", () => {
    const id = state.pendingDeleteId;
    state.pendingDeleteId = null;
    if (elements.deleteDialog.returnValue === "confirm") deleteCapture(id);
  });

  elements.clearButton.addEventListener("click", () => {
    if (state.busy || (!state.items.length && !state.lastExport)) return;
    elements.clearConfirmCheck.checked = false;
    elements.confirmClearButton.disabled = true;
    const queueText = state.items.length
      ? `all ${state.items.length} collected example${state.items.length === 1 ? "" : "s"}`
      : "the empty review queue";
    const receiptText = state.lastExport
      ? " and the downloadable copy of the most recent export"
      : "";
    elements.clearDialogText.textContent =
      `This permanently removes ${queueText}${receiptText}. Compact row IDs and labels remain in export history to prevent duplicates and conflicts.`;
    showDialog(elements.clearDialog);
  });
  elements.clearConfirmCheck.addEventListener("change", () => {
    elements.confirmClearButton.disabled = !elements.clearConfirmCheck.checked;
  });
  elements.clearDialog.addEventListener("close", () => {
    if (elements.clearDialog.returnValue === "confirm" && elements.clearConfirmCheck.checked) {
      clearQueue();
    }
  });

  elements.refreshButton.addEventListener("click", () => {
    if (state.dirtyIds.size && !window.confirm(
      "Refreshing will discard unsaved labels. Continue?"
    )) {
      return;
    }
    state.drafts.clear();
    state.dirtyIds.clear();
    state.saveAttemptedIds.clear();
    loadQueue({ preferredId: state.selectedId, announce: true });
  });
  elements.retryButton.addEventListener("click", () => loadQueue());
  elements.dismissNoticeButton.addEventListener("click", clearNotice);

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirtyIds.size) return;
    event.preventDefault();
    event.returnValue = "";
  });

  if (
    globalThis.chrome &&
    chrome.storage &&
    chrome.storage.onChanged &&
    typeof chrome.storage.onChanged.addListener === "function"
  ) {
    chrome.storage.onChanged.addListener(scheduleStorageRefresh);
  }

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      saveCurrent();
    }
  });

  if (!collector || !Array.isArray(collector.LABELS)) {
    state.loaded = true;
    elements.errorMessage.textContent = "The SponsorLens collection module could not be loaded.";
    setPanel("error");
    setNotice(elements.errorMessage.textContent, "error");
    setBusy(false);
  } else {
    loadQueue();
  }
})();
