"use strict";

/**
 * Markdown generator with YAML frontmatter.
 *
 * Produces a Pandoc-friendly Markdown document with a leading
 * `---` … `---` YAML metadata block (title, author, date, …) followed
 * by the body and optional sections. Designed so the output can be
 * piped directly into Pandoc / Quarto downstream.
 *
 * Plan shape (all optional):
 *   {
 *     title, author, date,
 *     frontmatter: { ...extraKeys },   // merged after the canonical fields
 *     body, markdown,                  // raw body (string)
 *     sections: [{ heading, level?, body }]
 *   }
 *
 * A plain string plan is treated as the body.
 *
 * Returns { buffer, mime, extension }.
 */

const MIME = "text/markdown";
const EXT = "md";

const SAFE_SCALAR_RE = /^[A-Za-z0-9_./+\-][A-Za-z0-9 _./+\-]*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+\-]\d{2}:?\d{2})?)?$/;

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

function formatDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function yamlString(s) {
  const str = String(s);
  // Reserve double-quoted form for anything that would otherwise be
  // ambiguous (contains `:`, leading/trailing space, YAML reserved
  // tokens, control chars, or anything outside the safe-scalar set).
  if (
    str === "" ||
    /^(?:true|false|null|yes|no|on|off|~)$/i.test(str) ||
    /^[\s]/.test(str) ||
    /[\s]$/.test(str) ||
    /[:#\n\r\t"'\\\[\]{}|>*&!%@`]/.test(str) ||
    !SAFE_SCALAR_RE.test(str)
  ) {
    const escaped = str
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  return str;
}

function yamlScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value instanceof Date) {
    const iso = formatDate(value);
    return iso ? yamlString(iso) : "null";
  }
  return yamlString(value);
}

function yamlValue(value, indent) {
  if (Array.isArray(value)) {
    if (value.length === 0) return " []";
    let out = "";
    for (const item of value) {
      if (isPlainObject(item)) {
        const block = yamlObject(item, indent + "  ");
        out += `\n${indent}-${block.startsWith("\n") ? block : "\n" + indent + "  " + block.trimStart()}`;
      } else {
        out += `\n${indent}- ${yamlScalar(item)}`;
      }
    }
    return out;
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) return " {}";
    return "\n" + yamlObject(value, indent + "  ");
  }
  return ` ${yamlScalar(value)}`;
}

function yamlObject(obj, indent) {
  const lines = [];
  for (const [key, raw] of Object.entries(obj)) {
    if (raw === undefined) continue;
    const safeKey = SAFE_SCALAR_RE.test(key) ? key : yamlString(key);
    const rendered = yamlValue(raw, indent);
    if (rendered.startsWith("\n")) {
      lines.push(`${indent}${safeKey}:${rendered}`);
    } else {
      lines.push(`${indent}${safeKey}:${rendered}`);
    }
  }
  return lines.join("\n");
}

function buildFrontmatter(plan) {
  const meta = {};

  if (plan.title !== undefined && plan.title !== null && plan.title !== "") {
    meta.title = String(plan.title);
  }
  if (plan.author !== undefined && plan.author !== null && plan.author !== "") {
    meta.author = Array.isArray(plan.author) ? plan.author.map(String) : String(plan.author);
  }
  const date = formatDate(plan.date);
  if (date) meta.date = date;

  if (isPlainObject(plan.frontmatter)) {
    for (const [k, v] of Object.entries(plan.frontmatter)) {
      if (v === undefined) continue;
      // Don't override the canonical fields if they were already set
      if (k in meta) continue;
      meta[k] = v;
    }
  }

  const keys = Object.keys(meta);
  if (keys.length === 0) return "";

  const body = yamlObject(meta, "");
  return `---\n${body}\n---\n`;
}

function normalizeBody(text) {
  // Trim trailing whitespace on each line, collapse 3+ blank lines
  // into 2 and strip a leading BOM. Don't otherwise reflow the
  // Markdown — callers know what they're writing.
  let s = String(text || "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function buildSection(sec) {
  if (!sec || typeof sec !== "object") return "";
  const lvl = Number.isInteger(sec.level) ? Math.min(6, Math.max(1, sec.level)) : 2;
  const heading = sec.heading ? `${"#".repeat(lvl)} ${String(sec.heading).trim()}\n\n` : "";
  const body = normalizeBody(sec.body);
  return `${heading}${body}`.trim();
}

function buildBody(plan) {
  if (typeof plan === "string") return normalizeBody(plan);

  const sections = Array.isArray(plan.sections) ? plan.sections : null;
  if (sections && sections.length) {
    return sections
      .map(buildSection)
      .filter(Boolean)
      .join("\n\n");
  }

  const body = plan.body ?? plan.markdown ?? plan.text ?? "";
  return normalizeBody(body);
}

/**
 * @param {object|string} plan
 * @returns {{ buffer: Buffer, mime: string, extension: string }}
 */
function generateMarkdownFrontmatter(plan) {
  const safePlan = plan == null ? {} : plan;
  const fm = typeof safePlan === "string" ? "" : buildFrontmatter(safePlan);
  const body = buildBody(safePlan);
  const doc = fm ? (body ? `${fm}\n${body}\n` : `${fm}`) : (body ? `${body}\n` : "");
  return {
    buffer: Buffer.from(doc, "utf8"),
    mime: MIME,
    extension: EXT,
  };
}

module.exports = {
  generateMarkdownFrontmatter,
  buildFrontmatter,
  yamlString,
  MIME,
};
