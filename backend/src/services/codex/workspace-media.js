'use strict';

const { extname } = require('node:path');
const { screenshotContentBlock } = require('./browser-check');

const MAX_MEDIA_BYTES = 6_000_000;
const MAX_PDF_TEXT_CHARS = 40_000;

function detectMediaType(buffer, path = '') {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }

  const extension = extname(String(path || '')).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  return null;
}

async function extractPdfText(buffer, { pdfParseImpl = null } = {}) {
  // Lazy require keeps the normal tool registry cheap and lets tests inject a
  // parser without native/network dependencies.
  // eslint-disable-next-line global-require
  const parse = pdfParseImpl || require('pdf-parse');
  const result = await parse(buffer);
  return {
    pages: Number(result?.numpages) || null,
    text: String(result?.text || '').replace(/\u0000/g, '').trim().slice(0, MAX_PDF_TEXT_CHARS),
  };
}

function pdfDocumentBlock(buffer, provider, env = process.env) {
  const isAnthropic = String(provider || '').toLowerCase().includes('anthropic');
  if (!isAnthropic || String(env.CODEX_PDF_DOCUMENTS ?? '1') === '0') return null;
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: buffer.toString('base64'),
    },
  };
}

async function readWorkspaceMedia({
  runner,
  project,
  path,
  modelCapabilities = {},
  provider = null,
  env = process.env,
  pdfParseImpl = null,
} = {}) {
  if (!runner?.readBinaryFile) throw new Error('runner_binary_read_unavailable');
  const result = await runner.readBinaryFile(project, path);
  const bytes = Number(result?.bytes) || 0;
  if (!result?.contentBase64 || bytes <= 0 || bytes > MAX_MEDIA_BYTES) {
    throw new Error(bytes > MAX_MEDIA_BYTES ? 'file_too_large' : 'empty_media_file');
  }
  const buffer = Buffer.from(result.contentBase64, 'base64');
  if (buffer.length !== bytes) throw new Error('invalid_binary_payload');
  const mediaType = detectMediaType(buffer, path);
  if (!mediaType) throw new Error('unsupported_media_type');

  if (mediaType.startsWith('image/')) {
    const report = `Imagen del workspace: ${path}\nTipo: ${mediaType}\nTamaño: ${bytes} bytes.`;
    if (modelCapabilities?.supportsImages !== true) {
      return {
        mediaType,
        bytes,
        observation: `${report}\nEl modelo activo no admite visión; cambia a un modelo multimodal para inspeccionar sus píxeles.`,
      };
    }
    const block = screenshotContentBlock(`data:${mediaType};base64,${result.contentBase64}`, provider || 'anthropic');
    if (!block) throw new Error('invalid_image_payload');
    return {
      mediaType,
      bytes,
      observation: [{ type: 'text', text: `${report}\nInspecciona visualmente esta imagen antes de modificar la interfaz.` }, block],
    };
  }

  let extracted = { pages: null, text: '' };
  let extractionError = null;
  try {
    extracted = await extractPdfText(buffer, { pdfParseImpl });
  } catch (error) {
    extractionError = String(error?.message || error).slice(0, 500);
  }
  const report = [
    `PDF del workspace: ${path}`,
    `Tamaño: ${bytes} bytes${extracted.pages ? ` · ${extracted.pages} página(s)` : ''}.`,
    extractionError ? `Extracción de texto no disponible: ${extractionError}` : null,
    extracted.text ? `\nTexto extraído:\n${extracted.text}` : '\nNo se extrajo texto; puede ser un PDF escaneado.',
  ].filter(Boolean).join('\n');
  const document = pdfDocumentBlock(buffer, provider, env);
  return {
    mediaType,
    bytes,
    pages: extracted.pages,
    observation: document
      ? [{ type: 'text', text: report }, document]
      : report,
  };
}

module.exports = {
  MAX_MEDIA_BYTES,
  MAX_PDF_TEXT_CHARS,
  detectMediaType,
  extractPdfText,
  pdfDocumentBlock,
  readWorkspaceMedia,
};
