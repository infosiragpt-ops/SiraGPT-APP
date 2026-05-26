"use strict";

/**
 * Minimal RTF 1.x generator. Produces a single-document RTF stream
 * with proper escaping of special characters and Unicode (\\uN?).
 *
 * Plan shape (all optional):
 *   { title, author, body, sections: [{ heading, body }] }
 *
 * Returns a Buffer carrying the RTF stream.
 */

const MIME = "application/rtf";

/**
 * Escape a string for safe inclusion in an RTF body. Outside the
 * 7-bit ASCII range we emit the RTF Unicode form `\uN?` where N is a
 * signed 16-bit decimal. Characters outside the BMP are decomposed
 * into a UTF-16 surrogate pair (also emitted as two `\uN?` tokens).
 */
function escapeRtf(input) {
  if (input == null) return "";
  const s = String(input);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = s[i];
    if (ch === "\\" || ch === "{" || ch === "}") {
      out += "\\" + ch;
    } else if (ch === "\n") {
      out += "\\par\n";
    } else if (ch === "\r") {
      // collapse — \n carries the break
      continue;
    } else if (ch === "\t") {
      out += "\\tab ";
    } else if (code >= 0x20 && code < 0x80) {
      out += ch;
    } else {
      // RTF \u expects a signed 16-bit integer
      const signed = code >= 0x8000 ? code - 0x10000 : code;
      out += `\\u${signed}?`;
    }
  }
  return out;
}

function paragraphsOf(text) {
  return String(text || "")
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function buildBody(plan) {
  const parts = [];
  if (plan && plan.title) {
    parts.push(`{\\b\\fs36 ${escapeRtf(plan.title)}}\\par\\par`);
  }
  if (plan && plan.author) {
    parts.push(`{\\i ${escapeRtf(plan.author)}}\\par\\par`);
  }

  const sections = plan && Array.isArray(plan.sections) ? plan.sections : null;
  if (sections && sections.length) {
    for (const sec of sections) {
      if (!sec || typeof sec !== "object") continue;
      if (sec.heading) {
        parts.push(`{\\b\\fs28 ${escapeRtf(sec.heading)}}\\par`);
      }
      for (const p of paragraphsOf(sec.body)) {
        parts.push(`${escapeRtf(p)}\\par`);
      }
      parts.push("\\par");
    }
  } else {
    const body = typeof plan === "string"
      ? plan
      : plan && (plan.body || plan.markdown || plan.text || "");
    for (const p of paragraphsOf(body)) {
      parts.push(`${escapeRtf(p)}\\par`);
    }
  }

  if (parts.length === 0) parts.push("\\par");
  return parts.join("\n");
}

/**
 * @param {object|string} plan
 * @returns {{ buffer: Buffer, mime: string, extension: string }}
 */
function generateRtf(plan) {
  const body = buildBody(plan || {});
  const header =
    "{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1" +
    "{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1\\fswiss Arial;}}" +
    "{\\colortbl;\\red0\\green0\\blue0;}" +
    "\\fs24\n";
  const rtf = `${header}${body}\n}`;
  return {
    buffer: Buffer.from(rtf, "utf8"),
    mime: MIME,
    extension: "rtf",
  };
}

module.exports = { generateRtf, escapeRtf, MIME };
