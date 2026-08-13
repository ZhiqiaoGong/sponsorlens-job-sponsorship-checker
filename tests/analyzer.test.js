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

test("continuous work authorization without visa sponsorship is unavailable", () => {
  const result = analyzer.analyze(
    `
      2026 Early Career Embedded Software Engineer
      About the job
      What You'll Do
      Build and maintain high-quality embedded software.
      Qualifications
      Must have continuous work authorization in the US without the need for
      visa sponsorships.
    `,
    {
      url: "https://www.linkedin.com/jobs/view/4413763362",
      title: "2026 Early Career Embedded Software Engineer"
    },
    { skipNonJob: true }
  );

  assert.equal(result.status, "no");
  assert.equal(result.evidence[0].ruleId, "without_sponsorship_future");
  assert.equal(result.evidence[0].category, "no");
  assert.match(
    result.evidence[0].matchedText,
    /continuous work authorization[\s\S]+without[\s\S]+visa sponsorships/i
  );
});

test("work authorization inside EEO boilerplate does not determine sponsorship", () => {
  const result = analyzer.analyze(
    `
      Junior Software Engineer
      About the job
      Required Qualifications
      A Bachelor's degree in Computer Science or a related discipline.

      MetLife is an Equal Opportunity Employer. All employment decisions are
      made without regards to race, color, national origin, religion, creed,
      sex, disability, citizenship status (although applicants and employees
      must be legally authorized to work in the United States), veteran status,
      or any other characteristic protected by applicable law.
    `,
    {
      url: "https://www.linkedin.com/jobs/view/4449444067",
      title: "Junior Software Engineer | MetLife"
    },
    { skipNonJob: true }
  );

  assert.equal(result.status, "unknown");
  assert.equal(result.evidence.length, 0);
});

test("a standalone legal work authorization requirement still needs review", () => {
  const result = analyzer.analyze(
    `
      Junior Software Engineer
      About the job
      Required Qualifications
      Applicants must be legally authorized to work in the United States.

      We are an Equal Opportunity Employer. Employment decisions are made
      without regard to race, color, religion, or national origin.
    `,
    {
      url: "https://www.linkedin.com/jobs/view/5555555555",
      title: "Junior Software Engineer"
    },
    { skipNonJob: true }
  );

  assert.equal(result.status, "review");
  assert.equal(result.evidence[0].ruleId, "current_authorization");
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

test("CPT and OPT eligibility language is related but does not answer sponsorship", () => {
  const result = analyzer.analyze(
    `
      Software Engineer I - Early Career
      International Student Eligibility (U.S. based roles): F-1 visa students
      must have approved Curricular Practical Training (CPT) or Occupational
      Practical Training (OPT) before their assignment begins.
      CPT/OPT must relate to their degree and be authorized by their university.
    `,
    {
      url: "https://example.com/jobs/early-career-123",
      title: "Software Engineer I - Early Career"
    },
    { skipNonJob: true }
  );

  assert.equal(result.status, "review");
  assert.ok(result.evidence.some((item) => {
    return item.ruleId === "student_work_authorization" &&
      item.category === "review";
  }));
});

test("explicit sponsorship answers outrank CPT and OPT review language", () => {
  const meta = {
    url: "https://example.com/jobs/early-career-456",
    title: "Software Engineer I - Early Career"
  };
  const eligibility = "F-1 visa students must have approved CPT or OPT.";
  const unavailable = analyzer.analyze(
    `${eligibility} Visa sponsorship is not available for this role.`,
    meta,
    { skipNonJob: true }
  );
  const available = analyzer.analyze(
    `${eligibility} H-1B sponsorship is available for this role.`,
    meta,
    { skipNonJob: true }
  );

  assert.equal(unavailable.status, "no");
  assert.equal(available.status, "yes");
  assert.ok(unavailable.evidence.some((item) => {
    return item.ruleId === "student_work_authorization";
  }));
  assert.ok(available.evidence.some((item) => {
    return item.ruleId === "student_work_authorization";
  }));
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

test("an offer conditioned on export-control authorization needs review", () => {
  const result = analyzer.analyze(
    `
      December 2026 New Graduate Engineer, Software / GNC
      Disclosures
      This position may require access to information protected under U.S.
      export control laws and regulations, including the Export Administration
      Regulations (EAR) and the International Traffic in Arms Regulations
      (ITAR). Please note that any offer for employment may be conditioned on
      authorization to receive software or technology controlled under these
      U.S. export control laws and regulations without sponsorship for an
      export license. Mach participates in E-Verify to confirm that you are
      authorized to work in the U.S.
    `,
    {
      url: "https://jobs.ashbyhq.com/mach/43c8b037-c77d-4efb-9379-52a6c3718bdb",
      title: "December 2026 New Graduate Engineer, Software / GNC"
    },
    { skipNonJob: true }
  );

  assert.equal(result.status, "review");
  assert.equal(result.evidence[0].ruleId, "export_authorization_condition");
  assert.equal(result.evidence[0].category, "review");
  assert.match(
    result.evidence[0].matchedText,
    /offer for employment[\s\S]+conditioned on[\s\S]+export control/i
  );
  assert.equal(result.evidence.some((item) => item.category === "no"), false);
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
