"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const analyzer = require("../lib/analyzer.js");

const NON_JOB_META = {
  url: "https://github.com/SimplifyJobs/New-Grad-Positions",
  title: "GitHub - SimplifyJobs/New-Grad-Positions"
};

const COLLECTION_TEXT = `
  2026 New Grad Positions
  Browse hundreds of new graduate roles.
  Legend
  Does NOT offer sponsorship
  Requires U.S. Citizenship
  Company Role Location Application Age
`;

test("automatic analysis skips a job collection page", () => {
  const result = analyzer.analyze(COLLECTION_TEXT, NON_JOB_META, {
    skipNonJob: true
  });

  assert.equal(result.isLikelyJobPage, false);
  assert.equal(result.scanMode, "skipped");
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.evidence, []);
});

test("manual page-wide analysis scans the same collection text", () => {
  const result = analyzer.analyze(COLLECTION_TEXT, NON_JOB_META, {
    pageWide: true
  });

  assert.equal(result.isLikelyJobPage, false);
  assert.equal(result.scanMode, "page");
  assert.equal(result.status, "no");
  assert.equal(result.evidence[0].ruleId, "no_action_sponsorship");
});

test("automatic analysis skips product documentation with sponsorship examples", () => {
  const result = analyzer.analyze(
    `
      SponsorLens results:
      No sponsorship
      Sponsorship available
      Must be authorized to work in the US
    `,
    {
      url: "https://github.com/ZhiqiaoGong/sponsorlens-job-sponsorship-checker",
      title: "GitHub - ZhiqiaoGong/sponsorlens-job-sponsorship-checker"
    },
    { skipNonJob: true }
  );

  assert.equal(result.isLikelyJobPage, false);
  assert.equal(result.scanMode, "skipped");
  assert.equal(result.status, "unknown");
  assert.equal(result.evidence.length, 0);
});

test("automatic analysis still evaluates an individual job listing", () => {
  const result = analyzer.analyze(
    `
      Software Engineer
      Job description
      Responsibilities
      Build reliable distributed systems.
      Qualifications
      Visa sponsorship is not available for this position.
      Apply for this job
    `,
    {
      url: "https://example.com/jobs/software-engineer-123",
      title: "Software Engineer"
    },
    { skipNonJob: true }
  );

  assert.equal(result.isLikelyJobPage, true);
  assert.equal(result.scanMode, "job");
  assert.equal(result.status, "no");
  assert.ok(result.evidence.length > 0);
});

test("explicit citizenship exclusions outrank a clearance requirement", () => {
  const result = analyzer.analyze(
    `
      Software Cloud Engineer - Junior Position Requirements
      • U.S. Citizenship (No exceptions; green card holders are not eligible)
      • Ability to obtain and maintain a DoD security clearance
    `,
    {
      url: "https://example.com/jobs/software-cloud-engineer-junior",
      title: "Software Cloud Engineer - Junior Position"
    },
    { skipNonJob: true }
  );

  assert.equal(result.status, "no");
  assert.equal(result.evidence[0].ruleId, "citizenship_no_exceptions");
  assert.equal(result.evidence[0].category, "no");
  assert.match(
    result.evidence[0].matchedText,
    /green card holders are not eligible/i
  );
  assert.ok(result.evidence.some((item) => {
    return item.ruleId === "clearance_requirement" &&
      item.category === "review";
  }));
});

test("bare clearance eligibility language is flagged for review", () => {
  const result = analyzer.analyze(
    `
      Junior Full Stack Developer
      Required Qualifications
      • 0–2 years of software development experience.
      • Must be eligible for Clearance.
    `,
    {
      url: "https://www.linkedin.com/jobs/view/123",
      title: "Junior Full Stack Developer"
    },
    { skipNonJob: true }
  );

  assert.equal(result.status, "review");
  assert.equal(result.evidence[0].ruleId, "clearance_requirement");
  assert.equal(result.evidence[0].category, "review");
  assert.match(
    result.evidence[0].matchedText,
    /must be eligible for clearance/i
  );
});
