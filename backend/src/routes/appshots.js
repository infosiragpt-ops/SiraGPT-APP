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
const aiService = require('../services/ai-service');
const emailService = require('../services/email');
const { extractIp, extractUa, reduceIp } = require('../utils/session-fingerprint');
const { resolveGeoHint } = require('../utils/geo-lookup');

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

    // Task 15: capture User-Agent + IP-class hint at pair time so the
    // settings UI can distinguish multiple linked devices. UA is truncated
    // to 512 chars to keep row width bounded; ipHint is the /24 (IPv4) or
    // /64 (IPv6) prefix from reduceIp — never the full address.
    const rawUa = extractUa(req);
    const userAgent = rawUa ? String(rawUa).slice(0, 512) : null;
    const rawIp = extractIp(req);
    const ipHint = rawIp ? reduceIp(rawIp) || null : null;

    // Task 19 — resolve the caller's IP to a short "City, CC" label so the
    // settings UI can show "Chrome en macOS · Madrid, ES" instead of just
    // the /24 prefix. Best-effort with a hard timeout in resolveGeoHint;
    // any failure leaves geoHint null and the UI falls back to ipHint.
    let geoHint = null;
    try {
      geoHint = await resolveGeoHint(rawIp);
    } catch (err) {
      console.warn('[appshots] geo lookup failed, degrading silently:', err?.message || err);
    }

    await prisma.session.create({
      data: {
        userId: req.user.id,
        token,
        expiresAt: new Date(Date.now() + ttlMs),
        userAgent,
        ipHint,
        geoHint,
      },
    });

    auditLog.audit({
      event: 'appshots_paired',
      userId: req.user.id,
      tokenPrefix: token.slice(0, 12),
      userAgent,
      ipHint,
      geoHint,
    });

    // Security notification (Task 14): warn the user out-of-band that a new
    // device was paired. Fire-and-forget — a failing/unconfigured SMTP must
    // never block the pairing flow itself.
    if (req.user?.email) {
      Promise.resolve(
        emailService.sendAppshotsDeviceLinked(req.user, {
          ip: getClientIp(req),
          when: new Date(),
        }),
      ).catch((err) => {
        console.warn('[appshots] device-linked email failed:', err?.message || err);
      });
    }

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
// GET /api/appshots/sessions
// DELETE /api/appshots/sessions/:id
// ─────────────────────────────────────────────────────────────
/**
 * List active Appshots sessions for the caller. We don't store the JWT
 * scope as a column, so we filter by decoding each session's token and
 * keeping only those with `scope === 'appshots:capture'`. The token
 * itself is never returned — only metadata the user needs to recognise
 * and revoke a stale device.
 */
router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const rows = await prisma.session.findMany({
      where: { userId: req.user.id },
      select: {
        id: true,
        token: true,
        createdAt: true,
        expiresAt: true,
        lastUsedAt: true,
        userAgent: true,
        ipHint: true,
        geoHint: true,
        label: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Task 20: marca la sesión que corresponde al navegador desde el que
    // se está consultando la página, para que el usuario no revoque sin
    // querer la que está usando ahora. Comparamos contra el mismo par
    // (User-Agent normalizado + ipHint /24-/64) que guardamos al vincular.
    const currentRawUa = extractUa(req);
    const currentUaNorm = currentRawUa
      ? String(currentRawUa).slice(0, 512).trim().toLowerCase()
      : '';
    const currentRawIp = extractIp(req);
    const currentIpHint = currentRawIp ? reduceIp(currentRawIp) || null : null;

    const sessions = rows
      .filter((row) => isAppshotsToken(row.token))
      .map((row) => {
        const rowUaNorm = row.userAgent ? String(row.userAgent).trim().toLowerCase() : '';
        // Sólo consideramos "este dispositivo" cuando ambos datos
        // coinciden Y los dos no son vacíos — un UA o ipHint vacío en
        // la fila no debería marcar todas las sesiones huérfanas como
        // actuales. ipHint puede ser null en sesiones antiguas; en ese
        // caso exigimos también que el actual sea null para evitar
        // falsos positivos.
        const uaMatches = !!rowUaNorm && !!currentUaNorm && rowUaNorm === currentUaNorm;
        const ipMatches = (row.ipHint || null) === (currentIpHint || null);
        const isCurrent = uaMatches && ipMatches;
        return {
          id: row.id,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          lastUsedAt: row.lastUsedAt,
          label: row.label || null,
          userAgent: row.userAgent || null,
          ipHint: row.ipHint || null,
          // Task 19 — pre-resolved "City, CC" hint. Null when the lookup
          // failed at pair time or the row predates the migration; the UI
          // then falls back to ipHint.
          geoHint: row.geoHint || null,
          // Pre-computed friendly device string ("Chrome en macOS") so the UI
          // doesn't need to ship a UA parser. Falls back to null when we
          // can't recognise the UA — clients then render the raw string.
          device: row.userAgent ? describeUserAgent(row.userAgent) : null,
          isCurrent,
        };
      });

    // Si varias filas coinciden (p. ej. el usuario vinculó dos veces
    // desde el mismo navegador y red), nos quedamos sólo con la más
    // reciente como "actual" para que la UI sólo muestre un badge.
    const firstCurrent = sessions.find((s) => s.isCurrent);
    if (firstCurrent) {
      for (const s of sessions) {
        if (s !== firstCurrent) s.isCurrent = false;
      }
    }


    res.json({ sessions });
  } catch (error) {
    console.error('[appshots] list sessions error:', error?.message || error);
    res.status(500).json({ error: 'Could not list sessions' });
  }
});

/**
 * PATCH /api/appshots/sessions/:id — rename a linked device.
 *
 * Body: { label: string|null }. Pass null/empty to clear. We cap to 80 chars
 * after sanitisation so a malicious client can't bloat the row. Only the
 * owner can rename, and only appshots-scoped sessions are accepted.
 */
router.patch('/sessions/:id', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'session id required' });

    const raw = req.body?.label;
    let label = null;
    if (raw !== null && raw !== undefined) {
      label = sanitiseLabel(raw);
      if (label === null && String(raw).trim() !== '') {
        // sanitiseLabel returned null because the string was empty after
        // stripping; treat as "clear" rather than rejecting.
        label = null;
      }
    }

    const row = await prisma.session.findUnique({
      where: { id },
      select: { id: true, userId: true, token: true },
    });
    if (!row || row.userId !== req.user.id) {
      return res.status(404).json({ error: 'session not found' });
    }
    if (!isAppshotsToken(row.token)) {
      return res.status(403).json({ error: 'not an appshots session' });
    }
    await prisma.session.update({ where: { id }, data: { label } });
    auditLog.audit({
      event: 'appshots_session_renamed',
      userId: req.user.id,
      sessionId: id,
      hasLabel: Boolean(label),
    });
    res.json({ ok: true, label });
  } catch (error) {
    console.error('[appshots] rename session error:', error?.message || error);
    res.status(500).json({ error: 'Rename failed' });
  }
});

router.delete('/sessions/:id', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'session id required' });

    // Scope the delete to BOTH the caller and the appshots scope so a
    // compromised cookie can't be used to log every browser tab out.
    const row = await prisma.session.findUnique({
      where: { id },
      select: { id: true, userId: true, token: true },
    });
    if (!row || row.userId !== req.user.id) {
      return res.status(404).json({ error: 'session not found' });
    }
    if (!isAppshotsToken(row.token)) {
      return res.status(403).json({ error: 'not an appshots session' });
    }
    await prisma.session.delete({ where: { id } });
    auditLog.audit({
      event: 'appshots_revoked',
      userId: req.user.id,
      sessionId: id,
    });

    // Security notification (Task 14): confirm the revocation by email so
    // the user notices if someone else triggered it. Fire-and-forget.
    if (req.user?.email) {
      Promise.resolve(
        emailService.sendAppshotsDeviceRevoked(req.user, { when: new Date() }),
      ).catch((err) => {
        console.warn('[appshots] device-revoked email failed:', err?.message || err);
      });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('[appshots] revoke session error:', error?.message || error);
    res.status(500).json({ error: 'Revoke failed' });
  }
});

function isAppshotsToken(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded?.scope === 'appshots:capture';
  } catch (_) {
    return false;
  }
}

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

      // OCR: extrae el texto visible de la captura con Gemini Vision para que
      // el pipeline de chat existente lo inyecte como contexto vía
      // `File.extractedText`. La extensión envía `ocr=1` por defecto; lo
      // tratamos como activado salvo que se pase explícitamente "0"/"false".
      // Degradación silenciosa: si Gemini falla, la captura sigue adelante
      // sin texto extraído y se loguea un warning.
      const ocrFlag = pickOcrFlag(req.query?.ocr, req.body?.ocr);
      let extractedText = null;
      if (ocrFlag) {
        try {
          const description = await aiService.describeImagesWithGemini(
            [{ path: diskPath, mimeType: req.file.mimetype, name: filename }],
            `Captura enviada por Appshots (${sourceLabel}).`,
          );
          if (description && description.trim().length > 0) {
            extractedText = description.trim().slice(0, 200000);
          } else {
            console.warn('[appshots] OCR Gemini devolvió texto vacío; se guarda sin extractedText');
          }
        } catch (err) {
          console.warn('[appshots] OCR Gemini falló, degradando silenciosamente:', err?.message || err);
        }
      }

      const fileRecord = await prisma.file.create({
        data: {
          userId,
          filename,
          originalName: `${sourceLabel}.${ext}`,
          mimeType: req.file.mimetype,
          size: req.file.size,
          path: diskPath,
          extractedText,
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
        ocr: ocrFlag,
        ocrChars: extractedText ? extractedText.length : 0,
      });

      // Bump lastUsedAt so the settings UI can show "last seen" and the
      // user can confidently revoke abandoned tokens. Best-effort: if
      // req.userSession is missing (e.g. test stub) we silently skip.
      if (req.userSession?.id) {
        prisma.session
          .update({ where: { id: req.userSession.id }, data: { lastUsedAt: new Date() } })
          .catch(() => { /* don't fail the capture if the bump fails */ });
      }

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

// Acepta el flag OCR vía query o body. Activado por defecto salvo "0"/"false"/""
// explícitos — la extensión envía `ocr=1`, pero clientes antiguos sin el campo
// también se benefician del OCR.
function pickOcrFlag(...candidates) {
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const v = String(raw).trim().toLowerCase();
    if (v === '' || v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    return true;
  }
  return true;
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

// Best-effort client IP for security-notification emails. We prefer the first
// X-Forwarded-For hop (set by Replit's proxy / typical load balancers) and
// fall back to express's req.ip / the raw socket address. Always sanitised
// before reaching the template via sanitizeHeader.
function getClientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * describeUserAgent — minimal "Chrome en macOS" parser. We do this server-
 * side so the small set of legitimate browsers + OS combinations live in
 * one place and the UI doesn't need to bundle a UA-parser. Returns null
 * when neither browser nor OS could be guessed — the client then falls
 * back to the raw UA string.
 *
 * Order matters: Edge (EdgA / Edg) must be checked before Chrome because
 * its UA contains the Chrome token; Opera (OPR) likewise.
 */
function describeUserAgent(ua) {
  if (typeof ua !== 'string' || !ua) return null;
  const s = ua;

  let browser = null;
  if (/Edg(?:e|A|iOS)?\//i.test(s)) browser = 'Edge';
  else if (/OPR\//i.test(s) || /Opera\//i.test(s)) browser = 'Opera';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/Chrome\//i.test(s) && !/Chromium/i.test(s)) browser = 'Chrome';
  else if (/Chromium\//i.test(s)) browser = 'Chromium';
  else if (/Safari\//i.test(s) && /Version\//i.test(s)) browser = 'Safari';

  let os = null;
  if (/Windows NT/i.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/CrOS/i.test(s)) os = 'ChromeOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  if (browser && os) return `${browser} en ${os}`;
  if (browser) return browser;
  if (os) return os;
  return null;
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
module.exports._private = { sanitiseLabel, sanitiseNote, sanitiseModel, truncate, pickOcrFlag, isAppshotsToken, describeUserAgent };
