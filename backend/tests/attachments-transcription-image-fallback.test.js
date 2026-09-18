"use strict";

/**
 * «Todos los servicios deben funcionar»: the fixes behind Luis's screenshots
 *  - an attached picture + a short question is answered by vision, never by
 *    the document runner nor replaced by the canned "no encontré texto"
 *  - transcription has an xAI rung so an invalid OpenAI key never yields
 *    "Transcripción no disponible" while Grok STT is configured
 *  - a picked image model whose provider rejects OUR key is rendered with
 *    another active model (operator failure, not a model choice)
 *  - OCR on a picture is time-boxed; the vision fallback memoises a 401
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const recovery = require("../src/services/chat-attachment-recovery");
const { shouldRunAgentRunner } = require("../src/services/agent-runner");
const transcriber = require("../src/services/audio-transcriber");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

test("attachment recovery: image-only turns keep the model answer unless the stream failed", () => {
  const img = [{ name: "images.png", mimeType: "image/png", extractedText: "1 + 1 = ? (ocr noise, 72 chars of nothing useful here ......)" }];
  assert.equal(recovery.shouldRecoverAttachmentResponse({ prompt: "cuanto es?", response: "2", processedFiles: img }), false, "a short correct answer is not weak for a picture");
  assert.equal(recovery.shouldRecoverAttachmentResponse({ prompt: "cuanto es?", response: "No puedo ver la imagen.", processedFiles: img }), false, "the model's own wording is kept; the document fallback would be wrong");
  assert.equal(recovery.shouldRecoverAttachmentResponse({ prompt: "cuanto es?", response: "", processedFiles: img }), true);
  assert.equal(recovery.shouldRecoverAttachmentResponse({ prompt: "cuanto es?", response: "Hubo un problema procesando tu solicitud", processedFiles: img }), true);
  const doc = [{ name: "tesis.pdf", mimeType: "application/pdf", extractedText: "x".repeat(200) }];
  assert.equal(recovery.shouldRecoverAttachmentResponse({ prompt: "resumen", response: "No pude leer el archivo", processedFiles: doc }), true, "documents keep the recovery path");
  assert.equal(recovery._internal.isImageAttachment({ name: "foto.JPG" }), true);
  assert.equal(recovery._internal.isImageAttachment({ mimeType: "application/pdf", name: "a.pdf" }), false);
});

test("agent runner: pictures never claim a document turn; «gracias» is not work", () => {
  assert.equal(shouldRunAgentRunner({ files: [{ name: "images.png", mimeType: "image/png" }], text: "cuanto es?" }), false);
  assert.equal(shouldRunAgentRunner({ files: [{ name: "images.png", mimeType: "image/png" }], text: "cambia el fondo" }), false, "image edits are the image lane's job");
  assert.equal(shouldRunAgentRunner({ hasPriorArtifacts: true, text: "gracias" }), false);
  assert.equal(shouldRunAgentRunner({ files: [{ name: "a.pptx" }], text: "ponlas blancas" }), true, "documents + a work verb still claim");
  assert.equal(shouldRunAgentRunner({ files: [{ name: "foto.png" }, { name: "a.docx" }], text: "agrega una tabla" }), true);
});

test("transcription ladder: openai → xai → meta → local; xai rung uses the multipart /stt helper", async () => {
  assert.deepEqual(transcriber.providerOrder({ env: {} }), ["openai", "xai", "meta", "local"]);
  const env = { XAI_API_KEY: "xai-test", TRANSCRIBE_PROVIDERS: "openai,xai,meta,local" };
  const names = transcriber.cloudProviders({ env }).map((p) => p.name);
  assert.deepEqual(names, ["xai"], "without OpenAI/Meta keys only the xAI rung is usable");
  assert.deepEqual(transcriber.cloudProviders({ env: { ...env, TRANSCRIBE_XAI_DISABLED: "1" } }).map((p) => p.name), []);
  const calls = [];
  const providers = transcriber.cloudProviders({ env, xaiTranscribe: async (filePath, mimeType, fileName, language) => { calls.push({ filePath, mimeType, fileName, language }); return { text: "hola mundo desde grok", model: "grok-stt" }; } });
  const tmp = path.join(require("node:os").tmpdir(), `tt-${Date.now()}.ogg`);
  fs.writeFileSync(tmp, Buffer.from("OggS"));
  try {
    const out = await transcriber.transcribeCloud(providers[0], tmp, "audio/ogg", "TT.ogg", 4, 25 * 1024 * 1024, { env }, "es", "");
    assert.equal(out.text, "hola mundo desde grok");
    assert.equal(out.model, "grok-stt");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fileName, "TT.ogg");
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("source pins: image auth fallback in the route, OCR budget, vision auth memo", () => {
  const ai = read("src/routes/ai.js");
  assert.match(ai, /function isImageAuthFailure\(result\)/);
  assert.match(ai, /async function pickImageAuthFallback\(/);
  assert.match(ai, /isImageAuthFailure\(result\) && imageAuthFallbackEnabled\(\)/);
  assert.match(ai, /substitutedFrom: imageResult\.substitutedFrom \|\| null/);
  const ocr = read("src/services/ocr-engine.js");
  assert.match(ocr, /SIRAGPT_OCR_IMAGE_BUDGET_MS/);
  assert.match(ocr, /if \(Date\.now\(\) - startedAt > budgetMs\) break;/);
  const fp = read("src/services/fileProcessor.js");
  assert.match(fp, /if \(visionAuthFailedUntil > Date\.now\(\)\) return false;/);
  assert.match(fp, /visionAuthFailedUntil = Date\.now\(\) \+ VISION_AUTH_MEMO_MS;/);
});
