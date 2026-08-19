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

// docs/legal lives at <repo>/docs/legal in source checkouts, while the Docker
// backend image is built from ./backend and packages the synced copy at
// /app/docs/legal. Prefer the source-tree canonical path when it exists.
function _resolveLegalDir() {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'docs', 'legal'),
    path.resolve(__dirname, '..', '..', 'docs', 'legal'),
  ];
  return candidates.find((dir) => fs.existsSync(dir)) || candidates[0];
}

const LEGAL_DIR = _resolveLegalDir();

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

// These endpoints are unauthenticated and polled (consent banner / status
// page), but the documents are static source-tree content. Cache the parsed
// result per (slug, version) for a short TTL so a hot poll loop doesn't hit
// the disk + run the front-matter regex on every request. The TTL matches the
// HTTP Cache-Control max-age (300s) and bounds how long a freshly-deployed doc
// can be stale.
const LEGAL_CACHE_TTL_MS = Number.parseInt(process.env.SIRAGPT_LEGAL_CACHE_TTL_MS || '300000', 10);
const _docCache = new Map(); // `${slug}::${version}` -> { doc, cachedAt }

// A legal version is either the sentinel 'latest' or a short token of safe
// filename characters. This is the security gate: `version` is attacker-
// controlled (query string / request body) and flows into a filesystem path
// in `_loadDocument`, so anything containing a path separator or `..` segment
// must be rejected BEFORE it reaches `path.join` to prevent traversal
// (e.g. `?version=../../../../etc/hosts` reading arbitrary `.md` files).
function isSafeVersion(version) {
  if (version === 'latest') return true;
  return typeof version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,32}$/.test(version);
}

function _loadDocument(slug, version) {
  const base = DOC_MAP[slug];
  if (!base) return null;
  const resolvedVersion = version || 'latest';
  // Reject unsafe version tokens at the single chokepoint shared by the GET
  // handlers and POST /accept — a malformed version resolves to "not found".
  if (!isSafeVersion(resolvedVersion)) return null;
  const cacheKey = `${slug}::${resolvedVersion}`;
  const now = Date.now();
  const cached = _docCache.get(cacheKey);
  if (cached && (now - cached.cachedAt) < LEGAL_CACHE_TTL_MS) return cached.doc;

  // Versioned filename pattern: <slug>.v<version>.md — falls back to
  // the canonical <slug>.md when missing or when version === 'latest'.
  let file = path.join(LEGAL_DIR, base);
  if (resolvedVersion !== 'latest') {
    const versioned = path.join(LEGAL_DIR, `${slug}.v${resolvedVersion}.md`);
    if (fs.existsSync(versioned)) file = versioned;
  }
  if (!fs.existsSync(file)) return null; // don't cache misses — a newly added doc should appear
  const markdown = fs.readFileSync(file, 'utf8');
  const meta = _parseFrontMatter(markdown);
  const doc = {
    document: slug,
    version: meta.version,
    lastUpdated: meta.lastUpdated,
    markdown,
  };
  _docCache.set(cacheKey, { doc, cachedAt: now });
  return doc;
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

// The Express router is the default export; the path-safety helper and the
// loader are attached for unit testing (legal.js has no DB dependency in the
// read path, so the traversal guard can be exercised directly).
router.isSafeVersion = isSafeVersion;
router._loadDocument = _loadDocument;
module.exports = router;
module.exports._internals = { _parseFrontMatter, _loadDocument, DOC_MAP, LEGAL_DIR };
