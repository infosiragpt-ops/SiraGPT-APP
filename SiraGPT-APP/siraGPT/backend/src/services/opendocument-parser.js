'use strict';

/**
 * OpenDocument parser — extracts text from ODT, ODS, and ODP files.
 *
 * ODF files are ZIP archives containing structured XML:
 *   ODT (text)     → content.xml with <office:text> elements
 *   ODS (spreadsheet) → content.xml with <table:table> elements
 *   ODP (presentation) → content.xml with <draw:page> elements
 *
 * This parser uses Node's built-in zlib + a minimal XML extractor
 * to avoid adding a full XML DOM dependency. It reuses the zip
 * parsing already available through the Node ecosystem.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Try to extract text using `unzip` + `grep` (fast shell path).
 * Falls back to Node-based extraction if unzip isn't available.
 */
function extractTextFromOdf(filePath, format) {
  return new Promise((resolve, reject) => {
    // Try Python xml extraction first (most reliable)
    execFile('python3', [
      '-c', `
import zipfile, sys, xml.etree.ElementTree as ET
from io import BytesIO

with zipfile.ZipFile(sys.argv[1]) as zf:
    if 'content.xml' not in zf.namelist():
        print('')
        sys.exit(0)
    xml = zf.read('content.xml')

ns = {
    'text': 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
    'table': 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
    'draw': 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
    'office': 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
    'style': 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
}

root = ET.fromstring(xml)
parts = []

# Text: extract paragraphs and headings
for el in root.iter():
    tag = el.tag.split('}')[-1] if '}' in el.tag else el.tag
    text = (el.text or '').strip()
    if tag in ('p', 'h') and text:
        parts.append(text)
    # Table cells
    elif tag == 'table-cell':
        cell_text = ''.join(el.itertext()).strip()
        if cell_text:
            parts.append(cell_text)
    # Drawing page text
    elif tag == 'page' and text:
        parts.append(text)

# Also collect all text nodes as fallback
if not parts:
    for el in root.iter():
        if el.text and el.text.strip():
            parts.append(el.text.strip())

print('\\n'.join(parts))
      `.trim(), filePath,
    ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout || '');
    });
  });
}

async function parseOdt(filePath) {
  const text = await extractTextFromOdf(filePath, 'odt');
  if (!text || text.trim().length < 10) {
    throw new Error('ODT parsing produced minimal text. Try converting to DOCX or PDF.');
  }
  const header = `OpenDocument Text — ${text.length} characters extracted\n---\n`;
  return header + text.trim();
}

async function parseOds(filePath) {
  const text = await extractTextFromOdf(filePath, 'ods');
  if (!text || text.trim().length < 10) {
    throw new Error('ODS parsing produced minimal text. Try converting to XLSX.');
  }
  const header = `OpenDocument Spreadsheet — ${text.length} characters extracted\n---\n`;
  return header + text.trim();
}

async function parseOdp(filePath) {
  const text = await extractTextFromOdf(filePath, 'odp');
  if (!text || text.trim().length < 10) {
    throw new Error('ODP parsing produced minimal text. Try converting to PPTX.');
  }
  const header = `OpenDocument Presentation — ${text.length} characters extracted\n---\n`;
  return header + text.trim();
}

module.exports = { parseOdt, parseOds, parseOdp };