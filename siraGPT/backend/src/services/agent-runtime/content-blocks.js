"use strict";

const path = require("path");

const IMAGE_MIME_RE = /^image\//i;
const AUDIO_MIME_RE = /^audio\//i;
const VIDEO_MIME_RE = /^video\//i;

function buildContentBlocks({ text = "", attachments = [], history = [] } = {}) {
  const blocks = [];
  const cleanText = typeof text === "string" ? text.trim() : "";
  if (cleanText) {
    blocks.push(createTextBlock(cleanText, { role: "user", source: "current_turn" }));
  }

  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const block = attachmentToBlock(attachment);
    if (block) blocks.push(block);
  }

  const recent = Array.isArray(history) ? history.slice(-8) : [];
  for (const message of recent) {
    const files = Array.isArray(message?.files) ? message.files : [];
    for (const file of files) {
      const block = attachmentToBlock({ ...file, from_history: true });
      if (block) blocks.push(block);
    }
  }

  return validateContentBlocks(dedupeBlocks(blocks));
}

function createTextBlock(text, extras = {}) {
  return Object.freeze({
    id: extras.id || stableId("text", text),
    type: "text",
    text,
    annotations: Array.isArray(extras.annotations) ? extras.annotations : [],
    extras: stripUndefined({ ...extras }),
  });
}

function attachmentToBlock(attachment) {
  if (!attachment || typeof attachment !== "object") return null;
  const filename = attachment.filename || attachment.originalName || attachment.name || attachment.file_id || attachment.id || "attachment";
  const mimeType = attachment.mime_type || attachment.mimeType || attachment.type || mimeFromName(filename);
  const url = attachment.url || attachment.download_url || attachment.preview_url || attachment.path || attachment.localPath || null;
  const id = attachment.file_id || attachment.fileId || attachment.id || stableId("file", `${filename}:${mimeType}:${url || ""}`);
  const base = {
    id: String(id),
    filename: String(filename),
    mime_type: String(mimeType || ""),
    size_bytes: Number(attachment.size_bytes || attachment.size || 0),
    status: attachment.status || "available",
    url,
    extras: stripUndefined({
      source: attachment.from_history ? "conversation_history" : "current_turn",
      extracted_text: attachment.extractedText || attachment.extracted_text || null,
      openai_file_id: attachment.openaiFileId || attachment.openai_file_id || null,
    }),
  };

  if (IMAGE_MIME_RE.test(base.mime_type) || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(base.filename)) {
    return Object.freeze({ ...base, type: "image" });
  }
  if (AUDIO_MIME_RE.test(base.mime_type)) return Object.freeze({ ...base, type: "audio" });
  if (VIDEO_MIME_RE.test(base.mime_type)) return Object.freeze({ ...base, type: "video" });
  if (isDocument(base.filename, base.mime_type)) return Object.freeze({ ...base, type: "document" });
  return Object.freeze({ ...base, type: "file" });
}

function validateContentBlocks(blocks) {
  if (!Array.isArray(blocks)) throw new Error("content blocks must be an array");
  return Object.freeze(blocks.map((block) => {
    if (!block || typeof block !== "object") throw new Error("content block must be an object");
    if (!block.id || typeof block.id !== "string") throw new Error("content block id required");
    if (!["text", "image", "document", "file", "audio", "video"].includes(block.type)) {
      throw new Error(`unsupported content block type "${block.type}"`);
    }
    if (block.type === "text" && typeof block.text !== "string") {
      throw new Error("text content block requires text");
    }
    if (block.type !== "text" && !block.filename) {
      throw new Error(`${block.type} content block requires filename`);
    }
    return Object.freeze({ ...block });
  }));
}

function summarizeContentBlocks(blocks) {
  const counts = {};
  for (const block of blocks || []) counts[block.type] = (counts[block.type] || 0) + 1;
  return Object.freeze({
    total: Array.isArray(blocks) ? blocks.length : 0,
    counts,
    has_text: Boolean(counts.text),
    has_image: Boolean(counts.image),
    has_document: Boolean(counts.document),
    has_file_context: Boolean(counts.document || counts.file || counts.image),
  });
}

function dedupeBlocks(blocks) {
  const seen = new Set();
  const out = [];
  for (const block of blocks) {
    const key = `${block.type}:${block.id}:${block.filename || ""}:${block.text || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(block);
  }
  return out;
}

function stableId(prefix, seed) {
  const value = String(seed || "").split("").reduce((acc, char) => ((acc * 31) + char.charCodeAt(0)) >>> 0, 7);
  return `${prefix}_${value.toString(16)}`;
}

function mimeFromName(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  return ({
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
  })[ext] || "application/octet-stream";
}

function isDocument(filename, mimeType) {
  return /pdf|wordprocessingml|spreadsheetml|presentationml|msword|officedocument|text\/csv|text\/plain|markdown/i.test(mimeType)
    || /\.(docx?|xlsx?|pptx?|pdf|csv|tsv|txt|md)$/i.test(filename);
}

function stripUndefined(value) {
  const out = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item !== undefined && item !== null) out[key] = item;
  }
  return out;
}

module.exports = {
  buildContentBlocks,
  createTextBlock,
  attachmentToBlock,
  validateContentBlocks,
  summarizeContentBlocks,
};
