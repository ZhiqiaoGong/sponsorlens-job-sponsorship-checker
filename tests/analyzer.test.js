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

test("an embedded board listing is evaluated without the classic headings", () => {
  const result = analyzer.analyze(
    `
      Software Engineer, New Grad
      San Mateo, CA
      IXL Learning is seeking New Grad Software Engineers to build new products.
      This position requires you to be in our San Mateo, CA, headquarters office.
      H1B sponsorship is available for this position.
      WHAT YOU'LL BE DOING
      As a Software Engineer, you will build the back-end wiring and the UI.
      WHAT WE'RE LOOKING FOR
      Apply now
    `,
    {
      url: "https://www.ixl.com/company/careers?gh_jid=8662881002",
      title: "IXL Learning | Join our team"
    },
    { skipNonJob: true }
  );

  assert.equal(result.isLikelyJobPage, true);
  assert.equal(result.scanMode, "job");
  assert.equal(result.status, "yes");
});

test("the careers index behind an embedded board is still skipped", () => {
  const result = analyzer.analyze(
    `
      Join our team
      Explore open roles across our offices.
      Software Engineer, New Grad — San Mateo, CA
      Senior Software Engineer — Raleigh-Durham, NC
      Recruiting Coordinator, New Grad — San Mateo, CA
    `,
    {
      url: "https://www.ixl.com/company/careers",
      title: "IXL Learning | Join our team"
    },
    { skipNonJob: true }
  );

  assert.equal(result.isLikelyJobPage, false);
  assert.equal(result.scanMode, "skipped");
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

test("enumerated ITAR eligibility language is flagged for review", () => {
  const result = analyzer.analyze(
    `
      Application Software Engineer, Applied AI
      Itar Requirements
      To conform to U.S. Government export regulations, applicant must be a
      (i) U.S. citizen or national, (ii) U.S. lawful, permanent resident
      (aka green card holder), (iii) Refugee under 8 U.S.C. 1157, or
      (iv) Asylee under 8 U.S.C. 1158, or be eligible to obtain the required
      authorizations from the U.S. Department of State. Learn more about the
      ITAR here.
    `,
    {
      url: "https://www.linkedin.com/jobs/view/4447241380",
      title: "Application Software Engineer, Applied AI"
    },
    { skipNonJob: true }
  );

  assert.equal(result.status, "review");
  assert.equal(result.evidence[0].ruleId, "us_person_export");
  assert.equal(result.evidence[0].category, "review");
  assert.equal(
    result.evidence.some((item) => item.category === "no"),
    false
  );
  assert.match(
    result.evidence[0].matchedText,
    /export regulations[\s\S]+applicant must be[\s\S]+U\.S\. citizen/i
  );
});

test("citizenship or green-card requirements are treated as ineligible for sponsorship", () => {
  const result = analyzer.analyze(
    `
      Platform Engineer
      About the job
      This position requires activities that are subject to US Export Control
      Laws and require US Citizenship or Green Card Holder.
      Benefits include a company-sponsored wellness stipend.
      Apply for this job
    `,
    {
      url: "https://www.linkedin.com/jobs/view/4435602102",
      title: "Platform Engineer | Paperless Parts"
    },
    { skipNonJob: true }
  );

  assert.equal(result.status, "no");
  assert.equal(result.evidence[0].ruleId, "citizen_resident_only");
  assert.equal(result.evidence[0].category, "no");
  assert.match(
    result.evidence[0].matchedText,
    /require US Citizenship or Green Card Holder/i
  );
  assert.equal(
    result.evidence.some((item) => item.category === "yes"),
    false
  );
});
