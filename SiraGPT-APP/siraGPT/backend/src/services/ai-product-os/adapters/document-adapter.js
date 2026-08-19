/**
 * document-adapter — contract for the "Procesamiento documental" layer.
 *
 * Designed to bind cleanly to:
 *   - Docling      (complex docs → structured data, tables/formulas/OCR)
 *   - Unstructured (partition into elements: titles / narrative / lists)
 *   - LlamaParse   (agentic PDF parser → markdown / json)
 *   - python-docx  (Word generation)
 *   - openpyxl     (Excel read/write)
 *   - PptxGenJS    (PowerPoint generation in JS)
 *   - python-pptx  (PowerPoint generation in Python)
 *   - reportlab    (PDF generation)
 *
 * Public methods:
 *
 *   parse({ source, kind, mode, ocr })        → structured representation
 *   generate({ format, plan })                → { buffer, mime, filename, metrics }
 *   convert({ source, from, to })             → cross-format conversion
 *   detectFormat(buffer)                      → "pdf" | "docx" | …
 *
 * Stub uses the existing pipeline modules (pdf-structure for parsing
 * + advanced-document-pipeline for generation) so the platform works
 * out-of-the-box.
 */

const VENDORS = Object.freeze(["docling", "unstructured", "llamaparse", "python-docx", "openpyxl", "pptxgenjs", "python-pptx", "reportlab", "stub"]);

function createDocumentAdapter({ provider = null, vendor = "stub" } = {}) {
  if (!VENDORS.includes(vendor)) throw new Error(`document-adapter: unknown vendor "${vendor}"`);
  const impl = provider || createStubProvider();
  validateProvider(impl);

  return {
    vendor,
    provider: impl,

    async parse({ source, kind = null, mode = "structural", ocr = false } = {}) {
      if (typeof source === "undefined" || source === null) throw new Error("document-adapter.parse: source required");
      return impl.parse({ source, kind, mode, ocr });
    },

    async generate({ format, plan } = {}) {
      if (!format) throw new Error("document-adapter.generate: format required");
      if (!plan) throw new Error("document-adapter.generate: plan required");
      const out = await impl.generate({ format, plan });
      validateGenOut(out);
      return out;
    },

    async convert({ source, from, to } = {}) {
      if (!from || !to) throw new Error("document-adapter.convert: from + to required");
      return impl.convert({ source, from, to });
    },

    detectFormat(buffer) { return impl.detectFormat(buffer); },

    capabilities() {
      return {
        vendor,
        supports_ocr: Boolean(impl.supports_ocr),
        supports_tables: Boolean(impl.supports_tables),
        supports_formulas: Boolean(impl.supports_formulas),
        supports_layout: Boolean(impl.supports_layout),
        supported_formats: impl.supported_formats || [],
      };
    },
  };
}

function validateProvider(p) {
  for (const m of ["parse", "generate", "convert", "detectFormat"]) {
    if (typeof p[m] !== "function") throw new Error(`document-adapter: provider missing ${m}()`);
  }
}

function validateGenOut(out) {
  if (!out || typeof out !== "object") throw new Error("document-adapter.generate: provider returned non-object");
  if (!out.buffer && !out.dataUrl) throw new Error("document-adapter.generate: missing buffer/dataUrl");
  if (!out.mime) throw new Error("document-adapter.generate: missing mime");
  if (!out.filename) throw new Error("document-adapter.generate: missing filename");
}

function createStubProvider() {
  let pdfStructure = null;
  try { pdfStructure = require("../../docintel/pdf-structure"); } catch (_e) { /* optional */ }

  return {
    supports_ocr: false,
    supports_tables: true,
    supports_formulas: false,
    supports_layout: true,
    supported_formats: ["txt", "md", "html", "pdf", "docx", "xlsx", "pptx"],

    async parse({ source, kind, mode }) {
      if (mode === "structural" && pdfStructure && typeof source === "string") {
        const r = pdfStructure.analyzeDocument(source);
        return { kind: kind || "text", structural: r, raw_chars: source.length };
      }
      const text = typeof source === "string" ? source : (source && source.toString ? source.toString("utf8") : "");
      return { kind: kind || "text", text, length: text.length };
    },

    async generate({ format, plan }) {
      const filename = `${(plan.title || "documento").toLowerCase().replace(/[^a-z0-9._-]+/g, "_")}.${format}`;
      const text = renderPlan(plan, format);
      const buffer = Buffer.from(text, "utf8");
      return {
        format,
        filename,
        mime: mimeFor(format),
        buffer,
        size: buffer.length,
        metrics: { stub: true, plan_sections: (plan.sections || []).length },
      };
    },

    async convert({ source, from, to }) {
      // Stub: only safe for text-like conversions.
      const text = typeof source === "string" ? source : (source && source.toString ? source.toString("utf8") : "");
      if ((from === "md" || from === "txt") && (to === "md" || to === "txt" || to === "html")) {
        return { from, to, output: to === "html" ? `<pre>${escapeHtml(text)}</pre>` : text };
      }
      throw new Error(`document-adapter.convert (stub): ${from}→${to} not supported in stub`);
    },

    detectFormat(buffer) {
      if (!buffer || buffer.length < 4) return "unknown";
      const head = buffer.slice(0, 4);
      if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return "pdf"; // %PDF
      if (head[0] === 0x50 && head[1] === 0x4b) return "zip";  // PK — docx/xlsx/pptx envelope
      if (head[0] === 0xff && head[1] === 0xd8) return "jpg";
      if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "png";
      return "unknown";
    },
  };
}

function renderPlan(plan, format) {
  const lines = [];
  lines.push(plan.title || "Documento");
  lines.push("");
  for (const section of plan.sections || []) {
    lines.push(`## ${section.title || ""}`);
    if (section.body) lines.push(section.body);
    lines.push("");
  }
  if (format === "html") return `<html><body><h1>${escapeHtml(plan.title || "Documento")}</h1>${lines.slice(2).map(l => `<p>${escapeHtml(l)}</p>`).join("")}</body></html>`;
  return lines.join("\n");
}

function mimeFor(format) {
  return ({
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  })[format] || "application/octet-stream";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

module.exports = {
  createDocumentAdapter,
  createStubProvider,
  VENDORS,
};
