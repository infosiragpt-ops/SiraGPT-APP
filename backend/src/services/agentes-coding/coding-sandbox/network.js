'use strict';

/**
 * Deny-by-default egress policy for coding-sandbox sessions.
 *
 * Empty allowlist ⇒ Docker `--network none`. A non-empty allowlist only
 * attaches the isolated compose network (`siragpt-coding-sandbox`, internal).
 * A caller-supplied hook may approve a host or exposePort; it cannot select
 * `host` or `bridge` (those would leak the control-plane network).
 */

const { fail } = require('./errors');
const { parsePortAllowlist } = require('../preview/ports');

const FORBIDDEN_DOCKER_NETWORKS = new Set(['host', 'bridge']);
const DEFAULT_COMPOSE_NETWORK = 'siragpt-coding-sandbox';

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

function hostMatches(rule, host) {
  const r = normalizeHost(rule);
  const h = normalizeHost(host);
  if (!r || !h) return false;
  if (r === h) return true;
  if (r.startsWith('*.') && (h === r.slice(2) || h.endsWith(`.${r.slice(2)}`))) return true;
  return false;
}

function createNetworkPolicy(opts = {}) {
  const allowlist = Array.isArray(opts.allowlist)
    ? opts.allowlist.map(normalizeHost).filter(Boolean)
    : [];
  const portAllowlist = parsePortAllowlist(opts.portAllowlist || opts.previewPorts);
  const hook = typeof opts.hook === 'function' ? opts.hook : null;
  const composeNetwork = String(opts.composeNetwork || DEFAULT_COMPOSE_NETWORK).trim()
    || DEFAULT_COMPOSE_NETWORK;

  function decide(request) {
    const req = request && typeof request === 'object' ? request : { host: request };
    if (hook) {
      const verdict = hook({
        action: req.action || 'connect',
        host: req.host || null,
        port: req.port || null,
        allowlist: [...allowlist],
      });
      if (verdict === true) return { allowed: true, dockerNetwork: null };
      if (verdict && typeof verdict === 'object') {
        const dockerNetwork = verdict.dockerNetwork != null
          ? String(verdict.dockerNetwork).trim()
          : null;
        if (dockerNetwork && FORBIDDEN_DOCKER_NETWORKS.has(dockerNetwork)) {
          fail('E_NETWORK_DENIED', 'No se permite la red host/bridge.');
        }
        if (verdict.allowed === false) return { allowed: false, dockerNetwork: null };
        if (verdict.allowed === true || dockerNetwork) {
          return { allowed: true, dockerNetwork };
        }
      }
      if (verdict === false) return { allowed: false, dockerNetwork: null };
    }
    if (req.action === 'exposePort') {
      const n = Number.parseInt(req.port, 10);
      if (Number.isFinite(n) && portAllowlist.includes(n)) {
        return { allowed: true, dockerNetwork: null };
      }
      return { allowed: false, dockerNetwork: null };
    }
    if (req.host && allowlist.some((rule) => hostMatches(rule, req.host))) {
      return { allowed: true, dockerNetwork: null };
    }
    return { allowed: false, dockerNetwork: null };
  }

  function allows(request) {
    return decide(request).allowed === true;
  }

  function dockerNetworkName() {
    return allowlist.length > 0 ? composeNetwork : 'none';
  }

  function dockerNetworkArgs() {
    return ['--network', dockerNetworkName()];
  }

  return Object.freeze({
    mode: allowlist.length > 0 || portAllowlist.length > 0 ? 'allowlist' : 'deny',
    allowlist: Object.freeze([...allowlist]),
    portAllowlist: Object.freeze([...portAllowlist]),
    composeNetwork,
    decide,
    allows,
    dockerNetworkName,
    dockerNetworkArgs,
  });
}

module.exports = {
  FORBIDDEN_DOCKER_NETWORKS,
  DEFAULT_COMPOSE_NETWORK,
  createNetworkPolicy,
  hostMatches,
  normalizeHost,
};
