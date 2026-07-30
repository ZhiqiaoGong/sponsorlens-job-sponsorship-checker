"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const analyzer = require("../lib/analyzer.js");

class FakeStyle {
  constructor() {
    this.properties = new Map();
  }

  getPropertyValue(property) {
    const item = this.properties.get(property);
    return item ? item.value : "";
  }

  getPropertyPriority(property) {
    const item = this.properties.get(property);
    return item ? item.priority : "";
  }

  setProperty(property, value, priority) {
    this.properties.set(property, {
      value: String(value || ""),
      priority: String(priority || "")
    });
  }

  removeProperty(property) {
    const previous = this.getPropertyValue(property);
    this.properties.delete(property);
    return previous;
  }
}

class FakeElement {
  constructor(tagName, text, options) {
    const settings = options || {};
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.innerText = text || "";
    this.textContent = text || "";
    this.id = settings.id || "";
    this.hidden = Boolean(settings.hidden);
    this.display = settings.display || "block";
    this.visibility = settings.visibility || "visible";
    this.opacity = settings.opacity === undefined ? "1" : String(settings.opacity);
    this.overflow = settings.overflow || "visible";
    this.overflowX = settings.overflowX || this.overflow;
    this.overflowY = settings.overflowY || this.overflow;
    this.connected = settings.connected !== false;
    this.parentElement = null;
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.scrolled = false;
    this.scrollTop = settings.scrollTop || 0;
    this.scrollLeft = settings.scrollLeft || 0;
    this.clientHeight = settings.clientHeight || 24;
    this.clientWidth = settings.clientWidth || 160;
    this.scrollHeight = settings.scrollHeight || this.clientHeight;
    this.scrollWidth = settings.scrollWidth || this.clientWidth;
    this.rect = settings.rect || {
      top: 0,
      bottom: this.clientHeight,
      left: 0,
      right: this.clientWidth,
      width: this.clientWidth,
      height: this.clientHeight
    };
    this.controls = settings.controls || [];
    this.children = [];
    this.listeners = new Map();
    this.clicked = false;
    this.removed = false;
  }

  get isConnected() {
    return this.connected;
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (selector.startsWith("#") && current.id === selector.slice(1)) {
        return current;
      }
      if (
        selector === "[id^='JobDetails_AboutTheJob_']" &&
        current.id.startsWith("JobDetails_AboutTheJob_")
      ) {
        return current;
      }
      if (
        selector === "section, article" &&
        /^(SECTION|ARTICLE)$/.test(current.tagName)
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  contains(element) {
    let current = element;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  querySelectorAll() {
    return this.controls;
  }

  appendChild(element) {
    element.parentElement = this;
    this.children.push(element);
    return element;
  }

  replaceChildren(...elements) {
    this.children.forEach((element) => {
      element.parentElement = null;
    });
    this.children = [];
    elements.forEach((element) => this.appendChild(element));
  }

  remove() {
    if (this.parentElement && Array.isArray(this.parentElement.children)) {
      this.parentElement.children = this.parentElement.children.filter((child) => {
        return child !== this;
      });
    }
    this.parentElement = null;
    this.removed = true;
  }

  addEventListener(type, listener, options) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({
      listener,
      once: Boolean(options && options.once)
    });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter((entry) => {
      return entry.listener !== listener;
    }));
  }

  getBoundingClientRect() {
    return this.rect;
  }

  getClientRects() {
    if (
      !this.connected ||
      this.hidden ||
      this.display === "none" ||
      this.visibility === "hidden" ||
      this.opacity === "0"
    ) {
      return [];
    }
    return [this.rect];
  }

  scrollTo(options) {
    if (Number.isFinite(options && options.top)) this.scrollTop = options.top;
    if (Number.isFinite(options && options.left)) this.scrollLeft = options.left;
  }

  scrollIntoView() {
    this.scrolled = true;
  }

  click() {
    this.clicked = true;
    const listeners = (this.listeners.get("click") || []).slice();
    listeners.forEach((entry) => {
      entry.listener({ currentTarget: this, target: this });
      if (entry.once) this.removeEventListener("click", entry.listener);
    });
  }
}

class FakeTextNode {
  constructor(value, parentElement) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentElement = parentElement;
  }
}

function createDocument(blocks) {
  const html = new FakeElement("html", "");
  const visibleText = blocks
    .filter((block) => block.display !== "none" && !block.hidden)
    .map((block) => block.text)
    .join("\n");
  const allText = blocks.map((block) => block.text).join("\n");
  const body = new FakeElement("body", visibleText);
  html.innerText = visibleText;
  html.textContent = allText;
  body.textContent = allText;
  body.parentElement = html;

  const elements = [];
  const textNodes = blocks.map((block) => {
    const element = new FakeElement(block.tag || "p", block.text, block);
    element.parentElement = body;
    elements.push(element);
    return new FakeTextNode(block.text, element);
  });

  return {
    title: "Locator fixture",
    body,
    documentElement: html,
    elements,
    createTreeWalker() {
      let index = 0;
      return {
        nextNode() {
          if (index >= textNodes.length) return null;
          const node = textNodes[index];
          index += 1;
          return node;
        }
      };
    },
    querySelectorAll() {
      return [];
    },
    createElement(tagName) {
      return new FakeElement(tagName, "");
    },
    getElementById() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {}
  };
}

function loadLocator(blocks) {
  let source = fs.readFileSync(
    require.resolve("../content/content.js"),
    "utf8"
  );
  const startupMarker = "  getSettings().then(() => {";
  const markerIndex = source.lastIndexOf(startupMarker);
  assert.ok(markerIndex >= 0);
  source = `${source.slice(0, markerIndex)}
  globalThis.__testApi = {
    findBestElement,
    findLocatorDisclosure,
    getVisibleLocatorRangeRects,
    getLocatorScrollContainers,
    guideToLocatorDisclosure,
    isLocatorRangeRevealed,
    locateEvidence,
    revealLocatorMatch,
    renderRangeHighlight,
    restoreHighlight,
    scrollLocatorMatchIntoView,
    updateRangeHighlight,
    state
  };
})();
`;

  let messageListener;
  const document = createDocument(blocks);
  const context = {
    SponsorLensAnalyzer: analyzer,
    location: { href: "https://example.com/jobs/12345" },
    sessionStorage: {
      getItem() {
        return null;
      },
      setItem() {}
    },
    document,
    window: {
      addEventListener() {},
      removeEventListener() {},
      innerHeight: 720,
      innerWidth: 1280,
      scrollX: 0,
      scrollY: 0,
      scrollTo() {}
    },
    chrome: {
      runtime: {
        sendMessage() {},
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
    NodeFilter: { SHOW_TEXT: 4 },
    URL,
    getComputedStyle(element) {
      return {
        display: element.display,
        visibility: element.visibility,
        opacity: element.opacity,
        overflow: element.overflow,
        overflowX: element.overflowX,
        overflowY: element.overflowY
      };
    },
    setTimeout() {
      return 1;
    },
    clearTimeout() {}
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return {
    api: context.__testApi,
    context,
    document,
    getMessageListener() {
      return messageListener;
    }
  };
}

function scanContextFor(blocks, detectedAt) {
  const text = analyzer.normalizeText(
    blocks
      .filter((block) => block.display !== "none" && !block.hidden)
      .map((block) => block.text)
      .join("\n")
  );
  return {
    text,
    context: {
      textLength: text.length,
      detectedAt: detectedAt || 1,
      url: "https://example.com/jobs/12345"
    }
  };
}

test("duplicate wording resolves to the occurrence that produced the evidence", () => {
  const blocks = [
    {
      id: "original",
      text: "Red No sponsorship: The listing explicitly says sponsorship is unavailable."
    },
    { text: "x".repeat(220) },
    {
      id: "shorter-copy",
      tag: "li",
      text: "Needs review, not No sponsorship."
    }
  ];
  const { api, document } = loadLocator(blocks);
  const scan = scanContextFor(blocks);
  const evidence = {
    matchedText: "No sponsorship",
    snippet: blocks[0].text,
    index: scan.text.indexOf("No sponsorship")
  };

  const match = api.findBestElement(evidence, scan.context);

  assert.equal(match.element, document.elements[0]);
  assert.equal(match.matchMode, "exact");
});

test("position and context can select a later duplicate when it is the evidence source", () => {
  const blocks = [
    {
      id: "first",
      text: "No sponsorship is one possible result shown in this documentation."
    },
    { text: "x".repeat(240) },
    {
      id: "original",
      tag: "li",
      text: "For this role, No sponsorship is available."
    }
  ];
  const { api, document } = loadLocator(blocks);
  const scan = scanContextFor(blocks);
  const secondIndex = scan.text.lastIndexOf("No sponsorship");
  const evidence = {
    matchedText: "No sponsorship",
    snippet: blocks[2].text,
    index: secondIndex
  };

  const match = api.findBestElement(evidence, scan.context);

  assert.equal(match.element, document.elements[2]);
});

test("hidden duplicates are excluded from locator candidates", () => {
  const blocks = [
    {
      id: "hidden",
      tag: "span",
      text: "No sponsorship",
      display: "none"
    },
    {
      id: "visible",
      text: "No sponsorship is available for this role."
    }
  ];
  const { api, document } = loadLocator(blocks);
  const scan = scanContextFor(blocks);
  const evidence = {
    matchedText: "No sponsorship",
    snippet: blocks[1].text,
    index: 0
  };

  const match = api.findBestElement(evidence, scan.context);

  assert.equal(match.element, document.elements[1]);
});

test("headings and other previously omitted element types can be located", () => {
  const blocks = [
    {
      id: "heading",
      tag: "h2",
      text: "U.S. citizenship is required"
    }
  ];
  const { api, document } = loadLocator(blocks);
  const scan = scanContextFor(blocks);

  const match = api.findBestElement({
    matchedText: blocks[0].text,
    snippet: blocks[0].text,
    index: 0
  }, scan.context);

  assert.equal(match.element, document.elements[0]);
});

test("small dynamic wording changes use the closest contextual match", () => {
  const blocks = [
    {
      id: "original",
      text: "The ability to obtain and maintain a U.S. government issued TS/SCI security clearance is required."
    },
    {
      id: "unrelated",
      text: "Government security clearance documentation is available online."
    }
  ];
  const { api, document } = loadLocator(blocks);
  const scan = scanContextFor(blocks);

  const match = api.findBestElement({
    matchedText: "ability to obtain and maintain a U.S. government issued security clearance",
    snippet: "The ability to obtain and maintain a U.S. government issued security clearance is required.",
    index: 0
  }, scan.context);

  assert.equal(match.element, document.elements[0]);
  assert.equal(match.matchMode, "context");
});

test("the popup evidence snapshot wins over a reused evidence id after rescan", () => {
  const blocks = [
    {
      id: "old-evidence",
      text: "No sponsorship is available in the original policy."
    },
    { text: "x".repeat(220) },
    {
      id: "new-evidence",
      text: "This later section also says No sponsorship."
    }
  ];
  const { api, document, getMessageListener } = loadLocator(blocks);
  const scan = scanContextFor(blocks, 1);
  api.state.result = {
    detectedAt: 2,
    textLength: scan.text.length,
    page: { url: scan.context.url },
    evidence: [{
      id: "no_sponsorship_phrase:0",
      matchedText: "No sponsorship",
      snippet: blocks[2].text,
      index: scan.text.lastIndexOf("No sponsorship")
    }]
  };
  let response;

  getMessageListener()({
    type: "SPONSORLENS_LOCATE",
    evidenceId: "no_sponsorship_phrase:0",
    evidence: {
      id: "no_sponsorship_phrase:0",
      matchedText: "No sponsorship",
      snippet: blocks[0].text,
      index: scan.text.indexOf("No sponsorship")
    },
    scanContext: scan.context
  }, {}, (value) => {
    response = value;
  });

  assert.equal(response.ok, true);
  assert.equal(response.stale, true);
  assert.equal(api.state.highlightedElement, document.elements[0]);
  assert.equal(
    document.elements[0].style.getPropertyValue("outline"),
    "3px solid #f59e0b"
  );
  assert.equal(
    document.elements[2].style.getPropertyValue("outline"),
    ""
  );
});

test("highlight restoration preserves original inline priorities", () => {
  const blocks = [{
    id: "target",
    text: "No sponsorship is available."
  }];
  const { api, document } = loadLocator(blocks);
  const target = document.elements[0];
  target.style.setProperty("outline", "1px solid blue", "important");
  const scan = scanContextFor(blocks);

  const response = api.locateEvidence({
    matchedText: "No sponsorship",
    snippet: blocks[0].text,
    index: 0
  }, scan.context);
  api.restoreHighlight();

  assert.equal(response.ok, true);
  assert.equal(target.style.getPropertyValue("outline"), "1px solid blue");
  assert.equal(target.style.getPropertyPriority("outline"), "important");
});

test("LinkedIn-style collapsed descriptions use the local more control", () => {
  const { api, document } = loadLocator([]);
  const outer = new FakeElement("div", "", {
    overflowY: "auto",
    clientHeight: 520,
    scrollHeight: 1846,
    rect: {
      top: 199,
      bottom: 719,
      left: 420,
      right: 1100,
      width: 680,
      height: 520
    }
  });
  const section = new FakeElement("section", "", {
    id: "JobDetails_AboutTheJob_4444131861"
  });
  const clipped = new FakeElement("span", "", {
    overflowY: "hidden",
    clientHeight: 126,
    scrollHeight: 1176,
    rect: {
      top: 891,
      bottom: 1017,
      left: 440,
      right: 1080,
      width: 640,
      height: 126
    }
  });
  const target = new FakeElement(
    "span",
    "Employer will not sponsor applicants for employment visa status.",
    {
      rect: {
        top: 1586,
        bottom: 1603,
        left: 460,
        right: 870,
        width: 410,
        height: 17
      }
    }
  );
  const more = new FakeElement("button", "… more", {
    rect: {
      top: 985,
      bottom: 1011,
      left: 990,
      right: 1065,
      width: 75,
      height: 26
    }
  });
  outer.parentElement = document.body;
  section.parentElement = outer;
  clipped.parentElement = section;
  target.parentElement = clipped;
  more.parentElement = clipped;
  section.controls = [more];
  const range = {
    startContainer: new FakeTextNode(target.innerText, target),
    getClientRects() {
      return [{
        top: 1586 - clipped.scrollTop - outer.scrollTop,
        bottom: 1603 - clipped.scrollTop - outer.scrollTop,
        left: 460,
        right: 870,
        width: 410,
        height: 17
      }];
    }
  };

  const disclosure = api.findLocatorDisclosure(range, target);

  assert.equal(disclosure, more);
  assert.equal(api.findLocatorDisclosure(null, target), more);
  assert.equal(api.findLocatorDisclosure(null, clipped), more);
  const partiallyClippedRange = {
    startContainer: range.startContainer,
    getClientRects() {
      return [
        {
          top: 980,
          bottom: 998,
          left: 460,
          right: 870,
          width: 410,
          height: 18
        },
        {
          top: 1006,
          bottom: 1024,
          left: 460,
          right: 760,
          width: 300,
          height: 18
        }
      ];
    }
  };
  assert.equal(
    api.findLocatorDisclosure(partiallyClippedRange, target),
    more
  );
});

test("nested job panels scroll to clipped evidence without scrolling the page", () => {
  const { api, context, document } = loadLocator([]);
  let pageScrolls = 0;
  context.window.scrollTo = () => {
    pageScrolls += 1;
  };
  const outer = new FakeElement("div", "", {
    overflowY: "auto",
    clientHeight: 520,
    scrollHeight: 1846,
    rect: {
      top: 199,
      bottom: 719,
      left: 420,
      right: 1100,
      width: 680,
      height: 520
    }
  });
  const clipped = new FakeElement("span", "", {
    overflowY: "hidden",
    clientHeight: 126,
    scrollHeight: 1176,
    rect: {
      top: 891,
      bottom: 1017,
      left: 440,
      right: 1080,
      width: 640,
      height: 126
    }
  });
  const target = new FakeElement(
    "span",
    "Employer will not sponsor applicants for employment visa status."
  );
  outer.parentElement = document.body;
  clipped.parentElement = outer;
  target.parentElement = clipped;
  clipped.getBoundingClientRect = () => ({
    top: 891 - outer.scrollTop,
    bottom: 1017 - outer.scrollTop,
    left: 440,
    right: 1080,
    width: 640,
    height: 126
  });
  const range = {
    startContainer: new FakeTextNode(target.innerText, target),
    getClientRects() {
      return [{
        top: 1586 - clipped.scrollTop - outer.scrollTop,
        bottom: 1603 - clipped.scrollTop - outer.scrollTop,
        left: 460,
        right: 870,
        width: 410,
        height: 17
      }];
    }
  };
  const containers = api.getLocatorScrollContainers(range, target);

  assert.deepEqual(Array.from(containers), [outer]);
  assert.equal(api.getVisibleLocatorRangeRects(range).length, 0);
  clipped.scrollTop = 642;
  api.scrollLocatorMatchIntoView(range, target);

  assert.equal(clipped.scrollTop, 642);
  assert.ok(outer.scrollTop > 400);
  assert.equal(pageScrolls, 0);
  const finalRect = range.getClientRects()[0];
  assert.ok(finalRect.top > 250 && finalRect.bottom < 720);
  assert.equal(api.getVisibleLocatorRangeRects(range).length, 1);
});

test("collapsed evidence guides the user to More without auto-clicking it", () => {
  const { api, context, document } = loadLocator([]);
  const scheduled = [];
  context.setTimeout = (callback) => {
    scheduled.push(callback);
    return scheduled.length;
  };
  const more = new FakeElement("button", "… more", {
    rect: {
      top: 640,
      bottom: 668,
      left: 980,
      right: 1060,
      width: 80,
      height: 28
    }
  });
  const panel = new FakeElement("div", "", {
    overflowY: "auto",
    clientHeight: 420,
    scrollHeight: 900,
    rect: {
      top: 200,
      bottom: 620,
      left: 420,
      right: 1100,
      width: 680,
      height: 420
    }
  });
  panel.parentElement = document.body;
  more.parentElement = panel;

  const response = api.guideToLocatorDisclosure(
    more,
    {
      matchedText: "will not sponsor applicants",
      snippet: "Employer will not sponsor applicants.",
      index: 100
    },
    {
      textLength: 1000,
      detectedAt: 1,
      url: "https://example.com/jobs/12345"
    },
    "exact"
  );

  assert.equal(response.ok, true);
  assert.equal(response.action, "expand");
  assert.equal(more.clicked, false);
  assert.ok(panel.scrollTop > 0);
  assert.equal(more.scrolled, false);
  assert.equal(api.state.highlightedElement, more);
  assert.equal(more.style.getPropertyValue("outline"), "3px solid #f59e0b");
  more.click();
  assert.equal(api.state.pendingDisclosure, null);
  assert.equal(api.state.highlightedElement, null);
  assert.equal(scheduled.length, 2);
  api.restoreHighlight();
  scheduled[1]();
  assert.equal(scheduled.length, 2);
});

test("range highlight recalculates its position when a job panel scrolls", () => {
  const { api, context, document } = loadLocator([]);
  let queuedFrame = null;
  context.window.requestAnimationFrame = (callback) => {
    queuedFrame = callback;
    return 1;
  };
  context.window.cancelAnimationFrame = () => {
    queuedFrame = null;
  };
  const target = new FakeElement("span", "will not sponsor applicants");
  target.parentElement = document.body;
  let top = 120;
  const range = {
    startContainer: new FakeTextNode(target.innerText, target),
    getClientRects() {
      return [{
        top,
        bottom: top + 18,
        left: 460,
        right: 700,
        width: 240,
        height: 18
      }];
    }
  };

  const overlay = api.renderRangeHighlight(range);

  assert.equal(overlay.children.length, 1);
  assert.equal(overlay.children[0].style.getPropertyValue("top"), "120px");
  top = 360;
  api.state.highlightScrollHandler();
  assert.equal(typeof queuedFrame, "function");
  queuedFrame();
  assert.equal(overlay.children.length, 1);
  assert.equal(overlay.children[0].style.getPropertyValue("top"), "360px");
  api.restoreHighlight();
  assert.equal(overlay.removed, true);
});

test("a stale text range removes its highlight instead of moving to new words", () => {
  const { api, document } = loadLocator([]);
  const target = new FakeElement("span", "will not sponsor applicants");
  target.parentElement = document.body;
  let rangeText = "will not sponsor applicants";
  const range = {
    startContainer: new FakeTextNode(target.innerText, target),
    toString() {
      return rangeText;
    },
    getClientRects() {
      return [{
        top: 120,
        bottom: 138,
        left: 460,
        right: 700,
        width: 240,
        height: 18
      }];
    }
  };

  const overlay = api.renderRangeHighlight(
    range,
    "will not sponsor applicants"
  );
  assert.equal(overlay.removed, false);
  target.visibility = "hidden";
  api.updateRangeHighlight();
  assert.equal(overlay.children.length, 0);
  target.visibility = "visible";
  api.updateRangeHighlight();
  assert.equal(overlay.children.length, 1);

  rangeText = "unrelated replacement words";
  api.updateRangeHighlight();

  assert.equal(overlay.removed, true);
  assert.equal(api.state.highlightOverlay, null);
});

test("an exact but still clipped range never falls back to a broad element", () => {
  const { api, document } = loadLocator([]);
  const clipped = new FakeElement("span", "", {
    overflowY: "hidden",
    clientHeight: 120,
    scrollHeight: 900,
    rect: {
      top: 300,
      bottom: 420,
      left: 440,
      right: 1080,
      width: 640,
      height: 120
    }
  });
  const target = new FakeElement(
    "span",
    "Employer will not sponsor applicants for employment visa status."
  );
  clipped.parentElement = document.body;
  target.parentElement = clipped;
  const range = {
    startContainer: new FakeTextNode(target.innerText, target),
    getClientRects() {
      return [{
        top: 700,
        bottom: 718,
        left: 460,
        right: 870,
        width: 410,
        height: 18
      }];
    }
  };

  const response = api.revealLocatorMatch({
    element: target,
    range,
    matchMode: "exact"
  }, {
    matchedText: "will not sponsor applicants"
  }, {});

  assert.equal(response.ok, false);
  assert.equal(response.reason, "not-visible");
  assert.equal(api.state.highlightedElement, null);
  assert.equal(target.scrolled, false);
});

test("a pending post-expansion locate is abandoned after navigation", () => {
  const { api, context, document } = loadLocator([]);
  const scheduled = [];
  context.setTimeout = (callback) => {
    scheduled.push(callback);
    return scheduled.length;
  };
  const more = new FakeElement("button", "… more");
  more.parentElement = document.body;
  api.guideToLocatorDisclosure(
    more,
    {
      matchedText: "will not sponsor applicants",
      snippet: "Employer will not sponsor applicants.",
      index: 100
    },
    {
      textLength: 1000,
      detectedAt: 1,
      url: "https://example.com/jobs/12345"
    },
    "exact"
  );

  more.click();
  assert.equal(scheduled.length, 2);
  context.location.href = "https://example.com/jobs/67890";
  scheduled[1]();

  assert.equal(scheduled.length, 2);
  assert.equal(api.state.highlightOverlay, null);
  assert.equal(api.state.highlightedElement, null);
});
