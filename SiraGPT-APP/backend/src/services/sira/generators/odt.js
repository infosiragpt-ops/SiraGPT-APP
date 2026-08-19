"use strict";

/**
 * Minimal ODT (OpenDocument Text) generator. Builds a zip with the
 * three structural members required by the OpenDocument spec:
 *   - mimetype                (stored uncompressed, first entry)
 *   - META-INF/manifest.xml
 *   - content.xml
 *
 * LibreOffice and pandoc both accept this minimum.
 *
 * Plan shape (all optional):
 *   { title, sections: [{ heading, body }], body }
 */

const { zipBuild, xmlEscape } = require("./zip-utils");

const MIME = "application/vnd.oasis.opendocument.text";

function paragraphsOf(text) {
  return String(text || "")
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function buildContentXml(plan) {
  const xs = (s) => xmlEscape(s);
  const out = [];

  if (plan.title) {
    out.push(
      `<text:h text:style-name="Heading_20_1" text:outline-level="1">${xs(plan.title)}</text:h>`,
    );
  }

  const sections = Array.isArray(plan.sections) ? plan.sections : null;
  if (sections && sections.length) {
    for (const s of sections) {
      if (!s || typeof s !== "object") continue;
      if (s.heading) {
        out.push(
          `<text:h text:style-name="Heading_20_2" text:outline-level="2">${xs(s.heading)}</text:h>`,
        );
      }
      for (const p of paragraphsOf(s.body)) {
        out.push(`<text:p text:style-name="Standard">${xs(p)}</text:p>`);
      }
    }
  } else {
    const body = typeof plan === "string" ? plan : plan.body || plan.markdown || plan.text || "";
    for (const p of paragraphsOf(body)) {
      out.push(`<text:p text:style-name="Standard">${xs(p)}</text:p>`);
    }
  }

  if (out.length === 0) {
    out.push(`<text:p text:style-name="Standard"/>`);
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<office:document-content ` +
    `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ` +
    `xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ` +
    `xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ` +
    `xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ` +
    `office:version="1.2">` +
    `<office:automatic-styles/>` +
    `<office:body><office:text>${out.join("")}</office:text></office:body>` +
    `</office:document-content>`
  );
}

function buildManifestXml() {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<manifest:manifest ` +
    `xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" ` +
    `manifest:version="1.2">` +
    `<manifest:file-entry manifest:full-path="/" manifest:media-type="${MIME}" manifest:version="1.2"/>` +
    `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>` +
    `</manifest:manifest>`
  );
}

/**
 * @param {object|string} plan
 * @returns {{ buffer: Buffer, mime: string, extension: string }}
 */
function generateOdt(plan) {
  const normalized = typeof plan === "string" ? { body: plan } : plan || {};
  const buffer = zipBuild([
    { name: "mimetype", data: MIME, store: true },
    { name: "content.xml", data: buildContentXml(normalized) },
    { name: "META-INF/manifest.xml", data: buildManifestXml() },
  ]);
  return { buffer, mime: MIME, extension: "odt" };
}

module.exports = { generateOdt, MIME };
