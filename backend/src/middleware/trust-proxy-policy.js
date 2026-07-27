'use strict';

const net = require('node:net');

const MAX_TRUSTED_HOPS = 10;

function invalidPolicyError() {
  const error = new Error(
    'TRUST_PROXY_HOPS and TRUST_PROXY_CIDR must define one valid proxy topology.',
  );
  error.code = 'TRUST_PROXY_POLICY_INVALID';
  return error;
}

function parseTrustedCidrs(raw) {
  const entries = String(raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) throw invalidPolicyError();

  for (const entry of entries) {
    const parts = entry.split('/');
    if (parts.length !== 2) throw invalidPolicyError();
    const [address, prefixText] = parts;
    const version = net.isIP(address);
    const prefix = Number(prefixText);
    const maxPrefix = version === 4 ? 32 : version === 6 ? 128 : -1;
    if (
      maxPrefix < 0
      || !Number.isInteger(prefix)
      || prefix < 0
      || prefix > maxPrefix
    ) {
      throw invalidPolicyError();
    }
  }
  return [...new Set(entries)];
}

function resolveTrustProxyPolicy(env = process.env) {
  const hopsRaw = String(env.TRUST_PROXY_HOPS || '').trim();
  const cidrRaw = String(env.TRUST_PROXY_CIDR || '').trim();
  if (hopsRaw && cidrRaw) throw invalidPolicyError();

  if (cidrRaw) {
    return {
      mode: 'cidr',
      value: parseTrustedCidrs(cidrRaw),
    };
  }

  if (!hopsRaw || hopsRaw === '0') {
    return { mode: 'none', value: false };
  }
  const hops = Number(hopsRaw);
  if (!Number.isInteger(hops) || hops < 0 || hops > MAX_TRUSTED_HOPS) {
    throw invalidPolicyError();
  }
  return {
    mode: 'hops',
    value: hops,
  };
}

module.exports = {
  MAX_TRUSTED_HOPS,
  parseTrustedCidrs,
  resolveTrustProxyPolicy,
};
