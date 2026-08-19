const jwt = require('jsonwebtoken');

const STATE_TYPE = 'oauth_state';
const DEFAULT_EXPIRES_IN = '10m';

function getSecret(env = process.env) {
  const secret = env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required for OAuth state');
  return secret;
}

function signOAuthState({ userId, service }, env = process.env) {
  if (!userId || !service) throw new Error('userId and service are required for OAuth state');
  return jwt.sign(
    { typ: STATE_TYPE, userId: String(userId), service: String(service) },
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
};
