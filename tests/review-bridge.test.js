"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const bridge = require("../tools/review-bridge.js");

function pendingItem(overrides) {
  return {
    captureId: "capture-1",
    pageFingerprintHash: "fingerprint-1",
    state: "pending",
    page: {
      title: "Software Engineer",
      origin: "jobs.example.com"
    },
    baseResult: { status: "unknown" },
    pageFeedback: {
      action: "confirmed",
      selectedStatus: "unknown"
    },
    review: {
      groupId: "job-company-template",
      candidates: {}
    },
    candidates: [
      {
        candidateId: "candidate-1",
        text: "Employer will not sponsor applicants for employment visas.",
        suggestion: {
          label: "no",
          ruleId: "no_sponsor_candidates",
          evidence: {
            start: 9,
            end: 53,
            text: "will not sponsor applicants for employment"
          }
        }
      },
      {
        candidateId: "candidate-2",
        text: "Benefits include company-sponsored health insurance.",
        suggestion: null
      }
    ],
    ...(overrides || {})
  };
}

test("the bridge exports only Pending captures that have passages", () => {
  const ready = pendingItem({ captureId: "ready", state: "ready" });
  const diagnostic = pendingItem({ captureId: "empty", candidates: [] });
  const payload = bridge.createExport(
    [pendingItem(), ready, diagnostic],
    "2026-08-17T00:00:00.000Z"
  );

  assert.equal(payload.format, bridge.FORMAT);
  assert.equal(payload.version, bridge.VERSION);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].captureId, "capture-1");
  assert.equal(payload.items[0].apply, false);
  assert.equal(payload.items[0].candidates[0].suggestedLabel, "no");
  assert.equal(payload.items[0].candidates[0].label, null);
  assert.equal(payload.counts.omitted, 2);
});

test("a completed AI file becomes an exact collector review action", () => {
  const current = pendingItem();
  const imported = bridge.createExport([current]).items[0];
  imported.apply = true;
  imported.pageResult.finalStatus = "no";
  imported.candidates[0].label = "no";
  imported.candidates[0].evidenceText = "will not sponsor applicants for employment visas";
  imported.candidates[1].label = "irrelevant";
  imported.candidates[1].evidenceText = null;

  const action = bridge.buildReviewAction(current, imported);

  assert.equal(action.skipped, false);
  assert.equal(action.desiredFinalStatus, "no");
  assert.deepEqual(action.review.candidates["candidate-1"], {
    label: "no",
    evidence: {
      start: 9,
      end: 57,
      text: "will not sponsor applicants for employment visas"
    }
  });
  assert.deepEqual(action.review.candidates["candidate-2"], {
    label: "irrelevant",
    evidence: null
  });
});

test("the bridge rejects modified passages and ambiguous evidence", () => {
  const current = pendingItem({
    candidates: [{
      candidateId: "candidate-1",
      text: "sponsor policy: sponsor decisions require review."
    }]
  });
  const changed = bridge.createExport([current]).items[0];
  changed.apply = true;
  changed.candidates[0].label = "review";
  changed.candidates[0].evidenceText = "sponsor";
  changed.candidates[0].text = "Modified text";
  assert.throws(
    () => bridge.buildReviewAction(current, changed),
    /text was modified/i
  );

  const ambiguous = bridge.createExport([current]).items[0];
  ambiguous.apply = true;
  ambiguous.candidates[0].label = "review";
  ambiguous.candidates[0].evidenceText = "sponsor";
  assert.throws(
    () => bridge.buildReviewAction(current, ambiguous),
    /appears more than once/i
  );
});

test("the bridge never reopens an already reviewed capture", () => {
  const current = pendingItem({ state: "ready" });
  const imported = bridge.createExport([pendingItem()]).items[0];
  imported.apply = true;
  const action = bridge.buildReviewAction(current, imported);

  assert.equal(action.skipped, true);
  assert.equal(action.reason, "capture-is-already-reviewed");
});
