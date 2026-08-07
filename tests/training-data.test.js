"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const VALIDATOR = path.join(ROOT, "training", "validate_data.py");

function runValidator(dataPath) {
  return childProcess.spawnSync(
    "python3",
    [VALIDATOR, dataPath],
    { cwd: ROOT, encoding: "utf8" }
  );
}

test("the checked-in local-model dataset passes validation", () => {
  const result = runValidator(
    path.join(ROOT, "training", "data", "seed.jsonl")
  );

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.examples, 68);
  assert.equal(summary.verified, 68);
});

test("identical training text cannot have contradictory labels", () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "sponsorlens-training-")
  );
  const dataPath = path.join(temporaryDirectory, "conflict.jsonl");
  const text = "Visa sponsorship is available.";
  const common = {
    group_id: "same-template",
    text,
    evidence: { start: 0, end: text.length, text },
    source: "test",
    rule_id: null,
    verified: true,
    split: "train"
  };
  fs.writeFileSync(
    dataPath,
    [
      JSON.stringify({ id: "conflict-no", label: "no", ...common }),
      JSON.stringify({ id: "conflict-yes", label: "yes", ...common })
    ].join("\n") + "\n"
  );

  try {
    const result = runValidator(dataPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /identical text has conflicting labels/i);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
