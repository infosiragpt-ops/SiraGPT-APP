/**
 * legal — Privacy Policy + Terms of Service endpoints.
 *
 * - `GET  /api/legal/privacy-policy?version=latest`
 * - `GET  /api/legal/terms-of-service?version=latest`
 * - `POST /api/legal/accept`  { version, document }
 *
 * Versions are parsed from the markdown front-matter comment in
 * `docs/legal/<doc>.md`:
 *
 *   <!--
 *     @version: 1.0.0
 *     @lastUpdated: 2026-05-19
 *   -->
 *
 * The current source-tree version is always served when `version=latest`
 * (the default). Specific historical versions are served by appending
 * `.v<semver>` to the filename if the operator chooses to keep an
 * archive — otherwise the only resolvable version is the one currently
 * in the repository.
 *
 * The accept endpoint stores a row in `policy_acceptance` (upsert per
 * version) and emits an audit-log entry capturing actor + ip + ua.
 */

'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const { writeAuditLog } = require('../utils/audit-log');

const router = express.Router();

const DOC_MAP = Object.freeze({
  'privacy-policy': 'privacy-policy.md',
  'terms-of-service': 'terms-of-service.md',
});

// docs/legal lives at <repo>/docs/legal — backend/src/routes is three
// levels deep, so resolve relative to __dirname.
const LEGAL_DIR = path.resolve(__dirname, '..', '..', '..', 'docs', 'legal');

function _parseFrontMatter(markdown) {
  const m = markdown.match(/<!--([\s\S]*?)-->/);
  if (!m) return { version: 'unversioned', lastUpdated: null };
  const block = m[1];
  const ver = block.match(/@version:\s*([^\n\r]+)/i);
  const upd = block.match(/@lastUpdated:\s*([^\n\r]+)/i);
  return {
    version: ver ? ver[1].trim() : 'unversioned',
    lastUpdated: upd ? upd[1].trim() : null,
  };
}

function _loadDocument(slug, version) {
  const base = DOC_MAP[slug];
  if (!base) return null;
  // Versioned filename pattern: <slug>.v<version>.md — falls back to
  // the canonical <slug>.md when missing or when version === 'latest'.
  let file = path.join(LEGAL_DIR, base);
  if (version && version !== 'latest') {
    const versioned = path.join(LEGAL_DIR, `${slug}.v${version}.md`);
    if (fs.existsSync(versioned)) file = versioned;
  }
  if (!fs.existsSync(file)) return null;
  const markdown = fs.readFileSync(file, 'utf8');
  const meta = _parseFrontMatter(markdown);
  return {
    document: slug,
    version: meta.version,
    lastUpdated: meta.lastUpdated,
    markdown,
  };
}

function _serveDoc(req, res, slug) {
  const version = String(req.query.version || 'latest');
  const doc = _loadDocument(slug, version);
  if (!doc) return res.status(404).json({ error: 'Document not found', document: slug, version });
  res.set('Cache-Control', 'public, max-age=300');
  return res.json(doc);
}

router.get('/privacy-policy', (req, res) => _serveDoc(req, res, 'privacy-policy'));
router.get('/terms-of-service', (req, res) => _serveDoc(req, res, 'terms-of-service'));

router.post('/accept', authenticateToken, async (req, res) => {
  const userId = req.user && req.user.id;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const document = String((req.body && req.body.document) || '').trim();
  const version = String((req.body && req.body.version) || '').trim();
  if (!document || !DOC_MAP[document]) {
    return res.status(400).json({ error: 'invalid_document', allowed: Object.keys(DOC_MAP) });
  }
  if (!version) return res.status(400).json({ error: 'missing_version' });

  // Verify the version actually exists in the repo so we don't accept
  // arbitrary client-supplied strings.
  const known = _loadDocument(document, version === 'latest' ? 'latest' : version);
  if (!known) return res.status(404).json({ error: 'unknown_version', document, version });
  const resolvedVersion = known.version;

  const ip = (req.headers && req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : req.ip) || null;
  const ua = (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']) : null;

  try {
    const record = await prisma.policyAcceptance.upsert({
      where: { userId_document_version: { userId, document, version: resolvedVersion } },
      create: { userId, document, version: resolvedVersion, ip, ua },
      update: { acceptedAt: new Date(), ip, ua },
    });
    void writeAuditLog(prisma, {
      req,
      action: 'legal_policy_accept',
      resource: 'policy_acceptance',
      resourceId: record.id,
      metadata: { document, version: resolvedVersion },
    });
    return res.status(200).json({
      ok: true,
      document,
      version: resolvedVersion,
      acceptedAt: record.acceptedAt,
    });
  } catch (error) {
    // Most likely cause is the migration for the policy_acceptance
    // table not having run yet in this environment. Surface a 503 so
    // the client retries instead of treating it as user error.
    console.error('[legal/accept] persistence error:', error?.message || error);
    return res.status(503).json({ error: 'accept_unavailable' });
  }
});

module.exports = router;
module.exports._internals = { _parseFrontMatter, _loadDocument, DOC_MAP, LEGAL_DIR };
