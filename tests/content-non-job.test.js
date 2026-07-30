"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadContentScript() {
  let source = fs.readFileSync(
    require.resolve("../content/content.js"),
    "utf8"
  );
  const startupMarker = "  getSettings().then(() => {";
  const markerIndex = source.lastIndexOf(startupMarker);
  assert.ok(markerIndex >= 0);
  source = `${source.slice(0, markerIndex)}
  globalThis.__testApi = { scanPage, state };
})();
`;

  const published = [];
  let messageListener;
  const analyzer = {
    normalizeText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    },
    analyze(_text, meta, options) {
      const pageWide = Boolean(options.pageWide);
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
    location: { href: "https://github.com/SimplifyJobs/New-Grad-Positions" },
    sessionStorage: {
      getItem() {
        return null;
      },
      setItem() {}
    },
    document: {
      title: "GitHub - SimplifyJobs/New-Grad-Positions",
      body: {
        innerText: "Legend Does NOT offer sponsorship"
      },
      documentElement: { appendChild() {} },
      getElementById() {
        return null;
      },
      querySelectorAll() {
        return { length: 0 };
      },
      addEventListener() {}
    },
    window: { addEventListener() {} },
    chrome: {
      runtime: {
        sendMessage(message) {
          published.push(message);
        },
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          }
        }
      },
      storage: {
        sync: { get() {} },
        onChanged: { addListener() {} }
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
  return {
    api: context.__testApi,
    published,
    getMessageListener() {
      return messageListener;
    }
  };
}

test("automatic non-job scans publish only a skipped result", () => {
  const { api, published } = loadContentScript();
  const result = api.scanPage(true);

  assert.equal(result.scanMode, "skipped");
  assert.equal(result.status, "unknown");
  assert.equal(api.state.host, null);
  assert.equal(published.length, 1);
  assert.equal(published[0].result.scanMode, "skipped");
});

test("manual page-wide scans do not publish or render an indicator", () => {
  const { api, published } = loadContentScript();
  api.scanPage(true);
  const result = api.scanPage(true, { pageWide: true });

  assert.equal(result.scanMode, "page");
  assert.equal(result.status, "no");
  assert.equal(api.state.host, null);
  assert.equal(published.length, 1);
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
