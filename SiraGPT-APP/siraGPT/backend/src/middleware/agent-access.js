/**
 * agent-access middleware — accepts either the existing JWT auth
 * (via authenticateToken) OR a sira_ag_ agent API key with the
 * pairing model.
 *
 * Mount order in /api/agent/run:
 *   authenticateAgent  → if a Bearer token is a sira_ag_ key, it
 *                        authenticates here; req.user is populated
 *                        from the key's owner. Otherwise we fall
 *                        through and authenticateToken runs next.
 *
 * The middleware also annotates req.agentKey = { id, scope } when
 * the request was authenticated via API key, so the route handler
 * can override the session policy with the key's scope rather than
 * accepting arbitrary body overrides from the caller.
 */

const { authenticateToken } = require('./auth');
const keys = require('../services/agent-access/keys');

function ipOf(req) {
  // Express sets trust proxy = 1 in index.js, so req.ip is the real
  // client IP from X-Forwarded-For. Fallback to socket address.
  return req.ip || req.socket?.remoteAddress || '';
}

function userAgentOf(req) {
  return String(req.get('user-agent') || '').slice(0, 200);
}

function authenticateAgent(req, res, next) {
  const authHeader = req.get('authorization') || '';
  // Only intercept if the bearer token looks like an agent key.
  // Anything else (JWT, legacy auth) falls through untouched.
  if (!/^Bearer\s+sira_ag_/i.test(authHeader)) {
    return authenticateToken(req, res, next);
  }

  const result = keys.authenticate({
    authHeader,
    ip: ipOf(req),
    userAgent: userAgentOf(req),
  });

  if (!result) {
    // Bearer header looked agent-key-ish but didn't parse. Send a
    // deterministic 401 rather than falling through to JWT which
    // would just 401 with a different message.
    return res.status(401).json({ error: 'malformed agent key' });
  }

  switch (result.code) {
    case 'ok':
      req.user = { id: result.row.userId, authMethod: 'agent_key' };
      req.agentKey = {
        id: result.row.id,
        label: result.row.label,
        scope: result.row.scope,
        paired: true,
        principalHash: result.principalHash,
      };
      return next();

    case 'pair_required':
      return res.status(428).json({
        error: 'pairing_required',
        pairingCode: result.pendingCode,
        message:
          `This principal has not been approved for this key. ` +
          `Ask the key owner to approve pair code "${result.pendingCode}" ` +
          `by POSTing /api/agent/keys/${result.row.id}/pair/${result.pendingCode} with their JWT.`,
      });

    case 'revoked':
      return res.status(401).json({ error: 'key revoked' });
    case 'closed':
      return res.status(403).json({ error: 'agent API keys are disabled (AGENT_DM_POLICY=closed)' });
    case 'unknown_key':
    case 'bad_secret':
    default:
      return res.status(401).json({ error: 'invalid agent key' });
  }
}

module.exports = { authenticateAgent, ipOf, userAgentOf };
