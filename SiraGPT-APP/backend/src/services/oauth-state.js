const {
  createOAuthStateCodec,
  createOAuthStateStore,
} = require('./auth/oauth-state-store');

let defaultStore = createOAuthStateStore({ env: process.env });
const scopedStores = new Map();

function storeFor(env, explicitStore) {
  if (explicitStore) return explicitStore;
  if (env === process.env) return defaultStore;
  const key = JSON.stringify({
    nodeEnv: env.NODE_ENV || '',
    redisUrl: env.REDIS_URL || '',
    prefix: env.OAUTH_STATE_REDIS_PREFIX || '',
    maxEntries: env.OAUTH_STATE_CACHE_MAX_ENTRIES || '',
  });
  if (!scopedStores.has(key)) {
    scopedStores.set(key, createOAuthStateStore({ env }));
  }
  return scopedStores.get(key);
}

function codecFor(env, store) {
  return createOAuthStateCodec({ env, store: storeFor(env, store) });
}

async function signOAuthState(payload, env = process.env, options = {}) {
  return codecFor(env, options.store).issue(payload);
}

async function verifyOAuthState(rawState, expected, env = process.env, options = {}) {
  return codecFor(env, options.store).consume(rawState, expected);
}

function oauthStateHealth() {
  return defaultStore.health();
}

function oauthStateConfig() {
  return defaultStore.config();
}

function readyOAuthStateStore() {
  return defaultStore.ready();
}

async function closeOAuthStateStore() {
  await defaultStore.close();
}

/** Replace the singleton with an empty local store for isolated unit tests. */
function _testOnly_clearUsedJtis() {
  const previous = defaultStore;
  defaultStore = createOAuthStateStore({
    env: { ...process.env, NODE_ENV: 'test', REDIS_URL: '' },
  });
  void previous.close();
  for (const store of scopedStores.values()) void store.close();
  scopedStores.clear();
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
  closeOAuthStateStore,
  signOAuthState,
  verifyOAuthState,
  oauthStateConfig,
  oauthStateHealth,
  readyOAuthStateStore,
  frontendOrigin,
  popupResponseHtml,
  _testOnly_clearUsedJtis,
};
