"use strict";

/**
 * 6==6 + matching hex/format must be SUCCESS even when verified was
 * already false before the gate / persistOutputs.
 */
const PizZip = require("pizzip");
const { applyAllOutputGates, honestGateFailureMessage, honestSuccessMessage, honestSlideShortfallMessage, slideCountSatisfied } = require("./verify");
const { persistOutputs } = require("./artifacts");
const { validatePptxPackage } = require("../agents/pptx-package-validator");

function fail(msg) {
  console.error("EQ6 FAIL:", msg);
  process.exit(1);
}

function slideXml(n, hex, title) {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title ${n}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` +
    `</p:spTree></p:cSld></p:sld>`
  );
}

function buildDeck(n, hex) {
  const zip = new PizZip();
  const overrides = [];
  const rels = [];
  const sldIds = [];
  for (let i = 1; i <= n; i += 1) {
    zip.file(`ppt/slides/slide${i}.xml`, slideXml(i, hex, `Tema ${i}`));
    overrides.push(`<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    rels.push(`<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>`);
    sldIds.push(`<p:sldId id="${255 + i}" r:id="rId${i}"/>`);
  }
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-officedocument.package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${overrides.join("")}</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${sldIds.join("")}</p:sldIdLst></p:presentation>`);
  return zip.generate({ type: "nodebuffer" });
}

(async () => {
  if (slideCountSatisfied(6, 6) !== true) fail("slideCountSatisfied(6,6) must be true");
  if (honestSlideShortfallMessage("6 diapositivas", 6, 6) !== "") {
    fail(`honestSlideShortfallMessage(6,6) must be empty, got ${JSON.stringify(honestSlideShortfallMessage("6 diapositivas", 6, 6))}`);
  }

  const buf = buildDeck(6, "22C55E");
  const instr = "crea 6 diapositivas en #22C55E";

  const preFailed = {
    name: "deck.pptx",
    buffer: buf,
    valid: true,
    verified: false,
    validationPassed: false,
    validationReason: "requested_slide_count_mismatch:6!=6",
    validation: {
      ok: false,
      passed: false,
      reason: "requested_slide_count_mismatch:6!=6",
      expectedSlides: 6,
      slideFiles: 6,
    },
  };

  const persistOnly = await persistOutputs({
    outputs: [Object.assign({}, preFailed, { buffer: buf })],
    saveArtifact: (args) => ({
      id: "eq6",
      filename: args.filename,
      mime: args.mime,
      format: "pptx",
      sizeBytes: buf.length,
      path: null,
      downloadUrl: "/eq6",
      validation: args.validation,
    }),
  });
  console.log("persist-only (pre-failed verified)", persistOnly[0] && persistOnly[0].validation, "verified", persistOnly[0] && persistOnly[0].verified);
  if (!persistOnly[0] || persistOnly[0].verified !== true) fail("persistOutputs must flip 6==6 pre-failed verified to true");
  if (!persistOnly[0].validation || persistOnly[0].validation.passed !== true) fail("persistOutputs validation.passed must be true for 6==6");

  const outputs = [Object.assign({}, preFailed, { buffer: buf })];
  const gate = applyAllOutputGates(outputs, instr, { currentCount: 0, color: "22C55E" });
  console.log("gate.ok", gate.ok, "verified", outputs[0].verified, "validation", outputs[0].validation);
  if (gate.ok !== true) fail("applyAllOutputGates 6==6 + hex must ok");
  if (outputs[0].verified !== true) fail("verified must be true after gate despite pre-fail");
  if (!outputs[0].validation || outputs[0].validation.passed !== true) fail("validation.passed must be true after gate");

  const honest = honestGateFailureMessage(outputs, instr, { color: "22C55E", currentCount: 0 });
  console.log("honestGate", JSON.stringify(honest));
  if (honest) fail(`honestGateFailureMessage must be empty on 6==6, got ${JSON.stringify(honest)}`);

  const success = honestSuccessMessage({ color: "22C55E", names: ["deck.pptx"] });
  console.log("success", success);
  if (!/^Listo\./.test(success) || /No pude|se pedían/.test(success)) fail(`Spanish success missing: ${success}`);

  const pkg = await validatePptxPackage({ buffer: buf, expectedSlides: 6, minSlides: 1 });
  console.log("package", pkg);
  if (pkg.ok !== true) fail(`package validator 6==6 must pass, got ${JSON.stringify(pkg)}`);

  const persistAfter = await persistOutputs({
    outputs,
    saveArtifact: (args) => ({
      id: "eq6b",
      filename: args.filename,
      mime: args.mime,
      format: "pptx",
      sizeBytes: buf.length,
      path: null,
      downloadUrl: "/eq6b",
      validation: args.validation,
    }),
  });
  if (persistAfter[0].verified !== true || persistAfter[0].validation.passed !== true) {
    fail(`persist after gate failed: ${JSON.stringify(persistAfter[0])}`);
  }

  console.log("EQ6 FIXTURE PASS");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
