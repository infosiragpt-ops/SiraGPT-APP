const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const STATE_TYPE = 'oauth_state';
const DEFAULT_EXPIRES_IN = '10m';

function getSecret(env = process.env) {
  const secret = env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required for OAuth state');
  return secret;
}

/**
 * Single-use JTI store: maps jti → expiry timestamp (ms).
 * Entries are pruned lazily on each verify call so the map stays bounded.
 * Exported for test-only reset between test suites.
 */
const _usedJtis = new Map();

function _pruneExpiredJtis() {
  const now = Date.now();
  for (const [jti, exp] of _usedJtis) {
    if (exp <= now) _usedJtis.delete(jti);
  }
}

/** Reset the JTI store — only for use in tests. */
function _testOnly_clearUsedJtis() {
  _usedJtis.clear();
}

function signOAuthState({ userId, service }, env = process.env) {
  if (!userId || !service) throw new Error('userId and service are required for OAuth state');
  return jwt.sign(
    {
      typ: STATE_TYPE,
      userId: String(userId),
      service: String(service),
      jti: crypto.randomUUID(),
    },
    getSecret(env),
    { expiresIn: env.OAUTH_STATE_TTL || DEFAULT_EXPIRES_IN },
  );
}

function verifyOAuthState(rawState, { service }, env = process.env) {
  if (!rawState || !service) throw new Error('OAuth state is required');
  const decoded = jwt.verify(String(rawState), getSecret(env));
  if (!decoded || decoded.typ !== STATE_TYPE || decoded.service !== service || !decoded.userId) {
    throw new Error('Invalid OAuth state');
  }

  const { jti } = decoded;
  if (!jti) throw new Error('Invalid OAuth state: missing nonce');

  _pruneExpiredJtis();
  if (_usedJtis.has(jti)) throw new Error('OAuth state token has already been used');

  const expiresAt = decoded.exp ? decoded.exp * 1000 : Date.now() + 10 * 60 * 1000;
  _usedJtis.set(jti, expiresAt);

  return { userId: String(decoded.userId), service: decoded.service };
}

function frontendOrigin(env = process.env) {
  const raw = env.FRONTEND_URL || env.PUBLIC_FRONTEND_URL || 'http://localhost:3000';
  try {
    return new URL(raw).origin;
  } catch (_err) {
    return 'http://localhost:3000';
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function popupResponseHtml({ service, status, error, message }, env = process.env) {
  const origin = frontendOrigin(env);
  const payload = {
    status,
    service,
    ...(error ? { error } : {}),
  };
  const safeMessage = message || (status === 'success'
    ? 'Authentication successful. This window will now close.'
    : 'Authentication failed. This window will now close.');

  return `<!DOCTYPE html>
<html>
<head><title>${status === 'success' ? 'Authentication Success' : 'Authentication Failed'}</title></head>
<body>
  <script>
    if (window.opener) {
      window.opener.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(origin)});
    }
    window.close();
  </script>
  <p>${escapeHtml(safeMessage)}</p>
</body>
</html>`;
}

module.exports = {
  signOAuthState,
  verifyOAuthState,
  frontendOrigin,
  popupResponseHtml,
  _testOnly_clearUsedJtis,
};
