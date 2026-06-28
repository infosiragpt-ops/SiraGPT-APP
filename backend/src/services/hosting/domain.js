'use strict';

/**
 * hosting/domain — domain helpers for Hostinger deploys:
 *   - map a domain to its remote document root
 *   - generate DNS setup instructions (nameservers or A-record)
 *   - verify a URL is actually reachable after a deploy
 */

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOSTINGER_NS = ['ns1.dns-parking.com', 'ns2.dns-parking.com'];

/**
 * Remote document root for a domain on Hostinger shared hosting.
 *   main domain      → <baseDir> (usually /public_html)
 *   addon/subdomain  → domains/<domain>/public_html  (relative to the SFTP home)
 */
function remotePathForDomain(domain, { kind = 'main', baseDir = '/public_html' } = {}) {
  const clean = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (kind === 'main' || !clean) return baseDir || '/public_html';
  return `domains/${clean}/public_html`;
}

/** Normalise any user-typed domain/URL to a bare host, and a https URL. */
function normalizeDomain(input) {
  const host = String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return { host, url: host ? `https://${host}` : '' };
}

/**
 * DNS setup steps. Two options: point the registrar to Hostinger nameservers
 * (simplest), or set A records to the server IP. `serverIp` comes from the
 * target host when it's an IP.
 */
function dnsInstructions(target, domain) {
  const host = (target && target.host) || '';
  const serverIp = IPV4_RE.test(host) ? host : null;
  const { host: dom } = normalizeDomain(domain || (target && target.siteUrl) || '');
  return {
    domain: dom,
    nameservers: HOSTINGER_NS,
    aRecords: serverIp
      ? [
          { type: 'A', name: '@', value: serverIp, ttl: 14400 },
          { type: 'A', name: 'www', value: serverIp, ttl: 14400 },
        ]
      : [],
    steps: [
      'Opción A (recomendada): en tu registrador (GoDaddy, etc.) cambia los nameservers a los de Hostinger.',
      `   • ${HOSTINGER_NS.join('\n   • ')}`,
      serverIp
        ? `Opción B: deja los nameservers y crea registros A apuntando @ y www → ${serverIp}.`
        : 'Opción B: crea registros A apuntando @ y www → la IP de tu servidor Hostinger (la encuentras en hPanel).',
      'Los cambios de DNS pueden tardar de minutos a 24h en propagarse.',
      'En hPanel, añade el dominio a tu hosting para que apunte a su carpeta public_html.',
    ],
  };
}

/** Single HTTP attempt; never throws. Surfaces the underlying cause code. */
async function tryFetch(target, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const started = Date.now();
  // SECURITY: this fetches a user-supplied URL — refuse internal/reserved hosts
  // (SSRF) before connecting so the verify check can't probe internal services.
  try {
    await require('./safety').assertSafeUrl(target);
  } catch (e) {
    return { reachable: false, status: 0, ms: Date.now() - started, error: e.message, code: e.code || 'host_blocked', url: target };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(target, { method: 'GET', redirect: 'follow', signal: controller.signal });
    return { reachable: res.status >= 200 && res.status < 500, status: res.status, ms: Date.now() - started, url: target };
  } catch (e) {
    // Node's fetch hides the real reason in e.cause.code (ENOTFOUND, ECONNREFUSED…)
    const code = (e && e.cause && e.cause.code) || (e.name === 'AbortError' ? 'TIMEOUT' : '');
    const reason =
      code === 'ENOTFOUND' ? 'DNS no resuelve (el dominio aún no apunta al servidor o no propagó)'
        : code === 'ECONNREFUSED' ? 'conexión rechazada (no hay servidor escuchando en ese puerto)'
          : code === 'TIMEOUT' ? 'timeout'
            : code === 'CERT_HAS_EXPIRED' || /cert/i.test(String(e.message)) ? 'problema de certificado SSL'
              : e.message || 'fetch failed';
    return { reachable: false, status: 0, ms: Date.now() - started, error: reason, code, url: target };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HTTP-check a URL. Tries it as given; if an https URL fails, retries over
 * http (a freshly-deployed VPS site is often HTTP-only until SSL is added).
 */
async function verifyUrl(url, opts = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//.test(target)) return { reachable: false, status: 0, ms: 0, error: 'URL inválida' };
  const primary = await tryFetch(target, opts);
  if (primary.reachable) return primary;
  if (/^https:/i.test(target)) {
    const overHttp = await tryFetch(target.replace(/^https:/i, 'http:'), opts);
    if (overHttp.reachable) return { ...overHttp, note: 'responde por HTTP (sin SSL todavía)' };
    return { ...primary, error: primary.error, httpError: overHttp.error };
  }
  return primary;
}

module.exports = { remotePathForDomain, normalizeDomain, dnsInstructions, verifyUrl, HOSTINGER_NS };
