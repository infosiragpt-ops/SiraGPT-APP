/**
 * Sira Appshots — Chrome-extension capture pipeline.
 *
 * Two endpoints:
 *
 *   POST /api/appshots/pair      Cookie-auth + CSRF. Mints a long-lived
 *                                bearer token the extension stores locally.
 *                                Shown ONCE; user can revoke from settings.
 *
 *   POST /api/appshots/capture   Bearer-only, CSRF-exempt. Accepts a single
 *                                PNG (`image` multipart field), saves it as
 *                                a regular File row, creates a brand-new
 *                                Chat + first user message with the image
 *                                attached, returns `{chatId, redirectUrl}`.
 *
 * Why a dedicated route instead of reusing /api/files/upload:
 *   - The extension can't carry the CSRF double-submit cookie cleanly across
 *     origins, so we want a bearer-only surface that we can rate-limit and
 *     audit separately.
 *   - The capture loop wants atomic "image → chat" semantics: the extension
 *     hits ONE endpoint and gets back a URL to redirect the user to. Doing
 *     this as upload → create-chat → attach-message would mean three round
 *     trips through the extension, each of which could fail orphaning state.
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { authenticateToken } = require('../middleware/auth');
const auditLog = require('../services/agents/audit-log');

const router = express.Router();

// Lazy-require prisma so the unit test can stub it out cleanly. Path mirrors
// every other route in this codebase — see backend/index.js line ~282.
function getPrisma() {
  return require('../config/database');
}

// Mirror the upload-dir convention used by middleware/upload.js so a capture
// lands in the same place a normal /api/files/upload would. That way the
// existing /uploads static handler (with JWT-in-query support) serves it
// without any new wiring.
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 10 MB hard cap on captures. A full 4K screenshot encoded as PNG is ~6-8 MB;
// this leaves headroom without letting a bad client try to upload a video.
const CAPTURE_MAX_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CAPTURE_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'image/png' && file.mimetype !== 'image/jpeg') {
      return cb(new Error('Only image/png or image/jpeg accepted'));
    }
    cb(null, true);
  },
});

// ─────────────────────────────────────────────────────────────
// POST /api/appshots/pair
// ─────────────────────────────────────────────────────────────
router.post('/pair', authenticateToken, async (req, res) => {
  try {
    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: 'JWT_SECRET not configured' });
    }
    const prisma = getPrisma();

    // 1-year token. Extension can refresh by re-pairing if it expires.
    const ttlMs = 365 * 24 * 60 * 60 * 1000;
    const token = jwt.sign(
      {
        userId: req.user.id,
        scope: 'appshots:capture',
        nonce: crypto.randomBytes(8).toString('hex'),
      },
      process.env.JWT_SECRET,
      { expiresIn: '365d' },
    );

    await prisma.session.create({
      data: {
        userId: req.user.id,
        token,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });

    auditLog.audit({
      event: 'appshots_paired',
      userId: req.user.id,
      tokenPrefix: token.slice(0, 12),
    });

    res.status(201).json({
      token,
      expiresInDays: 365,
      // The extension expects this exact shape; if you change keys you must
      // also update extension/popup.js / extension/background.js together.
      apiBaseUrl: getCanonicalApiBaseUrl(req),
    });
  } catch (error) {
    console.error('[appshots] pair error:', error?.message || error);
    res.status(500).json({ error: 'Pairing failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/appshots/capture
// ─────────────────────────────────────────────────────────────
/**
 * requireAppshotsScope — hard-enforces the bearer+scope contract documented
 * at the top of this file. We need this BEFORE authenticateToken so a stray
 * cookie session can't slip through the CSRF-exempt door, and AGAIN after
 * (implicit, via the JWT we re-verify) so only tokens minted by /pair work.
 *
 * Rejected explicitly (with audit-log breadcrumb):
 *   - cookie-only auth (no Authorization header)
 *   - Authorization scheme that isn't "Bearer"
 *   - `sk_…` API keys (we never issue scoped API keys for appshots)
 *   - JWTs without `scope === 'appshots:capture'`
 *
 * Note: we re-verify the JWT here rather than reading req.user, because
 * authenticateToken intentionally hides the decoded payload. Re-verifying
 * is cheap (HMAC SHA256) and gives us the scope claim we need.
 */
function requireAppshotsScope(req, res, next) {
  const auth = req.headers && req.headers.authorization;
  if (!auth || typeof auth !== 'string') {
    return res.status(401).json({ error: 'Bearer token required', code: 'no_bearer' });
  }
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (!m) {
    return res.status(401).json({ error: 'Bearer token required', code: 'bad_scheme' });
  }
  const token = m[1];
  if (token.startsWith('sk_')) {
    return res.status(403).json({ error: 'API keys not allowed on appshots', code: 'api_key_blocked' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded?.scope !== 'appshots:capture') {
      auditLog.audit({
        event: 'appshots_capture_rejected',
        reason: 'scope_mismatch',
        scope: decoded?.scope || null,
        userId: decoded?.userId || null,
      });
      return res.status(403).json({ error: 'token scope mismatch', code: 'scope_required' });
    }
    req._appshotsTokenScope = decoded.scope;
    // Opt this route in to the scope gate inside authenticateToken — without
    // this flag the next middleware would reject the scoped token globally.
    req._allowScopedToken = 'appshots:capture';
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token', code: 'jwt_invalid' });
  }
}

router.post(
  '/capture',
  requireAppshotsScope,
  authenticateToken,
  upload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'image file is required' });
      }
      const prisma = getPrisma();
      const userId = req.user.id;

      // Per-user subdir keeps captures isolated and matches the layout the
      // existing upload-static-access middleware authorises.
      const userDir = path.join(UPLOAD_DIR, userId);
      if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

      const ext = req.file.mimetype === 'image/jpeg' ? 'jpg' : 'png';
      const filename = `appshot-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
      const diskPath = path.join(userDir, filename);
      fs.writeFileSync(diskPath, req.file.buffer);

      const sourceLabel = sanitiseLabel(req.body?.source) || 'Captura';
      const noteText = sanitiseNote(req.body?.note);
      const model = sanitiseModel(req.body?.model) || 'gpt-4o-mini';

      const fileRecord = await prisma.file.create({
        data: {
          userId,
          filename,
          originalName: `${sourceLabel}.${ext}`,
          mimeType: req.file.mimetype,
          size: req.file.size,
          path: diskPath,
          processingStage: 'ready',
          processingStageAt: new Date(),
        },
      });

      const chat = await prisma.chat.create({
        data: {
          userId,
          title: truncate(`Appshot · ${sourceLabel}`, 80),
          model,
        },
      });

      // First user message carries the file reference in the existing JSON
      // `files` column so the chat UI renders the attachment chip natively.
      const messageContent = noteText
        ? noteText
        : `He capturado ${sourceLabel}. ¿Puedes analizarla?`;

      await prisma.message.create({
        data: {
          chatId: chat.id,
          role: 'user',
          content: messageContent,
          files: [
            {
              id: fileRecord.id,
              name: fileRecord.originalName,
              size: fileRecord.size,
              type: fileRecord.mimeType,
              url: `/uploads/${userId}/${filename}`,
            },
          ],
          metadata: { source: 'appshots', sourceLabel },
        },
      });

      auditLog.audit({
        event: 'appshots_capture',
        userId,
        chatId: chat.id,
        fileId: fileRecord.id,
        bytes: req.file.size,
        mimeType: req.file.mimetype,
        sourceLabel,
      });

      const frontendBase = getCanonicalFrontendBaseUrl(req);
      return res.status(201).json({
        chatId: chat.id,
        fileId: fileRecord.id,
        redirectUrl: `${frontendBase}/c/${chat.id}`,
      });
    } catch (error) {
      console.error('[appshots] capture error:', error?.message || error);
      // Multer file-too-large surfaces as MulterError with code LIMIT_FILE_SIZE.
      if (error?.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'image exceeds 10 MB limit' });
      }
      res.status(500).json({ error: 'Capture failed' });
    }
  },
);

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

function sanitiseLabel(raw) {
  if (typeof raw !== 'string') return null;
  // Strip control chars, collapse whitespace, cap to 80 — protects against
  // someone passing a 10 KB "source" string that would bloat the chat title.
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 80) || null;
}

function sanitiseNote(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  return cleaned.slice(0, 2000) || null;
}

function sanitiseModel(raw) {
  if (typeof raw !== 'string') return null;
  // Whitelist-by-pattern: only allow short alnum/dash/dot strings so an
  // attacker can't smuggle a path or prompt-injection payload through.
  return /^[a-zA-Z0-9._-]{1,40}$/.test(raw) ? raw : null;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function getCanonicalApiBaseUrl(req) {
  // Prefer the explicit env override so a dev tunnel doesn't leak into
  // production. Falls back to whatever host the request came in on.
  const override = process.env.APPSHOTS_API_BASE_URL || process.env.NEXT_PUBLIC_API_URL;
  if (override) return override.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function getCanonicalFrontendBaseUrl(req) {
  const override = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (override) return override.replace(/\/+$/, '');
  // Fall back to api host (works in dev where frontend + backend share host
  // through the Next.js proxy).
  return getCanonicalApiBaseUrl(req);
}

module.exports = router;
module.exports._private = { sanitiseLabel, sanitiseNote, sanitiseModel, truncate };
