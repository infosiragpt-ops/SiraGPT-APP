/**
 * describeUnextractedAttachment — pins the type-aware placeholder that
 * replaces the old dead-end "Binary file - content not available" string
 * injected into the chat prompt when an attachment yields no extractable
 * text (empty OCR on a photo, scanned/protected PDF, binary doc). The
 * message must tell the model what happened and what to relay to the user
 * so a free / non-vision model degrades gracefully instead of flatly
 * claiming it cannot analyze the file.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  describeUnextractedAttachment,
} = require("../src/services/message-attachments");

describe("describeUnextractedAttachment", () => {
  test("image → explains OCR found nothing + suggests describe / vision model", () => {
    const msg = describeUnextractedAttachment({ name: "foto.png", mimeType: "image/png" });
    assert.match(msg, /Imagen "foto\.png"/);
    assert.match(msg, /OCR/);
    assert.match(msg, /visi[oó]n/i);
  });

  test("image detected by extension when mime is missing", () => {
    const msg = describeUnextractedAttachment({ originalName: "diagrama.JPG" });
    assert.match(msg, /Imagen "diagrama\.JPG"/);
  });

  test("PDF → flags scanned/protected and asks for a selectable-text version", () => {
    const msg = describeUnextractedAttachment({ name: "informe.pdf", mimeType: "application/pdf" });
    assert.match(msg, /PDF "informe\.pdf"/);
    assert.match(msg, /escaneado|protegido/i);
  });

  test("PDF detected by extension when mime is generic", () => {
    const msg = describeUnextractedAttachment({ name: "x.pdf", mimeType: "application/octet-stream" });
    assert.match(msg, /PDF/);
  });

  test("audio/video → mentions transcription / multimedia", () => {
    const audio = describeUnextractedAttachment({ name: "nota.mp3", mimeType: "audio/mpeg" });
    assert.match(audio, /multimedia|transcripci[oó]n/i);
    const video = describeUnextractedAttachment({ name: "clip.mp4", mimeType: "video/mp4" });
    assert.match(video, /multimedia|transcripci[oó]n/i);
  });

  test("unknown/binary → generic could-not-extract guidance", () => {
    const msg = describeUnextractedAttachment({ name: "data.bin", mimeType: "application/octet-stream" });
    assert.match(msg, /Archivo "data\.bin"/);
    assert.match(msg, /no se pudo extraer/i);
  });

  test("falls back to a default name and never throws on empty/null input", () => {
    assert.doesNotThrow(() => describeUnextractedAttachment());
    assert.doesNotThrow(() => describeUnextractedAttachment(null));
    const msg = describeUnextractedAttachment({});
    assert.match(msg, /archivo/i);
  });

  test("prefers row.name, then originalName, then filename", () => {
    assert.match(describeUnextractedAttachment({ name: "a", originalName: "b", filename: "c" }), /"a"/);
    assert.match(describeUnextractedAttachment({ originalName: "b", filename: "c" }), /"b"/);
    assert.match(describeUnextractedAttachment({ filename: "c" }), /"c"/);
  });
});
