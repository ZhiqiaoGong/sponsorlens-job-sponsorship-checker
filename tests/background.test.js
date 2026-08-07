"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const collector = require("../lib/collector.js");

function storageValues(store, keys) {
  if (keys === null || keys === undefined) return { ...store };
  if (typeof keys === "string") {
    return Object.hasOwn(store, keys) ? { [keys]: store[keys] } : {};
  }
  if (Array.isArray(keys)) {
    return Object.fromEntries(
      keys.filter((key) => Object.hasOwn(store, key)).map((key) => [key, store[key]])
    );
  }
  return Object.fromEntries(Object.entries(keys || {}).map(([key, fallback]) => [
    key,
    Object.hasOwn(store, key) ? store[key] : fallback
  ]));
}

function loadBackground(options = {}) {
  const calls = [];
  const localValues = { ...(options.localValues || {}) };
  const syncValues = { enableBadge: true, ...(options.syncValues || {}) };
  let messageListener;
  const chrome = {
    runtime: {
      lastError: null,
      getURL(path) {
        return `chrome-extension://test/${path}`;
      },
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    },
    storage: {
      sync: {
        get(keys, callback) {
          callback(storageValues(syncValues, keys));
        },
        set(values, callback) {
          Object.assign(syncValues, values);
          if (callback) callback();
        }
      },
      local: {
        get(keys, callback) {
          callback(storageValues(localValues, keys));
        },
        set(values, callback) {
          Object.assign(localValues, values);
          if (callback) callback();
        },
        remove(keys, callback) {
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach((key) => delete localValues[key]);
          if (callback) callback();
        }
      },
      onChanged: { addListener() {} }
    },
    action: {
      setBadgeText(value) {
        calls.push(["badge", value]);
      },
      setBadgeBackgroundColor(value) {
        calls.push(["color", value]);
      },
      setTitle(value) {
        calls.push(["title", value]);
      }
    }
  };

  vm.runInNewContext(
    fs.readFileSync(require.resolve("../background.js"), "utf8"),
    { chrome, SponsorLensCollector: collector }
  );

  return { calls, localValues, messageListener };
}

function dispatch(messageListener, message, sender) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const returned = messageListener(message, sender || {}, (response) => {
      settled = true;
      resolve(response);
    });
    if (returned !== true && !settled) {
      reject(new Error("The message listener did not provide a response."));
    }
  });
}

function makeCapture(jobKey = "job:background:1", text = "Visa sponsorship requires review.") {
  return collector.buildCapture({
    result: {
      version: "test-analyzer",
      status: "review",
      counts: { review: 1 },
      evidence: [],
      isLikelyJobPage: true,
      scanMode: "job"
    },
    candidates: [{
      text,
      index: 50,
      end: 50 + text.length,
      signalSpans: []
    }],
    jobKey,
    reason: "needs-review",
    capturedAt: "2026-08-05T10:00:00.000Z"
  });
}

function makeFeedbackOnlyCapture(jobKey = "job:background:feedback-only") {
  return collector.buildCapture({
    result: {
      version: "test-analyzer",
      status: "unknown",
      counts: {},
      evidence: [],
      isLikelyJobPage: true,
      scanMode: "job"
    },
    candidates: [],
    jobKey,
    reason: "user-feedback",
    capturedAt: "2026-08-05T10:00:00.000Z"
  });
}

function makeReadyCapture(jobKey, text, label = "review") {
  const item = makeCapture(jobKey, text);
  const candidate = item.candidates[0];
  return collector.applyReview(item, {
    groupId: `group-${item.jobKeyHash}`,
    candidates: {
      [candidate.candidateId]: {
        label,
        evidence: {
          start: 0,
          end: candidate.text.length,
          text: candidate.text
        }
      }
    }
  }).item;
}

test("non-job results clear the toolbar badge", () => {
  const { calls, messageListener } = loadBackground();
  messageListener(
    {
      type: "SPONSORLENS_RESULT",
      result: {
        status: "no",
        isLikelyJobPage: false,
        scanMode: "skipped"
      }
    },
    { tab: { id: 7 } }
  );

  assert.equal(calls[0][0], "badge");
  assert.equal(calls[0][1].tabId, 7);
  assert.equal(calls[0][1].text, "");
  assert.equal(calls[1][0], "title");
  assert.match(calls[1][1].title, /not an individual job listing/i);
});

test("individual job results still update the toolbar badge", () => {
  const { calls, messageListener } = loadBackground();
  messageListener(
    {
      type: "SPONSORLENS_RESULT",
      result: {
        status: "no",
        isLikelyJobPage: true,
        scanMode: "job"
      }
    },
    { tab: { id: 8 } }
  );

  assert.equal(calls[0][0], "badge");
  assert.equal(calls[0][1].tabId, 8);
  assert.equal(calls[0][1].text, "NO");
  assert.equal(calls[1][0], "color");
  assert.equal(calls[1][1].tabId, 8);
  assert.equal(calls[1][1].color, "#dc2626");
});

test("capture messages require a browser tab sender", async () => {
  const { messageListener, localValues } = loadBackground();
  const response = await dispatch(
    messageListener,
    { type: "SPONSORLENS_CAPTURE_SAMPLES", capture: makeCapture() },
    {}
  );

  assert.equal(response.ok, false);
  assert.match(response.error, /browser tab/i);
  assert.equal(Object.keys(localValues).length, 0);
});

test("page feedback messages require a browser tab sender", async () => {
  const { messageListener, localValues } = loadBackground({
    localValues: { [collector.SETTING_KEY]: true }
  });
  const response = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_FEEDBACK",
      capture: makeCapture(),
      feedback: { action: "confirmed" }
    },
    { url: "chrome-extension://test/collector/collector.html" }
  );

  assert.equal(response.ok, false);
  assert.match(response.error, /browser tab/i);
  assert.equal(collector.itemsFromStorage(localValues).length, 0);
});

test("background storage enforces the device-local opt-in", async () => {
  const { messageListener, localValues } = loadBackground();
  const response = await dispatch(
    messageListener,
    { type: "SPONSORLENS_CAPTURE_SAMPLES", capture: makeCapture() },
    { tab: { id: 12 }, url: "https://jobs.example.com/opening/1" }
  );

  assert.equal(response.ok, false);
  assert.equal(response.disabled, true);
  assert.match(response.error, /disabled/i);
  assert.equal(collector.itemsFromStorage(localValues).length, 0);
});

test("a duplicate scan upgrades a legacy stored capture without changing its identity", async () => {
  const item = makeCapture("job:legacy-upgrade");
  const legacy = structuredClone(item);
  legacy.captureSchemaVersion = 1;
  delete legacy.pageFeedback;
  const key = collector.storageKey(item.captureId);
  const { messageListener, localValues } = loadBackground({
    localValues: {
      [collector.SETTING_KEY]: true,
      [key]: legacy
    }
  });

  const response = await dispatch(
    messageListener,
    { type: "SPONSORLENS_CAPTURE_SAMPLES", capture: item },
    { tab: { id: 13 }, url: "https://jobs.example.com/opening/legacy" }
  );

  assert.equal(response.ok, true);
  assert.equal(response.duplicate, 1);
  assert.equal(localValues[key].captureSchemaVersion, collector.CAPTURE_SCHEMA_VERSION);
  assert.equal(localValues[key].pageFeedback.action, "confirmed");
  assert.equal(localValues[key].pageFeedback.predictedStatus, "review");
  assert.equal(localValues[key].pageFeedback.selectedStatus, "review");
  assert.equal(localValues[key].pageFeedback.source, "automatic");
  assert.deepEqual(response.pageFeedback, localValues[key].pageFeedback);
});

test("duplicate automatic saves preserve an explicit page correction", async () => {
  const item = makeCapture("job:duplicate-preserves-correction");
  const key = collector.storageKey(item.captureId);
  const { messageListener, localValues } = loadBackground({
    localValues: { [collector.SETTING_KEY]: true }
  });
  const sender = {
    tab: { id: 13 },
    url: "https://jobs.example.com/opening/duplicate-correction"
  };

  const saved = await dispatch(
    messageListener,
    { type: "SPONSORLENS_CAPTURE_SAMPLES", capture: item },
    sender
  );
  assert.equal(saved.pageFeedback.action, "confirmed");
  assert.equal(saved.pageFeedback.source, "automatic");

  const corrected = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_FEEDBACK",
      capture: item,
      feedback: { action: "corrected", selectedStatus: "no" }
    },
    sender
  );
  assert.equal(corrected.pageFeedback.action, "corrected");
  assert.equal(corrected.pageFeedback.source, "indicator");

  const duplicate = await dispatch(
    messageListener,
    { type: "SPONSORLENS_CAPTURE_SAMPLES", capture: item },
    sender
  );
  assert.equal(duplicate.duplicate, 1);
  assert.deepEqual(duplicate.pageFeedback, corrected.pageFeedback);
  assert.deepEqual(localValues[key].pageFeedback, corrected.pageFeedback);
});

test("page feedback enforces opt-in and the local queue limit", async () => {
  const capture = makeFeedbackOnlyCapture();
  const sender = { tab: { id: 14 }, url: "https://jobs.example.com/opening/feedback" };
  const disabled = loadBackground();
  const disabledResponse = await dispatch(
    disabled.messageListener,
    {
      type: "SPONSORLENS_COLLECTION_FEEDBACK",
      capture,
      feedback: { action: "corrected", selectedStatus: "yes" }
    },
    sender
  );
  assert.equal(disabledResponse.ok, false);
  assert.equal(disabledResponse.disabled, true);
  assert.equal(collector.itemsFromStorage(disabled.localValues).length, 0);

  const fullValues = { [collector.SETTING_KEY]: true };
  for (let index = 0; index < collector.MAX_ITEMS; index += 1) {
    fullValues[`${collector.ITEM_PREFIX}feedback-seed-${index}`] = {
      captureId: `feedback-seed-${index}`,
      capturedAt: "2026-08-01T00:00:00.000Z"
    };
  }
  const full = loadBackground({ localValues: fullValues });
  const fullResponse = await dispatch(
    full.messageListener,
    {
      type: "SPONSORLENS_COLLECTION_FEEDBACK",
      capture,
      feedback: { action: "corrected", selectedStatus: "yes" }
    },
    sender
  );
  assert.equal(fullResponse.ok, false);
  assert.equal(fullResponse.full, true);
  assert.equal(fullResponse.itemCount, collector.MAX_ITEMS);
  assert.equal(full.localValues[collector.storageKey(capture.captureId)], undefined);
});

test("page feedback saves, updates, and supports records without candidate passages", async () => {
  const { messageListener, localValues } = loadBackground({
    localValues: { [collector.SETTING_KEY]: true }
  });
  const sender = { tab: { id: 15 }, url: "https://jobs.example.com/opening/feedback" };
  const item = makeCapture("job:background:feedback");

  const confirmed = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_FEEDBACK",
      capture: item,
      feedback: { action: "confirmed" }
    },
    sender
  );
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.captureId, item.captureId);
  assert.equal(confirmed.pageFeedback.action, "confirmed");
  assert.equal(confirmed.pageFeedback.predictedStatus, "review");
  assert.equal(confirmed.pageFeedback.selectedStatus, "review");
  assert.equal(
    localValues[collector.storageKey(item.captureId)].pageFeedback.action,
    "confirmed"
  );

  const corrected = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_FEEDBACK",
      capture: item,
      feedback: { action: "corrected", selectedStatus: "no" }
    },
    sender
  );
  assert.equal(corrected.ok, true);
  assert.equal(corrected.pageFeedback.action, "corrected");
  assert.equal(corrected.pageFeedback.selectedStatus, "no");
  assert.equal(corrected.item.state, "pending");

  const reverted = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_FEEDBACK",
      capture: item,
      feedback: { action: "clear" }
    },
    sender
  );
  assert.equal(reverted.ok, true);
  assert.notEqual(reverted.removed, true);
  assert.equal(reverted.pageFeedback.action, "confirmed");
  assert.equal(reverted.pageFeedback.predictedStatus, "review");
  assert.equal(reverted.pageFeedback.selectedStatus, "review");
  assert.equal(reverted.pageFeedback.source, "automatic");
  assert.deepEqual(
    localValues[collector.storageKey(item.captureId)].pageFeedback,
    reverted.pageFeedback
  );

  const feedbackOnly = makeFeedbackOnlyCapture();
  assert.equal(feedbackOnly.candidates.length, 0);
  const missingFeedbackOnly = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_FEEDBACK_GET",
      capture: feedbackOnly
    },
    sender
  );
  assert.equal(missingFeedbackOnly.ok, true);
  assert.equal(missingFeedbackOnly.found, false);
  assert.deepEqual(
    missingFeedbackOnly.pageFeedback,
    collector.defaultPageFeedback(feedbackOnly.baseResult.status)
  );
  assert.equal(
    localValues[collector.storageKey(feedbackOnly.captureId)],
    undefined
  );
  const savedFeedbackOnly = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_FEEDBACK",
      capture: feedbackOnly,
      feedback: { action: "corrected", selectedStatus: "not-job" }
    },
    sender
  );
  assert.equal(savedFeedbackOnly.ok, true);
  assert.equal(savedFeedbackOnly.item.candidates.length, 0);
  assert.equal(savedFeedbackOnly.item.sampleReason, "user-feedback");
  assert.equal(savedFeedbackOnly.pageFeedback.action, "corrected");
  assert.equal(savedFeedbackOnly.pageFeedback.selectedStatus, "not-job");
  assert.equal(savedFeedbackOnly.trainable, false);
  assert.equal(
    localValues[collector.storageKey(feedbackOnly.captureId)].candidates.length,
    0
  );

  const lookedUp = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_FEEDBACK_GET",
      capture: feedbackOnly
    },
    sender
  );
  assert.equal(lookedUp.ok, true);
  assert.equal(lookedUp.found, true);
  assert.equal(lookedUp.trainable, false);
  assert.equal(lookedUp.pageFeedback.selectedStatus, "not-job");

  const cleared = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_FEEDBACK",
      capture: feedbackOnly,
      feedback: { action: "clear" }
    },
    sender
  );
  assert.equal(cleared.ok, true);
  assert.equal(cleared.removed, true);
  assert.equal(localValues[collector.storageKey(feedbackOnly.captureId)], undefined);
});

test("invalid page feedback does not leave a partially saved capture", async () => {
  const { messageListener, localValues } = loadBackground({
    localValues: { [collector.SETTING_KEY]: true }
  });
  const item = makeFeedbackOnlyCapture("job:invalid-feedback");
  const response = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_FEEDBACK",
      capture: item,
      feedback: { action: "corrected", selectedStatus: "invalid" }
    },
    { tab: { id: 16 }, url: "https://jobs.example.com/opening/invalid" }
  );

  assert.equal(response.ok, false);
  assert.match(response.error, /valid corrected result/i);
  assert.equal(localValues[collector.storageKey(item.captureId)], undefined);
});

test("background rejects captures that smuggle extra page data or reviews", async () => {
  const { messageListener, localValues } = loadBackground({
    localValues: { [collector.SETTING_KEY]: true }
  });
  const sender = { tab: { id: 12 }, url: "https://jobs.example.com/opening/1" };
  const extraPageData = structuredClone(makeCapture());
  extraPageData.page.fullText = "This must never be stored.";
  const extraResponse = await dispatch(
    messageListener,
    { type: "SPONSORLENS_CAPTURE_SAMPLES", capture: extraPageData },
    sender
  );
  assert.equal(extraResponse.ok, false);

  const preReviewed = structuredClone(makeCapture("job:pre-reviewed"));
  preReviewed.state = "ready";
  preReviewed.review.reviewedAt = "2026-08-05T11:00:00.000Z";
  const reviewedResponse = await dispatch(
    messageListener,
    { type: "SPONSORLENS_CAPTURE_SAMPLES", capture: preReviewed },
    sender
  );
  assert.equal(reviewedResponse.ok, false);
  assert.equal(collector.itemsFromStorage(localValues).length, 0);
});

test("collector messages cover capture, review, export, list, and delete", async () => {
  const { messageListener, localValues } = loadBackground({
    localValues: { [collector.SETTING_KEY]: true }
  });
  const item = makeCapture();
  const tabSender = { tab: { id: 12 }, url: "https://jobs.example.com/opening/1" };
  const reviewSender = { url: "chrome-extension://test/collector/collector.html" };

  const saved = await dispatch(
    messageListener,
    { type: "SPONSORLENS_CAPTURE_SAMPLES", capture: item },
    tabSender
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.added, 1);
  assert.equal(saved.updated, 0);
  assert.equal(saved.captureId, item.captureId);
  assert.equal(saved.pageFeedback.action, "confirmed");
  assert.equal(saved.pageFeedback.predictedStatus, item.baseResult.status);
  assert.equal(saved.pageFeedback.selectedStatus, item.baseResult.status);
  assert.equal(saved.pageFeedback.source, "automatic");
  assert.deepEqual(
    localValues[collector.storageKey(item.captureId)].pageFeedback,
    saved.pageFeedback
  );
  assert.equal(localValues[collector.storageKey(item.captureId)].state, "pending");
  assert.equal(
    localValues[collector.storageKey(item.captureId)].review.reviewedAt,
    null
  );

  const duplicate = await dispatch(
    messageListener,
    { type: "SPONSORLENS_CAPTURE_SAMPLES", capture: item },
    tabSender
  );
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.added, 0);
  assert.equal(duplicate.updated, 0);
  assert.equal(duplicate.duplicate, 1);
  assert.equal(duplicate.captureId, item.captureId);
  assert.deepEqual(duplicate.pageFeedback, saved.pageFeedback);
  assert.equal(localValues[collector.storageKey(item.captureId)].observationCount, 1);

  const listed = await dispatch(
    messageListener,
    { type: "SPONSORLENS_COLLECTION_LIST" },
    reviewSender
  );
  assert.equal(listed.ok, true);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.maxItems, collector.MAX_ITEMS);

  const candidateId = item.candidates[0].candidateId;
  const review = {
    groupId: "background-test-group",
    candidates: {
      [candidateId]: {
        label: "review",
        evidence: { start: 0, end: item.candidates[0].text.length, text: item.candidates[0].text }
      }
    }
  };
  const updated = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_UPDATE",
      captureId: item.captureId,
      review
    },
    reviewSender
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.ready, true);
  assert.equal(updated.item.state, "ready");

  const pending = makeCapture("job:pending-export-count");
  localValues[collector.storageKey(pending.captureId)] = pending;
  const exported = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_MARK_EXPORTED",
      captureIds: [item.captureId, item.captureId, pending.captureId, "missing"]
    },
    reviewSender
  );
  assert.equal(exported.ok, true);
  assert.equal(exported.updated, 1);
  assert.equal(exported.rows.length, 1);
  assert.equal(exported.duplicateRows, 0);
  assert.equal(exported.skipped, 2);
  assert.equal(exported.lastExport.rowCount, 1);
  assert.equal(localValues[collector.storageKey(item.captureId)].state, "exported");
  assert.equal(localValues[collector.storageKey(pending.captureId)].state, "pending");
  const exportedRowId = collector.toTrainingRows([
    localValues[collector.storageKey(item.captureId)]
  ])[0].id;
  assert.equal(
    localValues[collector.EXPORT_LEDGER_KEY].entries[exportedRowId].label,
    "review"
  );
  const lastExport = await dispatch(
    messageListener,
    { type: "SPONSORLENS_COLLECTION_GET_LAST_EXPORT" },
    reviewSender
  );
  assert.equal(lastExport.ok, true);
  assert.equal(lastExport.receipt.rows.length, 1);
  assert.equal(lastExport.receipt.rows[0].id, exportedRowId);

  const corrected = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_UPDATE",
      captureId: item.captureId,
      review: {
        groupId: "background-test-group",
        candidates: {
          [candidateId]: {
            label: "no",
            evidence: {
              start: 0,
              end: item.candidates[0].text.length,
              text: item.candidates[0].text
            }
          }
        }
      }
    },
    reviewSender
  );
  assert.equal(corrected.ok, true);
  assert.equal(corrected.item.state, "ready");
  const conflictingExport = await dispatch(
    messageListener,
    {
      type: "SPONSORLENS_COLLECTION_MARK_EXPORTED",
      captureIds: [item.captureId]
    },
    reviewSender
  );
  assert.equal(conflictingExport.ok, false);
  assert.match(conflictingExport.error, /earlier export/i);
  assert.equal(localValues[collector.storageKey(item.captureId)].state, "ready");
  assert.equal(
    localValues[collector.EXPORT_LEDGER_KEY].entries[exportedRowId].label,
    "review"
  );

  const deleted = await dispatch(
    messageListener,
    { type: "SPONSORLENS_COLLECTION_DELETE", captureId: item.captureId },
    reviewSender
  );
  assert.equal(deleted.ok, true);
  assert.equal(localValues[collector.storageKey(item.captureId)], undefined);
  assert.equal(
    localValues[collector.EXPORT_LEDGER_KEY].entries[exportedRowId].label,
    "review"
  );
  assert.equal(localValues[collector.LAST_EXPORT_KEY].rowCount, 1);
});

test("concurrent export requests use one authoritative serialized ledger", async () => {
  const text = "Visa sponsorship is available for this role.";
  const first = makeReadyCapture("job:concurrent-export:1", text, "yes");
  const second = makeReadyCapture("job:concurrent-export:2", text, "yes");
  const { messageListener, localValues } = loadBackground({
    localValues: {
      [collector.storageKey(first.captureId)]: first,
      [collector.storageKey(second.captureId)]: second
    }
  });
  const sender = { url: "chrome-extension://test/collector/collector.html" };

  const [firstResponse, secondResponse] = await Promise.all([
    dispatch(messageListener, {
      type: "SPONSORLENS_COLLECTION_MARK_EXPORTED",
      captureIds: [first.captureId]
    }, sender),
    dispatch(messageListener, {
      type: "SPONSORLENS_COLLECTION_MARK_EXPORTED",
      captureIds: [second.captureId]
    }, sender)
  ]);

  assert.equal(firstResponse.ok, true);
  assert.equal(secondResponse.ok, true);
  assert.equal(firstResponse.rows.length + secondResponse.rows.length, 1);
  assert.equal(firstResponse.duplicateRows + secondResponse.duplicateRows, 1);
  assert.equal(
    Object.keys(localValues[collector.EXPORT_LEDGER_KEY].entries).length,
    1
  );
  assert.equal(localValues[collector.storageKey(first.captureId)].state, "exported");
  assert.equal(localValues[collector.storageKey(second.captureId)].state, "exported");
});

test("review-page operations reject messages from ordinary pages", async () => {
  const { messageListener } = loadBackground();
  const response = await dispatch(
    messageListener,
    { type: "SPONSORLENS_COLLECTION_LIST" },
    { tab: { id: 2 }, url: "https://jobs.example.com/opening/1" }
  );
  assert.equal(response.ok, false);
  assert.match(response.error, /review page/i);
});

test("collector clear removes only collector-owned local keys", async () => {
  const first = makeCapture("job:clear:1", "Visa sponsorship is unavailable.");
  const second = makeCapture("job:clear:2", "Visa sponsorship may be available.");
  const unrelated = { keep: true };
  const exportLedger = {
    version: collector.EXPORT_LEDGER_VERSION,
    entries: {
      "local-0000000000": {
        label: "no",
        exportedAt: "2026-08-05T10:30:00.000Z"
      }
    }
  };
  const lastExport = collector.createExportReceipt(
    collector.toTrainingRows([
      makeReadyCapture(
        "job:clear:last-export",
        "Visa sponsorship is unavailable.",
        "no"
      )
    ]),
    "2026-08-05T10:40:00.000Z"
  );
  const { messageListener, localValues } = loadBackground({
    localValues: {
      unrelated,
      [collector.EXPORT_LEDGER_KEY]: exportLedger,
      [collector.LAST_EXPORT_KEY]: lastExport,
      [collector.storageKey(first.captureId)]: first,
      [collector.storageKey(second.captureId)]: second
    }
  });
  const response = await dispatch(
    messageListener,
    { type: "SPONSORLENS_COLLECTION_CLEAR" },
    { url: "chrome-extension://test/collector/collector.html" }
  );

  assert.equal(response.ok, true);
  assert.equal(response.removed, 2);
  assert.deepEqual(localValues.unrelated, unrelated);
  assert.deepEqual(localValues[collector.EXPORT_LEDGER_KEY], exportLedger);
  assert.equal(localValues[collector.LAST_EXPORT_KEY], undefined);
  assert.equal(collector.itemsFromStorage(localValues).length, 0);
});

test("a full queue rejects new captures but still merges an existing job", async () => {
  const existing = makeCapture("job:capacity:existing");
  const initial = {
    [collector.SETTING_KEY]: true,
    [collector.storageKey(existing.captureId)]: existing
  };
  for (let index = 0; index < collector.MAX_ITEMS - 1; index += 1) {
    initial[`${collector.ITEM_PREFIX}seed-${index}`] = {
      captureId: `seed-${index}`,
      capturedAt: "2026-08-01T00:00:00.000Z"
    };
  }
  const { messageListener, localValues } = loadBackground({ localValues: initial });
  const sender = { tab: { id: 9 }, url: "https://jobs.example.com" };

  const changedExisting = makeCapture(
    "job:capacity:existing",
    "Visa sponsorship eligibility requires a new review."
  );
  const repeated = await dispatch(
    messageListener,
    { type: "SPONSORLENS_CAPTURE_SAMPLES", capture: changedExisting },
    sender
  );
  assert.equal(repeated.ok, true);
  assert.equal(repeated.updated, 1);
  assert.equal(
    localValues[collector.storageKey(existing.captureId)].observationCount,
    2
  );

  const next = makeCapture("job:capacity:new");
  const rejected = await dispatch(
    messageListener,
    { type: "SPONSORLENS_CAPTURE_SAMPLES", capture: next },
    sender
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.full, true);
  assert.equal(rejected.itemCount, collector.MAX_ITEMS);
  assert.equal(rejected.maxItems, collector.MAX_ITEMS);
  assert.equal(localValues[collector.storageKey(next.captureId)], undefined);
});
