'use strict';

/**
 * Chrome DevTools accessibility snapshot for models without vision.
 *
 * Talks to the orchestrator CDP HTTP/WS proxy (/sessions/:id/cdp). Chrome's
 * /json/version returns a localhost webSocketDebuggerUrl; we rewrite it onto
 * the proxy base so DeepSeek can act without image parts.
 *
 * Playwright is optional. Raw CDP (Node 22 WebSocket + Accessibility.getFullAXTree)
 * is the production path.
 */

function loadPlaywright() {
  try { return require('playwright-core'); } catch (_) { /* fall through */ }
  try { return require('playwright'); } catch (_) { return null; }
}

function flattenA11y(node, lines = [], depth = 0) {
  if (!node) return lines;
  const indent = '  '.repeat(Math.min(depth, 16));
  const role = node.role || (node.role && node.role.value) || 'unknown';
  const rawName = node.name && (typeof node.name === 'object' ? node.name.value : node.name);
  const rawValue = node.value && (typeof node.value === 'object' ? node.value.value : node.value);
  const name = rawName ? ` "${String(rawName).slice(0, 120)}"` : '';
  const value = rawValue ? ` = ${String(rawValue).slice(0, 80)}` : '';
  lines.push(`${indent}${role}${name}${value}`);
  for (const child of node.children || []) flattenA11y(child, lines, depth + 1);
  return lines;
}

function flattenAxNodes(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return [];
  const byId = new Map();
  for (const n of nodes) byId.set(String(n.nodeId), n);
  const childIds = new Set();
  for (const n of nodes) {
    for (const id of n.childIds || []) childIds.add(String(id));
  }
  const roots = nodes.filter((n) => !childIds.has(String(n.nodeId)));
  const lines = [];
  const walk = (n, depth) => {
    if (!n) return;
    const indent = '  '.repeat(Math.min(depth, 16));
    const role = (n.role && (n.role.value || n.role)) || 'unknown';
    const name = n.name && (n.name.value || n.name);
    const value = n.value && (n.value.value || n.value);
    const nameBit = name ? ` "${String(name).slice(0, 120)}"` : '';
    const valueBit = value ? ` = ${String(value).slice(0, 80)}` : '';
    lines.push(`${indent}${role}${nameBit}${valueBit}`);
    for (const id of n.childIds || []) walk(byId.get(String(id)), depth + 1);
  };
  for (const root of roots.length ? roots : nodes.slice(0, 1)) walk(root, 0);
  return lines;
}

function rewriteCdpWs(debuggerUrl, cdpHttpBase) {
  const u = new URL(debuggerUrl);
  const base = new URL(cdpHttpBase);
  const prefix = base.pathname.replace(/\/$/, '');
  const proto = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + base.host + prefix + u.pathname + u.search;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || `cdp HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function cdpCall(ws, id, method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      reject(new Error('cdp_timeout ' + method));
    }, 10000);
    function onMsg(ev) {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(msg.error.message || method));
        else resolve(msg.result || {});
      } catch (err) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        reject(err);
      }
    }
    ws.addEventListener('message', onMsg);
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
  });
}

async function snapshotViaRawCdp(cdpUrl, { timeoutMs = 12000 } = {}) {
  const base = String(cdpUrl || '').replace(/\/$/, '');
  if (!base) {
    const err = new Error('cdp url missing');
    err.code = 'NO_CDP_URL';
    throw err;
  }
  let pages = [];
  try {
    const listed = await fetchJson(base + '/json', timeoutMs);
    pages = Array.isArray(listed) ? listed : [];
  } catch (_) {
    pages = [];
  }
  const page = pages.find((p) => p && p.type === 'page' && p.webSocketDebuggerUrl)
    || pages.find((p) => p && p.webSocketDebuggerUrl);
  const version = page ? null : await fetchJson(base + '/json/version', timeoutMs);
  const debuggerUrl = (page && page.webSocketDebuggerUrl) || (version && version.webSocketDebuggerUrl);
  if (!debuggerUrl) return { text: '(no cdp target)', url: null, title: '' };
  const wsUrl = rewriteCdpWs(debuggerUrl, base);
  const WS = global.WebSocket;
  if (!WS) {
    const err = new Error('WebSocket unavailable for CDP');
    err.code = 'NO_WS';
    throw err;
  }
  const ws = new WS(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp_ws_timeout')), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(e.error || new Error('cdp_ws_error')); });
  });
  try {
    let id = 1;
    let tree = null;
    let title = (page && page.title) || '';
    let url = (page && page.url) || null;
    if (page) {
      await cdpCall(ws, id++, 'Accessibility.enable').catch(() => ({}));
      tree = await cdpCall(ws, id++, 'Accessibility.getFullAXTree').catch(() => null);
      if (!title || !url) {
        const ev = await cdpCall(ws, id++, 'Runtime.evaluate', {
          expression: 'JSON.stringify({url: location.href, title: document.title})',
          returnByValue: true,
        }).catch(() => null);
        try {
          const parsed = JSON.parse(ev && ev.result && ev.result.value || '{}');
          url = url || parsed.url || null;
          title = title || parsed.title || '';
        } catch (_) { /* ignore */ }
      }
    } else {
      const targets = await cdpCall(ws, id++, 'Target.getTargets');
      const tlist = (targets && targets.targetInfos) || [];
      const target = tlist.find((t) => t.type === 'page') || tlist[0];
      if (!target) return { text: '(no page)', url: null, title: '' };
      const attached = await cdpCall(ws, id++, 'Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const sessionId = attached && attached.sessionId;
      await cdpCall(ws, id++, 'Accessibility.enable', {}, sessionId).catch(() => ({}));
      tree = await cdpCall(ws, id++, 'Accessibility.getFullAXTree', {}, sessionId).catch(() => null);
      url = target.url || null;
      title = target.title || '';
    }
    const lines = tree && tree.nodes
      ? flattenAxNodes(tree.nodes)
      : flattenA11y(tree);
    return {
      url,
      title,
      text: [`url: ${url || ''}`, `title: ${title || ''}`, ...lines].join('\n').slice(0, 24000),
    };
  } finally {
    try { ws.close(); } catch (_) { /* ignore */ }
  }
}

async function snapshotAccessibility(cdpUrl, {
  playwrightImpl,
  timeoutMs = 12000,
  connect,
} = {}) {
  if (typeof connect === 'function') {
    return connect(cdpUrl);
  }
  try {
    return await snapshotViaRawCdp(cdpUrl, { timeoutMs });
  } catch (rawErr) {
    const pw = playwrightImpl || loadPlaywright();
    if (!pw || !pw.chromium) throw rawErr;
    const browser = await pw.chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs });
    try {
      const contexts = browser.contexts();
      const pages = contexts.flatMap((ctx) => ctx.pages());
      const page = pages[0] || await (contexts[0] && contexts[0].newPage && contexts[0].newPage());
      if (!page) return { text: '(no page)', url: null, title: '' };
      let snapshot = null;
      try { snapshot = await page.accessibility.snapshot({ interestingOnly: false }); }
      catch (_) { snapshot = await page.accessibility.snapshot(); }
      const title = await page.title().catch(() => '');
      const url = page.url();
      return {
        url,
        title,
        text: [`url: ${url}`, `title: ${title}`, ...flattenA11y(snapshot)].join('\n').slice(0, 24000),
      };
    } finally {
      try { await browser.close(); } catch (_) { /* ignore */ }
    }
  }
}


const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function snapshotViaDocker(containerName, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!containerName) return reject(new Error('container_missing'));
    const scriptPath = path.join(__dirname, 'cdp-ax-inner.js');
    const script = fs.readFileSync(scriptPath, 'utf8');
    const child = spawn(
      'docker',
      ['exec', '-i', '-u', 'compuser', String(containerName), 'node', '-'],
      { timeout: timeoutMs },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || out || ('cdp_docker_' + code)));
      try { resolve(JSON.parse(out)); }
      catch (parseErr) { reject(new Error('cdp_docker_parse ' + String(parseErr.message || parseErr) + ' ' + out.slice(0, 200))); }
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

module.exports = {
  loadPlaywright,
  flattenA11y,
  flattenAxNodes,
  rewriteCdpWs,
  snapshotViaRawCdp,
  snapshotViaDocker,
  snapshotAccessibility,
};
