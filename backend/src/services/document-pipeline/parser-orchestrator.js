'use strict';

const { parserPlanFor } = require('../../../orchestration/document-pipeline');

let _marker = null;
function getMarker() {
  if (_marker) return _marker;
  try { _marker = require('./parsers/marker-adapter').createMarkerParser(); } catch (_) { _marker = { available: () => Promise.resolve(false) }; }
  return _marker;
}

let _docling = null;
function getDocling() {
  if (_docling) return _docling;
  try { _docling = require('./parsers/docling-adapter').createDoclingParser(); } catch (_) { _docling = { available: () => Promise.resolve(false) }; }
  return _docling;
}

let _markitdown = null;
function getMarkItDown() {
  if (_markitdown) return _markitdown;
  try { _markitdown = require('./parsers/markitdown-adapter').createMarkItDownParser(); } catch (_) { _markitdown = { available: () => Promise.resolve(false) }; }
  return _markitdown;
}

async function parseFileWithBestParser(filePath, fileInfo = {}) {
  const parserOrder = parserPlanFor(fileInfo);
  for (const parserName of parserOrder) {
    switch (parserName) {
      case 'marker': { const m = getMarker(); if (await m.available()) return m.parse(filePath); continue; }
      case 'docling': { const d = getDocling(); if (await d.available()) return d.parse(filePath); continue; }
      case 'markitdown': { const md = getMarkItDown(); if (await md.available()) return md.parse(filePath); continue; }
      case 'unstructured': case 'surya-ocr': case 'mammoth': case 'exceljs': case 'officeparser': continue;
      default: return { parser: parserName, available: true, text: null, fallback: true, internal: true };
    }
  }
  return { parser: 'none', available: false, text: null, fallback: true, error: 'No parser available' };
}

function pipelineQualityScore(result) {
  if (result?.available && !result?.fallback) return 0.95;
  if (result?.fallback && !result?.internal) return 0.6;
  if (result?.internal) return 0.4;
  return 0;
}

module.exports = { parseFileWithBestParser, pipelineQualityScore, getMarker, getDocling, getMarkItDown };
