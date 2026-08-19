"use strict";

// The validate_pptx/xlsx/pdf tools used to always return {stub:true}. They now
// run the real in-repo validator WHEN the caller supplies the artifact bytes,
// and fall back to the stub otherwise (purely additive).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createDefaultRegistry } = require("../src/services/sira/tool-registry");

const CASES = [
  { tool: "validate_pptx", okField: "ok" },
  { tool: "validate_xlsx", okField: "ok" },
  { tool: "validate_pdf", okField: "ok" },
];

test("validator tools keep the stub fallback when no bytes are supplied", async () => {
  const reg = createDefaultRegistry();
  for (const { tool } of CASES) {
    const res = await reg.get(tool).execute({ topic: "x" }, {});
    assert.equal(res.status, "success");
    assert.equal(res.output.stub, true, `${tool} should stub without bytes`);
    assert.equal(res.output.validated, undefined);
  }
});

test("validator tools run the real validator when bytes are supplied", async () => {
  const reg = createDefaultRegistry();
  for (const { tool, okField } of CASES) {
    // Bogus bytes — the validator should run and report invalid (not stub).
    const bytes = Buffer.from("definitely not a valid office/pdf file").toString("base64");
    const res = await reg.get(tool).execute({ buffer: bytes }, {});
    assert.equal(res.status, "success");
    assert.equal(res.output.stub, undefined, `${tool} must NOT stub when bytes are given`);
    assert.equal(res.output.validated, true);
    assert.ok(okField in res.output, `${tool} output should carry the validator verdict`);
    assert.equal(res.output.ok, false, `bogus bytes should fail validation`);
  }
});

test("validate_docx (no in-repo validator) still stubs even with bytes", async () => {
  const reg = createDefaultRegistry();
  const res = await reg.get("validate_docx").execute({ buffer: Buffer.from("x").toString("base64") }, {});
  assert.equal(res.output.stub, true);
});
