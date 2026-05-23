/**
 * format-sovereignty — hard gate that enforces the
 * UniversalTaskContract's required_extension + mime_type as
 * non-negotiable. If the user said "SVG", the only artifact that
 * can leave this pipeline is an .svg with image/svg+xml. Anything
 * else is a format violation and triggers a FailureReport.
 *
 * The engine is pure and synchronous: it consumes a contract + an
 * artifact descriptor (filename, buffer) and returns a decision
 * object. It never mutates the artifact. The orchestrator decides
 * what to do with a violation — the default is hard-block + repair.
 */

const { pickPipeline } = require("./pipeline-registry");

function extOf(filename) {
  const m = String(filename || "").match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : null;
}

function sniffMimeFromBuffer(buffer, hintedExt) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const h = buffer.slice(0, 8);
  if (h.slice(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return "image/png";
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return "image/jpeg";
  if (h.slice(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (h.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (h[0] === 0x50 && h[1] === 0x4b) {
    if (hintedExt === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (hintedExt === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (hintedExt === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    return "application/zip";
  }
  try {
    const text = buffer.slice(0, 2048).toString("utf8");
    if (/^\s*<\?xml[^>]*\?>\s*<svg[\s>]/i.test(text) || /^\s*<svg[\s>]/i.test(text)) return "image/svg+xml";
    if (/^\s*<\?xml/i.test(text)) return "application/xml";
    if (/^\s*<!doctype html|^\s*<html[\s>]/i.test(text)) return "text/html";
    if (/^\s*[{[]/.test(text)) {
      try { JSON.parse(buffer.toString("utf8")); return "application/json"; } catch { /* fall through */ }
    }
  } catch { /* binary */ }
  if (hintedExt === "csv") return "text/csv";
  if (hintedExt === "md") return "text/markdown";
  if (hintedExt === "txt") return "text/plain";
  return "application/octet-stream";
}

/**
 * Enforce format sovereignty for one produced artifact.
 *
 * @param {object} args
 * @param {object} args.contract — UniversalTaskContract
 * @param {object} args.artifact — { filename, buffer }
 *
 * @returns {{
 *   ok: boolean,
 *   violations: Array<{ id: string, expected: string, actual: string, detail: string }>,
 *   pipeline: string,
 *   expected: { extension: string|null, mime: string|null },
 *   actual: { extension: string|null, mime: string|null },
 *   repairHint: string|null,
 *   policy: "hard-block"|"warn"|"ignore",
 * }}
 */
function enforceSovereignty({ contract, artifact }) {
  const policy = contract?.format_violation_policy || "hard-block";
  const pipeline = pickPipeline(contract);
  const ext = extOf(artifact?.filename);
  const mime = Buffer.isBuffer(artifact?.buffer)
    ? sniffMimeFromBuffer(artifact.buffer, ext)
    : artifact?.mime || null;
  const violations = [];

  // 1. required_extension check.
  const requiredExt = contract?.required_extension || null;
  if (requiredExt !== null && requiredExt !== ext) {
    violations.push({
      id: "required_extension_mismatch",
      expected: requiredExt,
      actual: ext || "(none)",
      detail: `Contract required_extension=${requiredExt}, artifact delivered as .${ext || "(none)"} — format sovereignty violation.`,
    });
  }

  // 2. mime_type check against contract.
  const requiredMime = contract?.mime_type || null;
  if (requiredMime !== null && requiredMime !== mime) {
    violations.push({
      id: "required_mime_mismatch",
      expected: requiredMime,
      actual: mime || "(unknown)",
      detail: `Contract mime_type=${requiredMime}, sniffed MIME=${mime || "(unknown)"}.`,
    });
  }

  // 3. pipeline ALLOWLIST check — even if the contract drifted, the
  //    pipeline declared a closed set. If the produced extension is
  //    not in its allowed list, reject.
  if (Array.isArray(pipeline.allowedExtensions) && pipeline.allowedExtensions.length > 0) {
    const allowed = pipeline.allowedExtensions;
    if (!allowed.includes(ext) && !(ext === null && allowed.includes(null))) {
      violations.push({
        id: "pipeline_extension_not_allowed",
        expected: allowed.filter(Boolean).map(e => `.${e}`).join("/"),
        actual: ext ? `.${ext}` : "(none)",
        detail: `${pipeline.name} only accepts ${allowed.filter(Boolean).map(e => `.${e}`).join("/") || "null-extension deliverables"}; got .${ext || "(none)"}.`,
      });
    }
  }

  // 4. forbidden_outputs — treat any forbidden extension as a hard
  //    violation if the delivered artifact uses it.
  const forbidden = Array.isArray(contract?.forbidden_outputs) ? contract.forbidden_outputs.join(" | ") : "";
  if (ext && forbidden && new RegExp(`\\.${ext}\\b`, "i").test(forbidden)) {
    violations.push({
      id: "forbidden_extension_delivered",
      expected: `not .${ext}`,
      actual: `.${ext}`,
      detail: `forbidden_outputs mentions .${ext} and the artifact uses that extension.`,
    });
  }

  const ok = violations.length === 0;
  const repairHint = ok ? null : [
    `Format sovereignty violated: ${violations.map(v => v.id).join(", ")}.`,
    `Regenerate with filename ending in .${requiredExt} and content that produces MIME ${requiredMime || "(the required one)"}.`,
    `Do NOT substitute formats (this violates the user's intent).`,
  ].join(" ");

  return {
    ok,
    violations,
    pipeline: pipeline.name,
    expected: { extension: requiredExt, mime: requiredMime },
    actual: { extension: ext, mime },
    repairHint,
    policy,
  };
}

module.exports = { enforceSovereignty, sniffMimeFromBuffer, extOf };
