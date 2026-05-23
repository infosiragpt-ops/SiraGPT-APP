"use strict";

/**
 * Minimal EPUB 3 generator. Produces a zip carrying:
 *   - mimetype (stored, first entry)
 *   - META-INF/container.xml
 *   - OEBPS/content.opf
 *   - OEBPS/nav.xhtml
 *   - OEBPS/<chapter>.xhtml ...
 *
 * Plan shape (all optional):
 *   { title, author, language, identifier,
 *     sections: [{ heading, body }] }
 */

const { randomUUID } = require("node:crypto");
const { zipBuild, xmlEscape } = require("./zip-utils");

const MIME = "application/epub+zip";

function paragraphsOf(text) {
  return String(text || "")
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function chapterFromSection(s, idx) {
  return {
    id: `ch${idx + 1}`,
    title: (s && s.heading) || `Chapter ${idx + 1}`,
    body: (s && s.body) || "",
  };
}

function buildChapterXhtml(ch) {
  const body = paragraphsOf(ch.body)
    .map((p) => `<p>${xmlEscape(p)}</p>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">` +
    `<head><meta charset="UTF-8"/><title>${xmlEscape(ch.title)}</title></head>` +
    `<body><h1>${xmlEscape(ch.title)}</h1>${body || "<p/>"}</body>` +
    `</html>`
  );
}

function buildOpf({ title, author, language, identifier, modified, chapters }) {
  const manifestItems = chapters
    .map(
      (c) =>
        `<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join("");
  const spineItems = chapters.map((c) => `<itemref idref="${c.id}"/>`).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${xmlEscape(language)}">` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:identifier id="bookid">${xmlEscape(identifier)}</dc:identifier>` +
    `<dc:title>${xmlEscape(title)}</dc:title>` +
    `<dc:creator>${xmlEscape(author)}</dc:creator>` +
    `<dc:language>${xmlEscape(language)}</dc:language>` +
    `<meta property="dcterms:modified">${xmlEscape(modified)}</meta>` +
    `</metadata>` +
    `<manifest>` +
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
    manifestItems +
    `</manifest>` +
    `<spine>${spineItems}</spine>` +
    `</package>`
  );
}

function buildNavXhtml(chapters) {
  const items = chapters
    .map((c) => `<li><a href="${c.id}.xhtml">${xmlEscape(c.title)}</a></li>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">` +
    `<head><meta charset="UTF-8"/><title>Contents</title></head>` +
    `<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${items}</ol></nav></body>` +
    `</html>`
  );
}

const CONTAINER_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
  `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>` +
  `</container>`;

/**
 * @param {object|string} plan
 * @returns {{ buffer: Buffer, mime: string, extension: string }}
 */
function generateEpub(plan) {
  const p = typeof plan === "string" ? { body: plan } : plan || {};
  const title = p.title || "Untitled";
  const author = p.author || "Unknown";
  const language = p.language || "en";
  const identifier = p.identifier || `urn:uuid:${randomUUID()}`;
  const modified = (p.modified || new Date().toISOString()).replace(/\.\d{3}Z$/, "Z");

  const sections = Array.isArray(p.sections) ? p.sections : null;
  let chapters;
  if (sections && sections.length) {
    chapters = sections.map(chapterFromSection);
  } else {
    chapters = [{ id: "ch1", title, body: p.body || p.markdown || p.text || "" }];
  }

  const entries = [
    { name: "mimetype", data: MIME, store: true },
    { name: "META-INF/container.xml", data: CONTAINER_XML },
    {
      name: "OEBPS/content.opf",
      data: buildOpf({ title, author, language, identifier, modified, chapters }),
    },
    { name: "OEBPS/nav.xhtml", data: buildNavXhtml(chapters) },
    ...chapters.map((c) => ({
      name: `OEBPS/${c.id}.xhtml`,
      data: buildChapterXhtml(c),
    })),
  ];

  return { buffer: zipBuild(entries), mime: MIME, extension: "epub" };
}

module.exports = { generateEpub, MIME };
