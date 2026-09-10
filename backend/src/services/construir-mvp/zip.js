'use strict';

/**
 * Zip helper for CONSTRUIR project downloads.
 * Reuses the in-repo STORE zip builder (no extra npm dep).
 */

const { buildZip } = require('../agentes-coding/export/archive');

async function zipProjectFiles(files) {
  const entries = [];
  for (const [rel, content] of Object.entries(files && typeof files === 'object' ? files : {})) {
    const name = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name || name.includes('..') || name.includes('\0')) continue;
    entries.push({
      path: name,
      data: Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8'),
    });
  }
  return buildZip(entries);
}

module.exports = { zipProjectFiles };
