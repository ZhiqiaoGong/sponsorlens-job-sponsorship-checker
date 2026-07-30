"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadBackground() {
  const calls = [];
  let messageListener;
  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    },
    storage: {
      sync: {
        get(_defaults, callback) {
          callback({ enableBadge: true });
        },
        set() {}
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
    { chrome }
  );

  return { calls, messageListener };
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
