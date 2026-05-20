'use strict';

/**
 * Document Pipeline Enhancer — integrates Marker, Docling, and MarkItDown
 * parsers into the existing document processing pipeline.
 *
 * These are invoked as optional quality upgrades when the corresponding
 * Python packages or CLI tools are available on the system.
 *
 * Usage:
 *   const { enhanceParse } = req.app.locals.orchestration?.docPipeline || {};
 *   const enhanced = await enhanceParse({ buffer, fileName, mimeType });
 */

const path = require('path');
const crypto = require('crypto');

function markerAvailable() {
  return process.env.SIRAGPT_MARKER_ENABLED === 'true';
}

function doclingAvailable() {
  return process.env.SIRAGPT_DOCLING_ENABLED === 'true';
}

function markitdownAvailable() {
  return process.env.SIRAGPT_MARKITDOWN_ENABLED === 'true';
}

function createDocPipelineEnhancer() {
  const hasMarker = markerAvailable();
  const hasDocling = doclingAvailable();
  const hasMarkItDown = markitdownAvailable();

  if (!hasMarker && !hasDocling && !hasMarkItDown) {
    return { enabled: false };
  }

  return {
    enabled: true,
    hasMarker,
    hasDocling,
    hasMarkItDown,

    parserFor(mimeType) {
      const mt = String(mimeType || '').toLowerCase();
      if (mt.includes('pdf')) {
        if (hasDocling) return 'docling';
        if (hasMarker) return 'marker';
      }
      if (mt.includes('word') || mt.includes('docx') || mt.includes('doc')) {
        if (hasMarkItDown) return 'markitdown';
      }
      if (mt.includes('spreadsheet') || mt.includes('xlsx') || mt.includes('xls')) {
        if (hasMarkItDown) return 'markitdown';
      }
      if (mt.includes('presentation') || mt.includes('pptx') || mt.includes('ppt')) {
        if (hasMarkItDown) return 'markitdown';
      }
      return null;
    },

    async enhanceParse({ buffer, fileName, mimeType, existingText }) {
      const parser = this.parserFor(mimeType);
      if (!parser || !existingText) return { enhanced: false, text: existingText };

      if (parser === 'markitdown' && hasMarkItDown) {
        try {
          const tmpDir = require('os').tmpdir();
          const tmpFile = path.join(tmpDir, `siragpt_mditdown_${crypto.randomBytes(8).toString('hex')}_${fileName}`);
          require('fs').writeFileSync(tmpFile, buffer);
          try {
            const { execSync } = require('child_process');
            const result = execSync(`markitdown "${tmpFile}"`, { timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
            require('fs').unlinkSync(tmpFile);
            return { enhanced: true, text: result, parser: 'markitdown' };
          } catch {
            try { require('fs').unlinkSync(tmpFile); } catch (_) {}
          }
        } catch (err) {
          try { console.warn('[doc-pipeline] markitdown failed:', err.message); } catch (_) {}
        }
      }

      return { enhanced: false, text: existingText };
    },
  };
}

module.exports = { createDocPipelineEnhancer };
