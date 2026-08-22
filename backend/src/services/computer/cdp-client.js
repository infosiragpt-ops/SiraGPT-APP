'use strict';

/**
 * Chrome DevTools accessibility snapshot for models without vision.
 *
 * Uses playwright-core (falls back to playwright) over the desktop CDP
 * endpoint. Returns a text tree — never a PNG — so DeepSeek can act
 * without image parts. Ideas only; not a clone of external demos.
 */

function loadPlaywright() {
  try { return require('playwright-core'); } catch (_) { /* fall through */ }
  return require('playwright');
}

function flattenA11y(node, lines = [], depth = 0) {
  if (!node) return lines;
  const indent = '  '.repeat(Math.min(depth, 16));
  const role = node.role || 'unknown';
  const name = node.name ? ` "${String(node.name).slice(0, 120)}"` : '';
  const value = node.value ? ` = ${String(node.value).slice(0, 80)}` : '';
  lines.push(`${indent}${role}${name}${value}`);
  for (const child of node.children || []) flattenA11y(child, lines, depth + 1);
  return lines;
}

async function snapshotAccessibility(cdpUrl, {
  playwrightImpl,
  timeoutMs = 12_000,
  connect,
} = {}) {
  if (typeof connect === 'function') {
    return connect(cdpUrl);
  }
  const { chromium } = playwrightImpl || loadPlaywright();
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs });
  try {
    const contexts = browser.contexts();
    const pages = contexts.flatMap((ctx) => ctx.pages());
    const page = pages[0] || await contexts[0]?.newPage();
    if (!page) return { text: '(no page)', url: null, title: '' };
    let snapshot = null;
    try {
      snapshot = await page.accessibility.snapshot({ interestingOnly: false });
    } catch (_) {
      snapshot = await page.accessibility.snapshot();
    }
    const title = await page.title().catch(() => '');
    const url = page.url();
    return {
      url,
      title,
      text: [`url: ${url}`, `title: ${title}`, ...flattenA11y(snapshot)].join('\n').slice(0, 24_000),
    };
  } finally {
    try { await browser.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  loadPlaywright,
  flattenA11y,
  snapshotAccessibility,
};
