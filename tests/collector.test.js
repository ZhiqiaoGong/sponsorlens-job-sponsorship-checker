"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const collector = require("../lib/collector.js");
const localModelPolicy = require("../lib/local-model-policy.js");

function candidate(text, pageStart = 100) {
  return {
    id: `source-${pageStart}`,
    text,
    index: pageStart,
    end: pageStart + text.length,
    signalSpans: []
  };
}

function result(overrides = {}) {
  return {
    version: "test-analyzer-1",
    status: "review",
    counts: { irrelevant: 0, no: 0, conditional: 0, yes: 0, review: 1 },
    evidence: [],
    isLikelyJobPage: true,
    scanMode: "job",
    page: {
      url: "https://jobs.example.com/opening/123?tracking=secret",
      title: "Example Engineer"
    },
    ...overrides
  };
}

function capture(overrides = {}) {
  return collector.buildCapture({
    result: result(),
    candidates: [candidate("Visa sponsorship details require review.")],
    jobKey: "job:example:123",
    reason: "needs-review",
    textFingerprint: "full-page-fingerprint",
    capturedAt: "2026-08-05T10:00:00.000Z",
    extensionVersion: "0.9.0",
    candidateExtractorVersion: "0.1.0",
    ...overrides
  });
}

function reviewAll(item, label = "review", evidenceFactory) {
  const candidates = {};
  item.candidates.forEach((entry) => {
    candidates[entry.candidateId] = {
      label,
      evidence: label === "irrelevant"
        ? null
        : evidenceFactory
          ? evidenceFactory(entry)
          : { start: 0, end: entry.text.length, text: entry.text }
    };
  });
  return collector.applyReview(item, {
    groupId: "example-template",
    candidates
  });
}

test("capture construction enforces the individual-job gate", () => {
  const base = {
    result: result(),
    candidates: [candidate("Visa sponsorship is not available.")],
    jobKey: "job:strict-gate",
    reason: "needs-review"
  };

  const built = collector.buildCapture(base);
  assert.ok(built);
  assert.equal(built.captureSchemaVersion, 2);
  assert.deepEqual(
    built.pageFeedback,
    collector.defaultPageFeedback(built.baseResult.status)
  );
  assert.equal(collector.buildCapture({ ...base, jobKey: "" }), null);
  assert.equal(collector.buildCapture({ ...base, reason: "" }), null);
  assert.equal(collector.buildCapture({
    ...base,
    result: result({ isLikelyJobPage: false, scanMode: "skipped" })
  }), null);
  assert.equal(collector.buildCapture({
    ...base,
    result: result({ scanMode: "page" })
  }), null);
  assert.equal(collector.buildCapture({ ...base, candidates: [] }), null);

  const feedbackOnly = collector.buildCapture({
    ...base,
    reason: "user-feedback",
    candidates: []
  });
  assert.ok(feedbackOnly);
  assert.equal(feedbackOnly.captureSchemaVersion, 2);
  assert.equal(feedbackOnly.candidates.length, 0);
  assert.deepEqual(
    feedbackOnly.pageFeedback,
    collector.defaultPageFeedback(feedbackOnly.baseResult.status)
  );
});

test("automatic collection keeps every relevant result while prioritizing conflicts", () => {
  assert.equal(
    collector.getSamplingReason(
      result({ status: "review", counts: { review: 1 } }),
      "job:review",
      1
    ),
    "needs-review"
  );
  assert.equal(
    collector.getSamplingReason(
      result({ status: "no", counts: { no: 1, yes: 1 } }),
      "job:conflict",
      1
    ),
    "rule-conflict"
  );
  assert.equal(collector.getSamplingReason(result(), "job:none", 0), null);

  [
    result({ status: "unknown", counts: {} }),
    result({ status: "no", counts: { no: 1 } }),
    result({ status: "conditional", counts: { conditional: 1 } }),
    result({ status: "yes", counts: { yes: 1 } })
  ].forEach((scanResult) => {
    assert.equal(
      collector.getSamplingReason(scanResult, "job:automatic", 1),
      "automatic-observation"
    );
  });
});

test("page feedback records confirmation and corrections without becoming training truth", () => {
  const item = capture({
    result: result({ status: "review", counts: { review: 1 } })
  });

  const confirmed = collector.applyPageFeedback(
    item,
    { action: "confirmed" },
    "2026-08-05T10:30:00.000Z"
  );
  assert.deepEqual(confirmed.pageFeedback, {
    action: "confirmed",
    predictedStatus: "review",
    selectedStatus: "review",
    at: "2026-08-05T10:30:00.000Z",
    source: "indicator"
  });
  assert.equal(confirmed.state, "pending");
  assert.equal(collector.toTrainingRows([confirmed]).length, 0);

  const corrected = collector.applyPageFeedback(
    confirmed,
    { action: "corrected", selectedStatus: "no" },
    "2026-08-05T10:31:00.000Z"
  );
  assert.deepEqual(corrected.pageFeedback, {
    action: "corrected",
    predictedStatus: "review",
    selectedStatus: "no",
    at: "2026-08-05T10:31:00.000Z",
    source: "indicator"
  });
  assert.equal(corrected.state, "pending");
  assert.equal(corrected.exportedAt, null);
  assert.equal(collector.toTrainingRows([corrected]).length, 0);

  const reviewed = reviewAll(item, "review").item;
  const correctedAfterReview = collector.applyPageFeedback(
    reviewed,
    { action: "corrected", selectedStatus: "no" },
    "2026-08-05T10:31:30.000Z"
  );
  assert.equal(correctedAfterReview.state, "pending");
  assert.equal(
    collector.planTrainingExport(
      [correctedAfterReview],
      collector.emptyExportLedger()
    ).rows.length,
    0
  );

  const cleared = collector.applyPageFeedback(
    corrected,
    { action: "clear" },
    "2026-08-05T10:32:00.000Z"
  );
  assert.deepEqual(cleared.pageFeedback, {
    action: "confirmed",
    predictedStatus: "review",
    selectedStatus: "review",
    at: null,
    source: "automatic"
  });
  assert.equal(cleared.updatedAt, "2026-08-05T10:32:00.000Z");
  assert.equal(collector.finalPageStatus(cleared), "review");
});

test("final page status follows corrections and excludes non-job records from training", () => {
  const reviewed = reviewAll(capture(), "review").item;
  const excluded = collector.applyPageFeedback(
    reviewed,
    { action: "corrected", selectedStatus: "not-job" },
    "2026-08-05T10:33:00.000Z"
  );

  assert.equal(collector.finalPageStatus(reviewed), "review");
  assert.equal(collector.finalPageStatus(excluded), "not-job");
  assert.equal(collector.isTrainableCapture(excluded), false);
  assert.equal(excluded.state, "pending");
  assert.match(
    collector.validateReview(excluded).errors.join(" "),
    /not an individual job listing/i
  );
  assert.equal(collector.toTrainingRows([excluded]).length, 0);

  const restored = collector.applyPageFeedback(
    excluded,
    { action: "clear" },
    "2026-08-05T10:34:00.000Z"
  );
  assert.equal(collector.finalPageStatus(restored), "review");
  assert.equal(restored.state, "pending");
  assert.equal(restored.exportedAt, null);
});

test("silent confirmation is automatic, idempotent, and remains page-level", () => {
  const item = capture({
    result: result({ status: "no", counts: { no: 1 } }),
    jobKey: "job:silent-confirmation"
  });
  const assumed = collector.applyAutomaticPageConfirmation(item);

  assert.deepEqual(assumed.pageFeedback, {
    action: "confirmed",
    predictedStatus: "no",
    selectedStatus: "no",
    at: null,
    source: "automatic"
  });
  assert.equal(assumed.state, "pending");
  assert.equal(assumed.review.reviewedAt, null);
  assert.deepEqual(assumed.review.candidates, {});
  assert.equal(collector.validateReview(assumed).ready, false);
  assert.equal(collector.toTrainingRows([assumed]).length, 0);

  const repeated = collector.applyAutomaticPageConfirmation(assumed);
  assert.deepEqual(repeated.pageFeedback, assumed.pageFeedback);

  const corrected = collector.applyPageFeedback(
    assumed,
    { action: "corrected", selectedStatus: "yes" },
    "2026-08-05T10:35:00.000Z"
  );
  const correctionPreserved = collector.applyAutomaticPageConfirmation(corrected);
  assert.deepEqual(correctionPreserved.pageFeedback, corrected.pageFeedback);
  assert.equal(correctionPreserved.pageFeedback.source, "indicator");

  const explicitlyConfirmed = collector.applyPageFeedback(
    item,
    { action: "confirmed" },
    "2026-08-05T10:37:00.000Z"
  );
  assert.deepEqual(
    collector.applyAutomaticPageConfirmation(explicitlyConfirmed).pageFeedback,
    explicitlyConfirmed.pageFeedback
  );
});

test("reviewed rows retain automatic page-feedback provenance", () => {
  const assumed = collector.applyAutomaticPageConfirmation(capture({
    result: result({ status: "no", counts: { no: 1 } }),
    jobKey: "job:automatic-feedback-export"
  }));
  const ready = reviewAll(assumed, "no").item;
  const rows = collector.toTrainingRows([ready]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].verified, true);
  assert.equal(rows[0].metadata.page_feedback_action, "confirmed");
  assert.equal(rows[0].metadata.page_feedback_status, "no");
  assert.equal(rows[0].metadata.page_feedback_source, "automatic");
});

test("a confirmation expires when a dynamic rescan changes the predicted result", () => {
  const original = capture({
    result: result({ status: "unknown", counts: {} }),
    jobKey: "job:feedback-status-change"
  });
  const confirmed = collector.applyPageFeedback(
    original,
    { action: "confirmed" },
    "2026-08-05T11:00:00.000Z"
  );
  const rescanned = capture({
    result: result({ status: "no", counts: { no: 1 } }),
    jobKey: "job:feedback-status-change"
  });
  const merged = collector.mergeCapture(confirmed, rescanned);

  assert.equal(confirmed.pageFeedback.predictedStatus, "unknown");
  assert.deepEqual(
    merged.pageFeedback,
    {
      action: "confirmed",
      predictedStatus: "no",
      selectedStatus: "no",
      at: null,
      source: "automatic"
    }
  );
});

test("PII-bearing passages are dropped without altering safe exact text", () => {
  const safeText = "Candidates must not require visa sponsorship now or later.";
  const item = capture({
    candidates: [
      candidate(safeText, 10),
      candidate("Questions about sponsorship: recruiter@example.com", 90),
      candidate("Visa support line: (415) 555-0199", 180)
    ],
    page: {
      url: "https://jobs.example.com/role/12?email=user@example.com&token=abc",
      title: "A".repeat(240)
    }
  });

  assert.ok(item);
  assert.equal(item.candidates.length, 1);
  assert.equal(item.candidates[0].text, safeText);
  assert.equal(item.page.origin, "https://jobs.example.com");
  assert.equal(item.page.siteFamily, "example.com");
  assert.equal(Object.hasOwn(item.page, "url"), false);
  assert.equal(item.page.title.length, 180);
  assert.deepEqual(item.privacy, {
    fullPageStored: false,
    rawUrlStored: false,
    applicationFlowStored: false,
    piiScan: "passed"
  });

  assert.equal(capture({
    candidates: [candidate("Email visa questions to person@example.com")]
  }), null);
  assert.equal(collector.containsSensitiveText("Call +1 212-555-0198 about visas"), true);
  assert.equal(collector.containsSensitiveText("Call +44 20 7946 0958 about visas"), true);
  assert.equal(collector.containsSensitiveText("Visa sponsorship is unavailable"), false);
});

test("rule suggestions retain exact candidate-relative evidence", () => {
  const text = "Applicants will not receive visa sponsorship for this role.";
  const pageStart = 250;
  const matchedText = "will not receive visa sponsorship";
  const matchStart = text.indexOf(matchedText);
  const item = capture({
    candidates: [candidate(text, pageStart)],
    result: result({
      status: "no",
      counts: { no: 1 },
      evidence: [{
        category: "no",
        ruleId: "no_visa_support",
        index: pageStart + matchStart,
        matchedText
      }]
    }),
    reason: "automatic-observation"
  });

  assert.deepEqual(item.candidates[0].suggestion, {
    label: "no",
    ruleId: "no_visa_support",
    source: "rule",
    evidence: {
      start: matchStart,
      end: matchStart + matchedText.length,
      text: matchedText
    }
  });

  const conflict = capture({
    candidates: [candidate(text, pageStart)],
    result: result({
      status: "review",
      counts: { no: 1, yes: 1 },
      evidence: [
        { category: "no", ruleId: "no-rule", index: pageStart, matchedText: text },
        { category: "yes", ruleId: "yes-rule", index: pageStart, matchedText: text }
      ]
    }),
    reason: "rule-conflict"
  });
  assert.deepEqual(conflict.candidates[0].suggestion, {
    label: "review",
    ruleId: null,
    evidence: null,
    source: "rule-conflict"
  });
});

test("automatic merging leaves completed human reviews byte-for-byte unchanged", () => {
  const original = capture();
  const reviewed = reviewAll(original).item;
  const exported = collector.markExported(reviewed, "2026-08-05T11:00:00.000Z");
  const repeat = capture({
    capturedAt: "2026-08-06T10:00:00.000Z",
    page: { url: "https://jobs.example.com/opening/123?new=tracking", title: "Updated" }
  });
  const merged = collector.mergeCapture(exported, repeat);

  assert.strictEqual(merged, exported);
  assert.equal(collector.isReviewLocked(exported), true);

  const newText = "We can sponsor an H-1B visa for exceptional candidates.";
  const expandedIncoming = capture({
    candidates: [
      candidate(original.candidates[0].text, 100),
      candidate(newText, 500)
    ]
  });
  const expanded = collector.mergeCapture(exported, expandedIncoming);
  assert.strictEqual(expanded, exported);
  assert.equal(expanded.candidates.length, 1);
  assert.equal(expanded.state, "exported");
  assert.equal(expanded.exportedAt, exported.exportedAt);
});

test("a pending capture admits stronger passages that load later", () => {
  const firstText = "Work authorization details require review.";
  const secondText = "Visa eligibility depends on the role.";
  const thirdText = "The team follows export control requirements.";
  const lateText = "We will not sponsor applicants for employment visas.";
  const initial = capture({
    jobKey: "job:progressive",
    candidates: [
      candidate(firstText, 10),
      candidate(secondText, 80),
      candidate(thirdText, 150)
    ]
  });
  const later = capture({
    jobKey: "job:progressive",
    candidates: [
      candidate(lateText, 220),
      candidate(firstText, 10),
      candidate(secondText, 80)
    ],
    textFingerprint: "later-page-state"
  });

  const merged = collector.mergeCapture(initial, later);
  assert.deepEqual(
    merged.candidates.map((entry) => entry.text),
    [lateText, firstText, secondText]
  );
  assert.equal(merged.state, "pending");
});

test("a richer rescan replaces an unreviewed heading-only candidate", () => {
  const heading = "Citizenship Requirements:";
  const context = `${heading}\nApplicants must be a U.S. citizen or permanent resident.`;
  const initial = capture({
    jobKey: "job:heading-context",
    candidates: [candidate(heading, 40)]
  });
  const rescanned = capture({
    jobKey: "job:heading-context",
    candidates: [candidate(context, 40)]
  });

  const merged = collector.mergeCapture(initial, rescanned);
  assert.equal(merged.candidates.length, 1);
  assert.equal(merged.candidates[0].text, context);
  assert.equal(merged.state, "pending");
});

test("review validation requires all labels, a group, and exact evidence", () => {
  const item = capture();
  const candidateId = item.candidates[0].candidateId;
  const empty = collector.validateReview(item);
  assert.equal(empty.ready, false);
  assert.match(empty.errors.join(" "), /choose a label/i);

  const mismatched = collector.applyReview(item, {
    groupId: "ok-group",
    candidates: {
      [candidateId]: {
        label: "review",
        evidence: { start: 0, end: 4, text: "WRONG" }
      }
    }
  });
  assert.equal(mismatched.validation.ready, false);
  assert.match(mismatched.validation.errors.join(" "), /select evidence|exactly match/i);
  assert.equal(mismatched.item.review.reviewedAt, null);

  const tampered = structuredClone(item);
  tampered.review = {
    groupId: "ok-group",
    candidates: {
      [candidateId]: {
        label: "review",
        evidence: { start: 0, end: 4, text: "WRONG" }
      }
    }
  };
  assert.match(
    collector.validateReview(tampered).errors.join(" "),
    /exactly match/i
  );

  const tooShortGroup = collector.applyReview(item, {
    groupId: "x",
    candidates: {
      [candidateId]: {
        label: "no",
        evidence: { start: 0, end: item.candidates[0].text.length, text: item.candidates[0].text }
      }
    }
  });
  assert.equal(tooShortGroup.validation.ready, false);
  assert.match(tooShortGroup.validation.errors.join(" "), /group id/i);

  const irrelevant = collector.applyReview(item, {
    groupId: "valid-group",
    candidates: {
      [candidateId]: {
        label: "irrelevant",
        evidence: { start: 0, end: 2, text: "Vi" }
      }
    }
  });
  assert.equal(irrelevant.validation.ready, true);
  assert.equal(irrelevant.item.review.candidates[candidateId].evidence, null);
  assert.equal(irrelevant.item.state, "ready");
  assert.ok(irrelevant.item.review.reviewedAt);
});

test("training export is verified, schema-compatible, exact, and deterministic", () => {
  const text = "Applicants will not receive visa sponsorship for this role.";
  const pageStart = 300;
  const exact = "will not receive visa sponsorship";
  const exactStart = text.indexOf(exact);
  const base = capture({
    jobKey: "job:export:1",
    capturedAt: "2026-08-05T08:00:00.000Z",
    candidates: [candidate(text, pageStart)],
    result: result({
      status: "no",
      counts: { no: 1 },
      evidence: [{
        category: "no",
        ruleId: "no_visa_support",
        index: pageStart + exactStart,
        matchedText: exact
      }]
    }),
    reason: "automatic-observation"
  });
  const ready = collector.applyReview(base, {
    groupId: "employer-template-a",
    candidates: {
      [base.candidates[0].candidateId]: {
        label: "no",
        evidence: {
          start: exactStart,
          end: exactStart + exact.length,
          text: exact
        }
      }
    }
  }).item;
  const later = reviewAll(capture({
    jobKey: "job:export:2",
    capturedAt: "2026-08-06T08:00:00.000Z",
    candidates: [candidate("Visa eligibility should be checked with recruiting.")]
  })).item;

  const forward = collector.toTrainingRows([ready, later]);
  const reverse = collector.toTrainingRows([later, ready]);
  assert.deepEqual(reverse, forward);
  assert.equal(forward.length, 2);

  const row = forward[0];
  assert.deepEqual(Object.keys(row).sort(), [
    "evidence", "group_id", "id", "label", "metadata", "rule_id", "source", "text", "verified"
  ]);
  assert.equal(row.text, text);
  assert.equal(row.label, "no");
  assert.deepEqual(row.evidence, {
    start: exactStart,
    end: exactStart + exact.length,
    text: exact
  });
  assert.equal(row.rule_id, "no_visa_support");
  assert.equal(row.verified, true);
  assert.equal(row.source, "sponsorlens_local_review");
  assert.equal(row.metadata.capture_id, ready.captureId);
  assert.equal(Object.hasOwn(row, "split"), false);
  assert.equal(Object.hasOwn(row.metadata, "raw_url"), false);
  assert.equal(row.text.slice(row.evidence.start, row.evidence.end), row.evidence.text);
  assert.equal(collector.toTrainingRows([capture()]).length, 0);
});

test("exported JSONL passes the real training-data and runtime-gate validator", () => {
  const text = "Applicants must not require visa sponsorship now or in the future.";
  const candidates = localModelPolicy.extractCandidateWindows(text, { maxWindows: 3 });
  const item = capture({
    jobKey: "job:validator:1",
    candidates,
    result: result({ status: "review", counts: { review: 1 } })
  });
  const ready = reviewAll(item, "no").item;
  const rows = collector.toTrainingRows([ready]);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "sponsorlens-collector-")
  );
  const dataPath = path.join(temporaryDirectory, "reviewed.jsonl");
  fs.writeFileSync(
    dataPath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
  );

  try {
    const validated = childProcess.spawnSync(
      "python3",
      [path.resolve(__dirname, "../training/validate_data.py"), dataPath],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8"
      }
    );
    assert.equal(validated.status, 0, validated.stderr);
    const summary = JSON.parse(validated.stdout);
    assert.equal(summary.examples, 1);
    assert.equal(summary.verified, 1);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("training export deduplicates matching observations and rejects label conflicts", () => {
  const text = "Visa sponsorship is available for this role.";
  const firstBase = capture({
    jobKey: "job:duplicate:1",
    candidates: [candidate(text)],
    capturedAt: "2026-08-01T00:00:00.000Z"
  });
  firstBase.observationCount = 2;
  const secondBase = capture({
    jobKey: "job:duplicate:2",
    candidates: [candidate(`  ${text}  `)],
    capturedAt: "2026-08-02T00:00:00.000Z"
  });
  secondBase.observationCount = 3;
  const first = reviewAll(firstBase, "yes").item;
  const second = reviewAll(secondBase, "yes").item;

  const deduplicated = collector.toTrainingRows([second, first]);
  assert.equal(deduplicated.length, 1);
  assert.equal(deduplicated[0].metadata.observation_count, 5);
  assert.equal(deduplicated[0].group_id, "example-template");

  const conflicting = reviewAll(secondBase, "no").item;
  assert.throws(
    () => collector.toTrainingRows([first, conflicting]),
    (error) => error &&
      error.code === "conflicting-labels" &&
      error.captureIds.includes(first.captureId) &&
      error.captureIds.includes(conflicting.captureId)
  );
});

test("incremental exports skip history and block cross-batch label conflicts", () => {
  const text = "Visa sponsorship is available for this role.";
  const historicalBase = capture({
    jobKey: "job:history:1",
    candidates: [candidate(text)],
    capturedAt: "2026-08-01T00:00:00.000Z"
  });
  const historical = collector.markExported(
    reviewAll(historicalBase, "yes").item,
    "2026-08-02T00:00:00.000Z"
  );
  const repeated = reviewAll(capture({
    jobKey: "job:history:2",
    candidates: [candidate(text)],
    capturedAt: "2026-08-03T00:00:00.000Z"
  }), "yes").item;
  const unique = reviewAll(capture({
    jobKey: "job:history:3",
    candidates: [candidate("Visa sponsorship is unavailable for this role.")],
    capturedAt: "2026-08-04T00:00:00.000Z"
  }), "no").item;

  const ledger = collector.addRowsToExportLedger(
    collector.emptyExportLedger(),
    collector.toTrainingRows([historical]),
    "2026-08-02T00:00:00.000Z"
  );
  const plan = collector.planTrainingExport([repeated, unique], ledger);
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].text, unique.candidates[0].text);
  assert.equal(plan.duplicateRowCount, 1);
  assert.equal(plan.revisionRowCount, 0);
  assert.deepEqual(new Set(plan.captureIds), new Set([
    repeated.captureId,
    unique.captureId
  ]));

  const conflicting = reviewAll(capture({
    jobKey: "job:history:4",
    candidates: [candidate(text)]
  }), "no").item;
  assert.throws(
    () => collector.planTrainingExport([conflicting], ledger),
    (error) => error && error.code === "conflicting-labels" && error.historical
  );

  const evidenceText = "Visa sponsorship";
  const evidenceStart = text.indexOf(evidenceText);
  const revisedSameCapture = collector.applyReview(historicalBase, {
    groupId: "corrected-template-group",
    candidates: {
      [historicalBase.candidates[0].candidateId]: {
        label: "yes",
        evidence: {
          start: evidenceStart,
          end: evidenceStart + evidenceText.length,
          text: evidenceText
        }
      }
    }
  }).item;
  const revisionPlan = collector.planTrainingExport([revisedSameCapture], ledger);
  assert.equal(revisionPlan.rows.length, 1);
  assert.equal(revisionPlan.revisionRowCount, 1);
  assert.equal(revisionPlan.duplicateRowCount, 0);
  assert.equal(revisionPlan.rows[0].id, collector.toTrainingRows([historical])[0].id);
  assert.equal(revisionPlan.rows[0].group_id, "corrected-template-group");
  const revisedLedger = collector.addRowsToExportLedger(
    revisionPlan.ledger,
    revisionPlan.rows,
    "2026-08-05T13:00:00.000Z"
  );
  assert.equal(
    revisedLedger.entries[revisionPlan.rows[0].id].rowHash,
    collector.trainingRowRevisionHash(revisionPlan.rows[0])
  );

  const correctedSameCapture = reviewAll(historicalBase, "no").item;
  assert.throws(
    () => collector.planTrainingExport([correctedSameCapture], ledger),
    (error) => error &&
      error.code === "conflicting-labels" &&
      error.captureIds.includes(correctedSameCapture.captureId)
  );

  assert.throws(
    () => collector.normalizeExportLedger({ version: 1, entries: {
      "local-invalid": { label: "yes", exportedAt: "not-a-date" }
    } }),
    /invalid entry/i
  );
});

test("storage helpers isolate collector records and sort them predictably", () => {
  const older = capture({
    jobKey: "job:older",
    capturedAt: "2026-08-01T00:00:00.000Z"
  });
  const newer = capture({
    jobKey: "job:newer",
    capturedAt: "2026-08-02T00:00:00.000Z"
  });
  const values = {
    unrelated: { captureId: "not-a-capture" },
    [collector.storageKey(older.captureId)]: older,
    [collector.storageKey(newer.captureId)]: newer
  };

  assert.equal(collector.storageKey(""), "");
  assert.equal(collector.isItemKey("unrelated"), false);
  assert.equal(collector.isItemKey(collector.storageKey(older.captureId)), true);
  assert.deepEqual(
    collector.itemsFromStorage(values).map((item) => item.captureId),
    [newer.captureId, older.captureId]
  );

  const pending = capture({ jobKey: "job:pending" });
  assert.strictEqual(collector.markExported(pending), pending);
  const ready = reviewAll(pending).item;
  const exported = collector.markExported(ready, "2026-08-05T12:00:00.000Z");
  assert.equal(exported.state, "exported");
  assert.equal(exported.exportedAt, "2026-08-05T12:00:00.000Z");
});

test("the latest export receipt can be validated and downloaded again", () => {
  const reviewed = reviewAll(capture({
    jobKey: "job:last-export-receipt",
    candidates: [candidate("Visa sponsorship is available for this role.")]
  }), "yes").item;
  const rows = collector.toTrainingRows([reviewed]);
  const receipt = collector.createExportReceipt(
    rows,
    "2026-08-05T13:00:00.000Z"
  );

  assert.equal(receipt.rowCount, 1);
  assert.deepEqual(receipt.rows, rows);
  assert.deepEqual(collector.exportReceiptSummary(receipt), {
    exportId: receipt.exportId,
    createdAt: "2026-08-05T13:00:00.000Z",
    rowCount: 1
  });
  assert.deepEqual(collector.normalizeExportReceipt(receipt), receipt);

  const invalid = structuredClone(receipt);
  invalid.rows[0].evidence.text = "not exact";
  assert.throws(
    () => collector.normalizeExportReceipt(invalid),
    /invalid evidence/i
  );
});
