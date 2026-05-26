'use strict';

/**
 * document-network-ports.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects network port references with service classification:
 *
 *   - labeled:  "port 22", "port: 5432", "TCP/443", "UDP/53"
 *   - in URL:   host:8080
 *   - listing:  "listening on :3000", "bind :443"
 *
 * Well-known port classification: ssh, http, https, postgres, mysql, redis, …
 *
 * Public API:
 *   extractNetworkPorts(text)             → { entries, totals, total }
 *   buildNetworkPortsForFiles(files)      → { perFile, aggregate, totals }
 *   renderNetworkPortsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const WELL_KNOWN = {
  20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp',
  53: 'dns', 67: 'dhcp', 68: 'dhcp', 69: 'tftp', 80: 'http',
  110: 'pop3', 111: 'rpc', 119: 'nntp', 123: 'ntp', 143: 'imap',
  161: 'snmp', 162: 'snmp', 179: 'bgp', 194: 'irc', 389: 'ldap',
  443: 'https', 445: 'smb', 465: 'smtps', 514: 'syslog', 515: 'lpr',
  587: 'submission', 636: 'ldaps', 873: 'rsync', 989: 'ftps-data', 990: 'ftps',
  993: 'imaps', 995: 'pop3s', 1080: 'socks', 1194: 'openvpn',
  1433: 'mssql', 1521: 'oracle', 1701: 'l2tp', 1723: 'pptp',
  2049: 'nfs', 2375: 'docker', 2376: 'docker-tls', 2379: 'etcd', 2380: 'etcd-peer',
  3000: 'dev-server', 3001: 'dev-server', 3128: 'squid',
  3306: 'mysql', 3389: 'rdp', 3478: 'turn-stun',
  4222: 'nats', 4369: 'epmd', 5000: 'dev-server', 5060: 'sip',
  5432: 'postgres', 5601: 'kibana', 5672: 'amqp', 5701: 'hazelcast',
  5984: 'couchdb', 6379: 'redis', 6443: 'k8s-api', 6667: 'irc',
  7000: 'cassandra', 8000: 'dev-server', 8025: 'mailhog',
  8080: 'http-alt', 8086: 'influxdb', 8087: 'riak', 8088: 'http-alt',
  8200: 'vault', 8300: 'consul', 8443: 'https-alt', 8500: 'consul',
  8888: 'jupyter', 9000: 'php-fpm', 9042: 'cassandra', 9092: 'kafka',
  9200: 'elasticsearch', 9300: 'elasticsearch-cluster', 9418: 'git',
  9999: 'jmx', 11211: 'memcached', 15672: 'rabbitmq-mgmt',
  19092: 'kafka-tls', 25565: 'minecraft', 27017: 'mongodb',
};

const PORT_LABEL_RE = /\bport\s*[:=#]?\s*(\d{1,5})\b/gi;
const TCP_UDP_RE = /\b(TCP|UDP)\s*\/\s*(\d{1,5})\b/g;
const LISTEN_RE = /\b(?:listening\s+(?:on|to)|bind|bound)\s*[:=]?\s*(?::|0\.0\.0\.0:|127\.0\.0\.1:|localhost:)?(\d{2,5})\b/gi;
const HOST_COLON_RE = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g;

function classifyPort(n) {
  if (WELL_KNOWN[n]) return WELL_KNOWN[n];
  if (n < 1024) return 'reserved';
  if (n < 49152) return 'registered';
  return 'ephemeral';
}

function extractNetworkPorts(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  function push(port, proto, source) {
    const n = parseInt(port, 10);
    if (isNaN(n) || n < 1 || n > 65535) return;
    const service = classifyPort(n);
    const key = `${n}:${proto || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ port: n, proto: proto || null, service, source });
    totals[service] = (totals[service] || 0) + 1;
  }

  PORT_LABEL_RE.lastIndex = 0;
  let m;
  while ((m = PORT_LABEL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push(m[1], null, 'labeled');
  }
  if (entries.length < MAX_PER_FILE) {
    TCP_UDP_RE.lastIndex = 0;
    while ((m = TCP_UDP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[2], m[1], 'proto-slash');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    LISTEN_RE.lastIndex = 0;
    while ((m = LISTEN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], null, 'listening');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    HOST_COLON_RE.lastIndex = 0;
    while ((m = HOST_COLON_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], null, 'host-colon');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildNetworkPortsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractNetworkPorts(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.port}:${e.proto || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      totals[e.service] = (totals[e.service] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderNetworkPortsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## NETWORK PORTS'];
  const t = report.totals || {};
  const parts = Object.entries(t).sort(([, a], [, b]) => b - a).slice(0, 10).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Top: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      const proto = e.proto ? `${e.proto}/` : '';
      lines.push(`- ${proto}${e.port} (${e.service}, ${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractNetworkPorts,
  buildNetworkPortsForFiles,
  renderNetworkPortsBlock,
  _internal: { classifyPort, WELL_KNOWN },
};
