#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  buildMythosPromptBank,
  runMythosPreviewSuite,
} = require("../backend/src/services/sira/mythos-preview-eval-suite");

async function main() {
  const args = new Set(process.argv.slice(2));
  const answersPath = readOption("--answers");
  const json = args.has("--json");
  const listBank = args.has("--list-bank");
  const answers = answersPath ? readAnswers(answersPath) : {};

  if (listBank) {
    printJson(buildMythosPromptBank({ includeReferences: false }));
    return;
  }

  const result = await runMythosPreviewSuite({ answers });
  if (json) {
    printJson(result);
  } else {
    printTable(result);
  }

  if (!result.release_gate_passed) process.exitCode = 1;
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a file path`);
  }
  return value;
}

function readAnswers(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
  if (Array.isArray(parsed)) {
    return Object.fromEntries(parsed.map((item) => [item.id, item.answer || item]));
  }
  return parsed;
}

function printTable(result) {
  console.log(`SiraGPT Mythos Preview release gate`);
  console.log(`cases=${result.cases_total} passed=${result.passed} failed=${result.failed} score=${pct(result.aggregate_score)} threshold=${pct(result.threshold)}`);
  console.log("");
  console.log("area                                      score   status");
  console.log("---------------------------------------- ------- ------");
  for (const item of result.cases) {
    const status = item.passed ? "PASS" : `FAIL:${item.blockers.join(",")}`;
    console.log(`${pad(item.id, 40)} ${pad(pct(item.score), 7)} ${status}`);
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text.slice(0, width) : `${text}${" ".repeat(width - text.length)}`;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
