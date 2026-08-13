"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const collector = require("../lib/collector.js");
const localModelPolicy = require("../lib/local-model-policy.js");

function loadContentScript(options = {}) {
  let source = fs.readFileSync(
    require.resolve("../content/content.js"),
    "utf8"
  );
  const startupMarker = "  getSettings().then(() => {";
  const markerIndex = source.lastIndexOf(startupMarker);
  assert.ok(markerIndex >= 0);
  source = `${source.slice(0, markerIndex)}
  globalThis.__testApi = { scanPage, state, submitCollectionFeedback };
})();
`;

  const published = [];
  let messageListener;
  let storageListener;
  const pageText = options.text || "Legend Does NOT offer sponsorship";
  const analyzer = {
    normalizeText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    },
    analyze(_text, meta, analyzeOptions) {
      if (typeof options.analyze === "function") {
        return options.analyze(_text, meta, analyzeOptions);
      }
      const pageWide = Boolean(analyzeOptions.pageWide);
      return {
        status: pageWide ? "no" : "unknown",
        label: pageWide ? "No sponsorship" : "Not mentioned",
        summary: "",
        color: pageWide ? "#dc2626" : "#64748b",
        evidence: pageWide
          ? [{ id: "test:0", matchedText: "Does NOT offer sponsorship" }]
          : [],
        isLikelyJobPage: false,
        scanMode: pageWide ? "page" : "skipped",
        page: meta
      };
    }
  };
  const context = {
    SponsorLensAnalyzer: analyzer,
    SponsorLensCollector: collector,
    SponsorLensLocalModelPolicy: localModelPolicy,
    location: {
      href: options.url || "https://github.com/SimplifyJobs/New-Grad-Positions"
    },
    sessionStorage: {
      getItem() {
        return null;
      },
      setItem() {}
    },
    document: {
      title: options.title || "GitHub - SimplifyJobs/New-Grad-Positions",
      body: {
        innerText: pageText
      },
      documentElement: { appendChild() {} },
      getElementById() {
        return null;
      },
      querySelector(selector) {
        return typeof options.querySelector === "function"
          ? options.querySelector(selector)
          : null;
      },
      querySelectorAll(selector) {
        if (typeof options.querySelectorAll === "function") {
          const result = options.querySelectorAll(selector);
          if (result !== undefined) return result;
        }
        return { length: /input|select|textarea/.test(selector)
          ? Number(options.formFieldCount || 0)
          : 0 };
      },
      addEventListener() {}
    },
    window: { addEventListener() {} },
    chrome: {
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "0.9.0-test" };
        },
        sendMessage(message, callback) {
          published.push(message);
          if (typeof options.onSendMessage === "function") {
            const handled = options.onSendMessage(message, callback);
            if (handled) return;
          }
          if (callback) callback({ ok: true });
        },
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          }
        }
      },
      storage: {
        sync: { get() {} },
        local: { get() {} },
        onChanged: {
          addListener(listener) {
            storageListener = listener;
          }
        }
      }
    },
    MutationObserver: class {
      disconnect() {}
      observe() {}
    },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    URL,
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  context.__testApi.state.collectionSettings.collectLocalTrainingSamples = Boolean(
    options.collectLocalTrainingSamples
  );
  if (options.disableIndicator) {
    context.__testApi.state.settings.pageIndicator = false;
  }
  return {
    api: context.__testApi,
    published,
    getMessageListener() {
      return messageListener;
    },
    getStorageListener() {
      return storageListener;
    }
  };
}

test("automatic non-job scans publish only a skipped result", () => {
  const { api, published } = loadContentScript({
    collectLocalTrainingSamples: true
  });
  const result = api.scanPage(true);

  assert.equal(result.scanMode, "skipped");
  assert.equal(result.status, "unknown");
  assert.equal(api.state.host, null);
  assert.equal(published.length, 1);
  assert.equal(published[0].result.scanMode, "skipped");
  assert.equal(
    published.some((message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"),
    false
  );
});

test("manual page-wide scans do not publish or render an indicator", () => {
  const { api, published } = loadContentScript({
    collectLocalTrainingSamples: true
  });
  api.scanPage(true);
  const result = api.scanPage(true, { pageWide: true });

  assert.equal(result.scanMode, "page");
  assert.equal(result.status, "no");
  assert.equal(api.state.host, null);
  assert.equal(published.length, 1);
  assert.equal(
    published.some((message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"),
    false
  );
});

test("the scan-anyway message returns a page-wide result", () => {
  const { getMessageListener, published } = loadContentScript();
  let response;
  getMessageListener()(
    { type: "SPONSORLENS_SCAN_ANYWAY" },
    {},
    (value) => {
      response = value;
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.result.scanMode, "page");
  assert.equal(response.result.status, "no");
  assert.equal(published.length, 0);
});

test("application URLs are skipped and never produce local training captures", () => {
  let analyzeCalls = 0;
  const { api, published } = loadContentScript({
    url: "https://jobs.ashbyhq.com/sentry/5c3196c7-f3d6-4dba-9c41-c886df4b2421/application?embed=true",
    title: "Apply for Software Engineer",
    text: [
      "Software Engineer",
      "Your application",
      "Contact information",
      "Will you require employer sponsorship to continue working in the future?"
    ].join("\n"),
    collectLocalTrainingSamples: true,
    analyze(_text, meta) {
      analyzeCalls += 1;
      return {
        version: "test",
        status: "conditional",
        label: "Conditional sponsorship",
        summary: "",
        color: "#d97706",
        counts: { conditional: 1 },
        evidence: [],
        isLikelyJobPage: true,
        scanMode: "job",
        page: meta
      };
    }
  });
  const result = api.scanPage(true);

  assert.equal(analyzeCalls, 0);
  assert.equal(result.scanMode, "skipped");
  assert.equal(result.skippedReason, "application-flow");
  assert.equal(result.status, "unknown");
  assert.equal(api.state.host, null);
  assert.equal(
    published.some((message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"),
    false
  );
  assert.equal(
    published.filter((message) => message.type === "SPONSORLENS_RESULT").length,
    1
  );
});

test("an application tab keeps the prior listing verdict without leaving its card open", () => {
  let analyzeCalls = 0;
  const { api, published } = loadContentScript({
    url: "https://jobs.ashbyhq.com/sentry/5c3196c7-f3d6-4dba-9c41-c886df4b2421/application?embed=true",
    title: "Apply for Software Engineer",
    text: [
      "Software Engineer",
      "Your application",
      "Contact information",
      "Will you require employer sponsorship to continue working in the future?"
    ].join("\n"),
    analyze() {
      analyzeCalls += 1;
      throw new Error("application questionnaire text must not be analyzed");
    }
  });
  const listingResult = {
    status: "no",
    label: "No sponsorship",
    isLikelyJobPage: true,
    scanMode: "job"
  };
  api.state.result = listingResult;
  api.state.currentJobKey = "url:https://jobs.ashbyhq.com/sentry/5c3196c7-f3d6-4dba-9c41-c886df4b2421";
  api.state.indicatorExpanded = true;
  api.state.expansionMode = "auto";

  const result = api.scanPage(true);

  assert.equal(analyzeCalls, 0);
  assert.equal(result, listingResult);
  assert.equal(api.state.result, listingResult);
  assert.equal(api.state.indicatorExpanded, false);
  assert.equal(api.state.expansionMode, "");
  assert.equal(api.state.host, null);
  assert.equal(
    published.some((message) => message.type === "SPONSORLENS_RESULT"),
    false
  );
});

test("application-form signals block capture even on a job URL", () => {
  const { api, published } = loadContentScript({
    url: "https://jobs.example.com/opening/123",
    text: [
      "Visa sponsorship may be available.",
      "Your application",
      "Review and submit",
      "Personal information"
    ].join("\n"),
    formFieldCount: 8,
    collectLocalTrainingSamples: true,
    disableIndicator: true,
    analyze(_text, meta) {
      return {
        version: "test",
        status: "review",
        label: "Needs review",
        summary: "",
        color: "#ca8a04",
        counts: { review: 1 },
        evidence: [],
        isLikelyJobPage: true,
        scanMode: "job",
        page: meta
      };
    }
  });
  api.scanPage(true);

  assert.equal(
    published.some((message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"),
    false
  );
});

test("inline resume forms and application query state block capture", () => {
  const cases = [
    {
      url: "https://jobs.example.com/opening/123",
      text: "Visa sponsorship may be available. Contact details. Upload your resume. Continue.",
      formFieldCount: 2
    },
    {
      url: "https://jobs.example.com/opening/123?application=start",
      text: "Visa sponsorship may be available.",
      formFieldCount: 0
    }
  ];

  cases.forEach((applicationCase) => {
    const { api, published } = loadContentScript({
      ...applicationCase,
      collectLocalTrainingSamples: true,
      disableIndicator: true,
      analyze(_text, meta) {
        return {
          version: "test",
          status: "review",
          label: "Needs review",
          summary: "",
          color: "#ca8a04",
          counts: { review: 1 },
          evidence: [],
          isLikelyJobPage: true,
          scanMode: "job",
          page: meta
        };
      }
    });
    api.scanPage(true);
    assert.equal(
      published.some((message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"),
      false
    );
  });
});

test("ordinary job copy mentioning resume submission is not treated as an application form", () => {
  const { api, published } = loadContentScript({
    url: "https://jobs.example.com/opening/normal-description",
    text: [
      "About this job",
      "Visa sponsorship may be available for qualified applicants.",
      "Upload your resume and submit your application through our careers site."
    ].join("\n"),
    formFieldCount: 0,
    collectLocalTrainingSamples: true,
    disableIndicator: true,
    analyze(_text, meta) {
      return {
        version: "test",
        status: "conditional",
        label: "Conditional sponsorship",
        summary: "",
        color: "#d97706",
        counts: { conditional: 1 },
        evidence: [],
        isLikelyJobPage: true,
        scanMode: "job",
        page: meta
      };
    }
  });
  api.scanPage(true);

  assert.equal(
    published.some((message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"),
    true
  );
});

test("an opted-in individual job can produce a short local capture", () => {
  const text = "About this job\nVisa sponsorship eligibility requires review.";
  const { api, published } = loadContentScript({
    url: "https://jobs.example.com/opening/123",
    title: "Software Engineer",
    text,
    collectLocalTrainingSamples: true,
    disableIndicator: true,
    analyze(_text, meta) {
      return {
        version: "test",
        status: "review",
        label: "Needs review",
        summary: "",
        color: "#ca8a04",
        counts: { review: 1 },
        evidence: [],
        isLikelyJobPage: true,
        scanMode: "job",
        page: meta
      };
    }
  });
  api.scanPage(true);

  const captures = published.filter(
    (message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"
  );
  assert.equal(captures.length, 1);
  assert.equal(captures[0].capture.candidates.length, 1);
  assert.equal(
    captures[0].capture.candidates[0].text,
    "Visa sponsorship eligibility requires review."
  );
  assert.ok(text.includes(captures[0].capture.candidates[0].text));
  assert.equal(Object.hasOwn(captures[0].capture.page, "url"), false);
  assert.equal(
    published.filter((message) => message.type === "SPONSORLENS_RESULT").length,
    1
  );
});

test("decisive job results with relevant passages are collected without sampling", () => {
  const text = "About this job\nEmployer will not sponsor applicants for employment visas.";
  const { api, published } = loadContentScript({
    url: "https://jobs.example.com/opening/decisive-no",
    title: "Software Engineer",
    text,
    collectLocalTrainingSamples: true,
    disableIndicator: true,
    analyze(_text, meta) {
      return {
        version: "test",
        status: "no",
        label: "No sponsorship",
        summary: "",
        color: "#dc2626",
        counts: { no: 1 },
        evidence: [],
        isLikelyJobPage: true,
        scanMode: "job",
        page: meta
      };
    }
  });
  api.scanPage(true);

  const captures = published.filter(
    (message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"
  );
  assert.equal(captures.length, 1);
  assert.equal(captures[0].capture.sampleReason, "automatic-observation");
  assert.equal(captures[0].capture.baseResult.status, "no");
  assert.ok(captures[0].capture.candidates.length > 0);
});

test("a successful automatic save records the page result as assumed correct", () => {
  const text = "About this job\nEmployer will not sponsor applicants for employment visas.";
  let outboundCapture;
  const { api } = loadContentScript({
    url: "https://jobs.example.com/opening/assumed-correct",
    title: "Software Engineer",
    text,
    collectLocalTrainingSamples: true,
    disableIndicator: true,
    onSendMessage(message, callback) {
      if (message.type !== "SPONSORLENS_CAPTURE_SAMPLES") return false;
      outboundCapture = message.capture;
      callback({
        ok: true,
        added: 1,
        updated: 0,
        captureId: message.capture.captureId,
        pageFeedback: {
          action: "confirmed",
          predictedStatus: "no",
          selectedStatus: "no",
          at: "2026-08-05T12:00:00.000Z",
          source: "automatic"
        }
      });
      return true;
    },
    analyze(_text, meta) {
      return {
        version: "test",
        status: "no",
        label: "No sponsorship",
        summary: "",
        color: "#dc2626",
        counts: { no: 1 },
        evidence: [],
        isLikelyJobPage: true,
        scanMode: "job",
        page: meta
      };
    }
  });
  api.scanPage(true);

  assert.ok(outboundCapture);
  assert.deepEqual(
    outboundCapture.pageFeedback,
    collector.defaultPageFeedback("no")
  );
  assert.equal(api.state.collectionContext.status, "saved");
  assert.deepEqual({ ...api.state.collectionContext.pageFeedback }, {
    action: "confirmed",
    predictedStatus: "no",
    selectedStatus: "no",
    at: "2026-08-05T12:00:00.000Z",
    source: "automatic"
  });
});

test("a failed automatic save does not assume that the page result was correct", () => {
  const text = "About this job\nEmployer will not sponsor applicants for employment visas.";
  const { api } = loadContentScript({
    url: "https://jobs.example.com/opening/failed-assumption",
    title: "Software Engineer",
    text,
    collectLocalTrainingSamples: true,
    disableIndicator: true,
    onSendMessage(message, callback) {
      if (message.type !== "SPONSORLENS_CAPTURE_SAMPLES") return false;
      callback({ ok: false, error: "storage failed" });
      return true;
    },
    analyze(_text, meta) {
      return {
        version: "test",
        status: "no",
        label: "No sponsorship",
        summary: "",
        color: "#dc2626",
        counts: { no: 1 },
        evidence: [],
        isLikelyJobPage: true,
        scanMode: "job",
        page: meta
      };
    }
  });
  api.scanPage(true);

  assert.equal(api.state.collectionContext.status, "error");
  assert.deepEqual(
    api.state.collectionContext.pageFeedback,
    collector.defaultPageFeedback("no")
  );
});

test("LinkedIn search pages use the active job link when currentJobId is absent", () => {
  function activeCapture(jobId, url) {
    const detailText = "About this job\nEmployer will not sponsor applicants for employment visas. Build reliable software systems.";
    const link = {
      getAttribute(name) {
        return name === "href"
          ? `/jobs/view/software-engineer-${jobId}/`
          : null;
      }
    };
    const detailRoot = {
      innerText: detailText,
      getAttribute() {
        return null;
      },
      getClientRects() {
        return [{}];
      },
      querySelector(selector) {
        return selector.includes('href*="/jobs/view/"') ? link : null;
      },
      querySelectorAll(selector) {
        return selector.includes('href*="/jobs/view/"') ? [link] : [];
      }
    };
    const { api, published } = loadContentScript({
      url: url || "https://www.linkedin.com/jobs/search-results/?keywords=software%20engineer",
      title: "Software Engineer | LinkedIn",
      text: `Other result offers visa sponsorship.\n${detailText}`,
      collectLocalTrainingSamples: true,
      disableIndicator: true,
      querySelector(selector) {
        return selector.includes('href*="/jobs/view/"') ? link : null;
      },
      querySelectorAll(selector) {
        return selector === ".jobs-search__job-details--container"
          ? [detailRoot]
          : [];
      },
      analyze(_text, meta) {
        return {
          version: "test",
          status: "no",
          label: "No sponsorship",
          summary: "",
          color: "#dc2626",
          counts: { no: 1 },
          evidence: [],
          isLikelyJobPage: true,
          scanMode: "job",
          page: meta
        };
      }
    });
    api.scanPage(true);
    return published.find(
      (message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"
    ).capture;
  }

  const first = activeCapture("4447241380");
  const second = activeCapture("4435602102");
  assert.notEqual(first.captureId, second.captureId);
  assert.notEqual(first.jobKeyHash, second.jobKeyHash);
  assert.equal(first.candidates[0].text.includes("will not sponsor"), true);
  assert.equal(first.candidates[0].text.includes("offers visa sponsorship"), false);

  const sameFromSearch = activeCapture(
    "4447241380",
    "https://www.linkedin.com/jobs/search-results/?currentJobId=4447241380"
  );
  const sameFromDirect = activeCapture(
    "4447241380",
    "https://www.linkedin.com/jobs/view/software-engineer-4447241380/"
  );
  assert.equal(sameFromSearch.captureId, sameFromDirect.captureId);
});

const LINKEDIN_DETAIL_TEXT = "About this job\nEmployer will not sponsor applicants for employment visas. Build reliable software systems.";

function linkedInJobLink(jobId) {
  return {
    getAttribute(name) {
      return name === "href" ? `/jobs/view/software-engineer-${jobId}/` : null;
    }
  };
}

function linkedInDetailPane(link) {
  return {
    innerText: LINKEDIN_DETAIL_TEXT,
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{}];
    },
    querySelector(selector) {
      return link && selector.includes('href*="/jobs/view/"') ? link : null;
    },
    querySelectorAll(selector) {
      return link && selector.includes('href*="/jobs/view/"') ? [link] : [];
    }
  };
}

function linkedInSduiSection(id, text, contains) {
  return {
    id,
    innerText: text,
    contains: contains || (() => false),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{}];
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

function loadLinkedInPage(options) {
  const detailRoot = options.detailPane || null;
  const sections = options.sections || [];
  const scannedTexts = [];
  const harness = loadContentScript({
    url: options.url,
    title: "Software Engineer | LinkedIn",
    text: options.bodyText || LINKEDIN_DETAIL_TEXT,
    collectLocalTrainingSamples: true,
    disableIndicator: true,
    querySelector(selector) {
      return options.documentLink && selector.includes('href*="/jobs/view/"')
        ? options.documentLink
        : null;
    },
    querySelectorAll(selector) {
      if (selector === '[id^="JobDetails_"]') return sections;
      return detailRoot && selector === ".jobs-search__job-details--container"
        ? [detailRoot]
        : [];
    },
    analyze(text, meta) {
      scannedTexts.push(text);
      return {
        version: "test",
        status: "no",
        label: "No sponsorship",
        summary: "",
        color: "#dc2626",
        counts: { no: 1 },
        evidence: [],
        isLikelyJobPage: true,
        scanMode: "job",
        page: meta
      };
    }
  });
  return { ...harness, scannedTexts };
}

function linkedInJobKeyHash(jobId) {
  return collector.hashToken(`id:https://www.linkedin.com:${jobId}`);
}

test("LinkedIn collection follows the detail pane when the URL job ID is stale", () => {
  const paneLink = linkedInJobLink("4435602102");
  const { api, published } = loadLinkedInPage({
    url: "https://www.linkedin.com/jobs/search-results/?currentJobId=4447241380",
    detailPane: linkedInDetailPane(paneLink),
    documentLink: paneLink
  });
  api.scanPage(true);

  const capture = published.find(
    (message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"
  );
  assert.ok(capture);
  assert.equal(capture.capture.jobKeyHash, linkedInJobKeyHash("4435602102"));
  assert.ok(api.state.collectionContext);
});

test("LinkedIn collection waits when job IDs outside the detail pane disagree", () => {
  const { api, published } = loadLinkedInPage({
    url: "https://www.linkedin.com/jobs/search-results/?currentJobId=4447241380",
    detailPane: linkedInDetailPane(null),
    documentLink: linkedInJobLink("4435602102")
  });
  api.scanPage(true);

  assert.equal(
    published.some((message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"),
    false
  );
  assert.equal(api.state.collectionContext, null);
});

test("LinkedIn job view pages still collect without a detail container", () => {
  const { api, published } = loadLinkedInPage({
    url: "https://www.linkedin.com/jobs/view/software-engineer-4447241380/?currentJobId=4435602102"
  });
  api.scanPage(true);

  const capture = published.find(
    (message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"
  );
  assert.ok(capture);
  assert.equal(capture.capture.jobKeyHash, linkedInJobKeyHash("4447241380"));
});

test("LinkedIn search pages without a detail container do not collect", () => {
  const { api, published } = loadLinkedInPage({
    url: "https://www.linkedin.com/jobs/search-results/?currentJobId=4447241380"
  });
  api.scanPage(true);

  assert.equal(
    published.some((message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"),
    false
  );
  assert.equal(api.state.collectionContext, null);
});

test("LinkedIn SDUI section IDs supply the scan text and the job identity", () => {
  const { api, published, scannedTexts } = loadLinkedInPage({
    url: "https://www.linkedin.com/jobs/search-results/?currentJobId=4435602102",
    bodyText: `Junior Developer. Another employer offers visa sponsorship.\n${LINKEDIN_DETAIL_TEXT}`,
    sections: [
      linkedInSduiSection(
        "JobDetails_Header_4449138344",
        "[2027] Software Engineer, Early Career"
      ),
      linkedInSduiSection("JobDetails_AboutTheJob_4449138344", LINKEDIN_DETAIL_TEXT)
    ]
  });
  api.scanPage(true);

  assert.equal(scannedTexts[0].includes("will not sponsor"), true);
  assert.equal(scannedTexts[0].includes("offers visa sponsorship"), false);
  const capture = published.find(
    (message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"
  );
  assert.ok(capture);
  assert.equal(capture.capture.jobKeyHash, linkedInJobKeyHash("4449138344"));
  assert.ok(api.state.collectionContext);
});

test("a LinkedIn pane left over from the previous listing does not relabel the current one", () => {
  const { published, scannedTexts, api } = loadLinkedInPage({
    url: "https://www.linkedin.com/jobs/search-results/?currentJobId=4449138344",
    sections: [
      linkedInSduiSection(
        "JobDetails_AboutTheJob_4435602102",
        "Stale pane. This employer offers visa sponsorship."
      ),
      linkedInSduiSection("JobDetails_AboutTheJob_4449138344", LINKEDIN_DETAIL_TEXT)
    ]
  });
  api.scanPage(true);

  assert.equal(scannedTexts[0].includes("Stale pane"), false);
  const capture = published.find(
    (message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"
  );
  assert.ok(capture);
  assert.equal(capture.capture.jobKeyHash, linkedInJobKeyHash("4449138344"));
});

test("nested LinkedIn SDUI sections are not scanned twice", () => {
  const about = linkedInSduiSection(
    "JobDetails_AboutTheJob_4449138344",
    LINKEDIN_DETAIL_TEXT
  );
  const root = linkedInSduiSection(
    "JobDetails_Root_4449138344",
    `Roblox\n${LINKEDIN_DETAIL_TEXT}`,
    (element) => element === about
  );
  const { api, scannedTexts } = loadLinkedInPage({
    url: "https://www.linkedin.com/jobs/view/software-engineer-4449138344/",
    sections: [root, about]
  });
  api.scanPage(true);

  assert.equal(scannedTexts[0].split("will not sponsor").length - 1, 1);
});

test("page-level corrections can be sent even when no candidate passage was found", () => {
  const { api, published } = loadContentScript({
    url: "https://jobs.example.com/opening/no-passage",
    title: "Software Engineer",
    text: "About this job\nBuild reliable distributed systems with the platform team.",
    collectLocalTrainingSamples: true,
    disableIndicator: true,
    analyze(_text, meta) {
      return {
        version: "test",
        status: "unknown",
        label: "Not mentioned",
        summary: "",
        color: "#64748b",
        counts: {},
        evidence: [],
        isLikelyJobPage: true,
        scanMode: "job",
        page: meta
      };
    }
  });
  api.scanPage(true);

  assert.equal(
    published.some((message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"),
    false
  );
  assert.ok(api.state.collectionContext);
  assert.equal(api.state.collectionContext.capture.candidates.length, 0);
  assert.equal(api.state.collectionContext.capture.sampleReason, "user-feedback");
  assert.deepEqual(
    api.state.collectionContext.pageFeedback,
    collector.defaultPageFeedback("unknown")
  );

  api.submitCollectionFeedback("corrected", "yes");
  const feedback = published.find(
    (message) => message.type === "SPONSORLENS_COLLECTION_FEEDBACK"
  );
  assert.ok(feedback);
  assert.equal(feedback.capture.candidates.length, 0);
  assert.equal(feedback.capture.sampleReason, "user-feedback");
  assert.deepEqual({ ...feedback.feedback }, {
    action: "corrected",
    selectedStatus: "yes"
  });
});

test("stored zero-passage feedback is restored without creating a new observation", () => {
  const { api, published } = loadContentScript({
    url: "https://jobs.example.com/opening/restored-feedback",
    title: "Software Engineer",
    text: "About this job\nBuild reliable distributed systems with the platform team.",
    collectLocalTrainingSamples: true,
    disableIndicator: true,
    onSendMessage(message, callback) {
      if (message.type !== "SPONSORLENS_COLLECTION_FEEDBACK_GET") return false;
      callback({
        ok: true,
        found: true,
        trainable: false,
        pageFeedback: {
          action: "corrected",
          predictedStatus: "unknown",
          selectedStatus: "yes",
          at: "2026-08-05T12:00:00.000Z",
          source: "indicator"
        }
      });
      return true;
    },
    analyze(_text, meta) {
      return {
        version: "test",
        status: "unknown",
        label: "Not mentioned",
        summary: "",
        color: "#64748b",
        counts: {},
        evidence: [],
        isLikelyJobPage: true,
        scanMode: "job",
        page: meta
      };
    }
  });
  api.scanPage(true);

  assert.equal(
    published.some((message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"),
    false
  );
  assert.equal(
    published.some((message) => message.type === "SPONSORLENS_COLLECTION_FEEDBACK_GET"),
    true
  );
  assert.equal(api.state.collectionContext.pageFeedback.action, "corrected");
  assert.equal(api.state.collectionContext.pageFeedback.selectedStatus, "yes");
  assert.equal(api.state.collectionContext.status, "feedback-only");
});

test("a deferred feedback response updates the replacement context after a rescan", () => {
  let feedbackCallback;
  const text = "About this job\nEmployer will not sponsor applicants for employment visas.";
  const { api } = loadContentScript({
    url: "https://jobs.example.com/opening/deferred-feedback",
    title: "Software Engineer",
    text,
    collectLocalTrainingSamples: true,
    disableIndicator: true,
    onSendMessage(message, callback) {
      if (message.type === "SPONSORLENS_COLLECTION_FEEDBACK") {
        feedbackCallback = callback;
        return true;
      }
      if (message.type === "SPONSORLENS_CAPTURE_SAMPLES") {
        callback({
          ok: true,
          pageFeedback: collector.defaultPageFeedback("no")
        });
        return true;
      }
      return false;
    },
    analyze(_text, meta) {
      return {
        version: "test",
        status: "no",
        label: "No sponsorship",
        summary: "",
        color: "#dc2626",
        counts: { no: 1 },
        evidence: [],
        isLikelyJobPage: true,
        scanMode: "job",
        page: meta
      };
    }
  });
  api.scanPage(true);
  const originalContext = api.state.collectionContext;
  api.submitCollectionFeedback("corrected", "yes");
  api.scanPage(true);
  assert.notEqual(api.state.collectionContext, originalContext);

  feedbackCallback({
    ok: true,
    trainable: true,
    pageFeedback: {
      action: "corrected",
      predictedStatus: "no",
      selectedStatus: "yes",
      at: "2026-08-05T12:10:00.000Z",
      source: "indicator"
    }
  });

  assert.equal(api.state.collectionContext.pageFeedback.action, "corrected");
  assert.equal(api.state.collectionContext.pageFeedback.selectedStatus, "yes");
  assert.equal(api.state.collectionContext.status, "saved");
});

test("storage changes synchronize page feedback and do not immediately refill deletions", () => {
  const text = "About this job\nEmployer will not sponsor applicants for employment visas.";
  const { api, published, getStorageListener } = loadContentScript({
    url: "https://jobs.example.com/opening/storage-sync",
    title: "Software Engineer",
    text,
    collectLocalTrainingSamples: true,
    disableIndicator: true,
    onSendMessage(message, callback) {
      if (message.type === "SPONSORLENS_CAPTURE_SAMPLES") {
        callback({ ok: false, full: true, error: "full" });
        return true;
      }
      return false;
    },
    analyze(_text, meta) {
      return {
        version: "test",
        status: "no",
        label: "No sponsorship",
        summary: "",
        color: "#dc2626",
        counts: { no: 1 },
        evidence: [],
        isLikelyJobPage: true,
        scanMode: "job",
        page: meta
      };
    }
  });
  api.scanPage(true);
  const capture = published.find(
    (message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"
  ).capture;
  const captureMessagesBefore = published.filter(
    (message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES"
  ).length;
  api.scanPage(true);
  assert.equal(
    published.filter((message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES").length,
    captureMessagesBefore
  );

  const corrected = collector.applyPageFeedback(
    capture,
    { action: "corrected", selectedStatus: "yes" },
    "2026-08-05T12:20:00.000Z"
  );
  getStorageListener()({
    [collector.storageKey(capture.captureId)]: {
      oldValue: capture,
      newValue: corrected
    }
  }, "local");
  assert.equal(api.state.collectionContext.pageFeedback.action, "corrected");

  getStorageListener()({
    [collector.storageKey(capture.captureId)]: {
      oldValue: corrected,
      newValue: undefined
    }
  }, "local");
  assert.equal(api.state.collectionContext.pageFeedback.action, "none");
  assert.equal(api.state.collectionContext.status, "removed");
  assert.equal(
    published.filter((message) => message.type === "SPONSORLENS_CAPTURE_SAMPLES").length,
    captureMessagesBefore
  );
});
