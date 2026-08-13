"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const policy = require("../lib/local-model-policy.js");

function baseResult(overrides) {
  return {
    status: "unknown",
    label: "Not mentioned",
    shortLabel: "Not mentioned",
    summary: "No clear sponsorship information was found on this page.",
    color: "#64748b",
    evidence: [],
    counts: { no: 0, conditional: 0, yes: 0, review: 0 },
    isLikelyJobPage: true,
    scanMode: "job",
    ...overrides
  };
}

const ARTIFACT = {
  version: "test-model",
  thresholds: {
    no: 0.96,
    conditional: 0.94,
    yes: 0.96,
    review: 0.9,
    irrelevant: 0.9
  }
};

test("candidate windows retain normalized page offsets", () => {
  const text = `
    About the role
    Build reliable software for customers.
    Applicants must already have unrestricted employment authorization.
    Visa support is unavailable for this opening.
    Benefits include health insurance.
  `;
  const normalized = policy.normalizeText(text);
  const candidates = policy.extractCandidateWindows(text);

  assert.ok(candidates.length >= 1);
  candidates.forEach((candidate) => {
    assert.equal(
      normalized.slice(candidate.index, candidate.end),
      candidate.text
    );
  });
  assert.ok(candidates.some((candidate) => /visa support/i.test(candidate.text)));
});

test("candidate extraction deduplicates nearby sponsorship terms", () => {
  const candidates = policy.extractCandidateWindows(
    "Visa sponsorship and H-1B sponsorship are not available for this role."
  );

  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].signals.length >= 2);
});

test("candidate extraction covers less explicit immigration wording", () => {
  const candidates = policy.extractCandidateWindows(
    "International applicants may require an employment petition after joining."
  );

  assert.equal(candidates.length, 1);
  assert.match(candidates[0].text, /international applicants/i);
});

test("periods inside U.S. abbreviations do not split a candidate", () => {
  const text = "Legal authorization to work in the U.S. is required.";
  const candidates = policy.extractCandidateWindows(text);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].text, text);
});

test("a sponsorship heading keeps the explanatory paragraph that follows it", () => {
  const text = [
    "Citizenship Requirements:",
    "Applicants must be a U.S. citizen or permanent resident.",
    "Benefits:",
    "Medical insurance is provided."
  ].join("\n");
  const normalized = policy.normalizeText(text);
  const candidates = policy.extractCandidateWindows(text);

  assert.equal(candidates.length, 1);
  assert.equal(
    candidates[0].text,
    "Citizenship Requirements:\nApplicants must be a U.S. citizen or permanent resident."
  );
  assert.equal(
    normalized.slice(candidates[0].index, candidates[0].end),
    candidates[0].text
  );
  assert.doesNotMatch(candidates[0].text, /Benefits/);
});

test("a title-style eligibility heading gains context without swallowing the next section", () => {
  const text = [
    "Export Control Regulations",
    "Applicants must be eligible to obtain the required authorization from the U.S. Department of State.",
    "Benefits",
    "Medical insurance is provided."
  ].join("\n");
  const candidates = policy.extractCandidateWindows(text);

  assert.equal(candidates.length, 1);
  assert.match(candidates[0].text, /^Export Control Regulations\nApplicants must/i);
  assert.doesNotMatch(candidates[0].text, /Benefits/);
  assert.ok(candidates[0].signalSpans.length >= 2);
});

test("a heading is not joined to another heading when its explanation is absent", () => {
  const candidates = policy.extractCandidateWindows([
    "Citizenship Requirements:",
    "Benefits:",
    "Medical insurance is provided."
  ].join("\n"));

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].text, "Citizenship Requirements:");
});

test("every checked-in model example can pass the runtime candidate gate", () => {
  const examples = fs.readFileSync(
    require.resolve("../training/data/seed.jsonl"),
    "utf8"
  ).trim().split("\n").map(JSON.parse);
  const unreachable = examples.filter((example) => {
    const normalized = policy.normalizeText(example.text);
    return !policy.extractCandidateWindows(example.text).some((candidate) => {
      return candidate.text === normalized;
    });
  });

  assert.deepEqual(unreachable.map((example) => example.id), []);
});

test("the local model only runs for unclear individual job results", () => {
  const settings = { localModelEnabled: true };

  assert.equal(policy.shouldRun(baseResult(), settings, {}), true);
  assert.equal(
    policy.shouldRun(baseResult({ status: "review" }), settings, {}),
    true
  );
  assert.equal(
    policy.shouldRun(baseResult({ status: "no" }), settings, {}),
    false
  );
  assert.equal(
    policy.shouldRun(baseResult({ scanMode: "page" }), settings, {}),
    false
  );
  assert.equal(
    policy.shouldRun(baseResult(), settings, { isApplicationFlow: true }),
    false
  );
  assert.equal(
    policy.shouldRun(baseResult(), { localModelEnabled: false }, {}),
    false
  );
});

test("a calibrated high-confidence prediction can resolve unknown", () => {
  const candidates = policy.extractCandidateWindows(
    "For this opening, the company is unable to assist with immigration petitions."
  );
  assert.equal(candidates.length, 1);

  const result = policy.mergePredictions(
    baseResult(),
    candidates,
    [{ windowId: candidates[0].id, label: "no", score: 0.98 }],
    ARTIFACT
  );

  assert.equal(result.status, "no");
  assert.equal(result.analysisSource, "rules+local-model");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].source, "local-model");
  assert.equal(result.evidence[0].matchedText, candidates[0].text);
  assert.equal(result.evidence[0].index, candidates[0].index);
});

test("long model evidence keeps the trigger text and its exact offset", () => {
  const prefix = "Background context without a decision ".repeat(8);
  const text = `${prefix}Visa assistance is unavailable for this opening.`;
  const normalized = policy.normalizeText(text);
  const candidates = policy.extractCandidateWindows(text);
  const result = policy.mergePredictions(
    baseResult(),
    candidates,
    [{ windowId: candidates[0].id, label: "no", score: 0.99 }],
    ARTIFACT
  );
  const evidence = result.evidence[0];

  assert.match(evidence.matchedText, /visa assistance/i);
  assert.equal(
    normalized.slice(evidence.index, evidence.index + evidence.matchedText.length),
    evidence.matchedText
  );
});

test("model evidence retains every trigger in a long merged window", () => {
  const text = `Visa information ${"background context ".repeat(14)}will not sponsor applicants.`;
  const candidates = policy.extractCandidateWindows(text);
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].signalSpans.length >= 2);

  const result = policy.mergePredictions(
    baseResult(),
    candidates,
    [{ windowId: candidates[0].id, label: "no", score: 0.99 }],
    ARTIFACT
  );

  assert.match(result.evidence[0].matchedText, /^Visa information/i);
  assert.match(result.evidence[0].matchedText, /will not sponsor applicants/i);
});

test("an uncalibrated or below-threshold prediction cannot change a result", () => {
  const candidates = policy.extractCandidateWindows(
    "The team may be able to support a work visa after the first year."
  );
  const prediction = {
    windowId: candidates[0].id,
    label: "conditional",
    score: 0.93
  };

  const withoutThresholds = policy.mergePredictions(
    baseResult(),
    candidates,
    [prediction],
    { version: "uncalibrated" }
  );
  const belowThreshold = policy.mergePredictions(
    baseResult(),
    candidates,
    [prediction],
    ARTIFACT
  );

  assert.equal(withoutThresholds.status, "unknown");
  assert.equal(withoutThresholds.model.state, "no-decision");
  assert.equal(belowThreshold.status, "unknown");
  assert.equal(belowThreshold.model.state, "no-decision");
});

test("a null threshold is an abstention even for a score of one", () => {
  const candidates = policy.extractCandidateWindows(
    "Visa sponsorship may be considered after an individual review."
  );
  const result = policy.mergePredictions(
    baseResult(),
    candidates,
    [{ windowId: candidates[0].id, label: "conditional", score: 1 }],
    {
      version: "not-calibrated",
      thresholds: { conditional: null }
    }
  );

  assert.equal(result.status, "unknown");
  assert.equal(result.model.state, "no-decision");
});

test("thresholds outside zero to one are rejected", () => {
  const candidates = policy.extractCandidateWindows(
    "Visa sponsorship is unavailable for this role."
  );
  for (const threshold of [-0.1, 1.1]) {
    const result = policy.mergePredictions(
      baseResult(),
      candidates,
      [{ windowId: candidates[0].id, label: "no", score: 0.99 }],
      { version: "invalid-threshold", thresholds: { no: threshold } }
    );
    assert.equal(result.status, "unknown");
  }
});

test("conflicting decisive predictions fall back to review", () => {
  const candidates = policy.extractCandidateWindows(`
    Some positions offer visa sponsorship.
    This particular opening cannot support a work visa.
  `);
  assert.equal(candidates.length, 2);

  const result = policy.mergePredictions(
    baseResult(),
    candidates,
    [
      { windowId: candidates[0].id, label: "yes", score: 0.98 },
      { windowId: candidates[1].id, label: "no", score: 0.99 }
    ],
    ARTIFACT
  );

  assert.equal(result.status, "review");
  assert.equal(result.model.state, "conflict");
  assert.match(result.summary, /conflicting sponsorship language/i);
  assert.equal(result.evidence.length, 2);
  assert.ok(result.evidence.every((item) => item.source === "local-model"));
  assert.ok(result.evidence.every((item) => item.matchedText));
});

test("a decisive prediction wins over a higher-scoring review prediction", () => {
  const candidates = policy.extractCandidateWindows(`
    Applicants must be authorized to work in the United States.
    The employer is unable to support an employment visa for this role.
  `);
  assert.equal(candidates.length, 2);

  const result = policy.mergePredictions(
    baseResult({ status: "review" }),
    candidates,
    [
      { windowId: candidates[0].id, label: "review", score: 0.99 },
      { windowId: candidates[1].id, label: "no", score: 0.98 }
    ],
    ARTIFACT
  );

  assert.equal(result.status, "no");
  assert.equal(result.evidence[0].category, "no");
});

test("irrelevant predictions leave the rule result untouched", () => {
  const candidates = policy.extractCandidateWindows(
    "Benefits include a company-sponsored wellness program."
  );
  const result = policy.mergePredictions(
    baseResult(),
    candidates,
    [{ windowId: candidates[0].id, label: "irrelevant", score: 0.99 }],
    ARTIFACT
  );

  assert.equal(result.status, "unknown");
  assert.deepEqual(result.evidence, []);
  assert.equal(result.model.state, "no-decision");
});

test("a model decision never replaces an existing decisive rule result", () => {
  const candidates = policy.extractCandidateWindows(
    "We can provide visa sponsorship to qualified candidates."
  );
  const result = policy.mergePredictions(
    baseResult({
      status: "no",
      label: "No sponsorship",
      evidence: [{ category: "no", index: 0 }]
    }),
    candidates,
    [{ windowId: candidates[0].id, label: "yes", score: 0.99 }],
    ARTIFACT
  );

  assert.equal(result.status, "no");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.model, undefined);
});
