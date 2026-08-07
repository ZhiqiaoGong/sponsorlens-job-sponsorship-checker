#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const policy = require("../lib/local-model-policy.js");

const dataArgument = process.argv[2];
if (!dataArgument) {
  console.error("usage: node training/validate_runtime_gate.js DATA.jsonl");
  process.exit(2);
}

const dataPath = path.resolve(process.cwd(), dataArgument);
const lines = fs.readFileSync(dataPath, "utf8").split("\n");
const errors = [];

lines.forEach((rawLine, index) => {
  const line = rawLine.trim();
  if (!line) return;
  let example;
  try {
    example = JSON.parse(line);
  } catch (_error) {
    return;
  }
  const normalized = policy.normalizeText(example.text);
  const candidates = policy.extractCandidateWindows(example.text);
  if (!candidates.some((candidate) => candidate.text === normalized)) {
    errors.push(
      `line ${index + 1} (${example.id || "missing id"}): ` +
      "text is not an exact runtime candidate window"
    );
  }
});

if (errors.length) {
  errors.forEach((error) => console.error(`error: ${error}`));
  process.exit(1);
}

console.log(`runtime gate: ${dataPath} is aligned`);

