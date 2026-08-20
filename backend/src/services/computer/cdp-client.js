'use strict';

/**
 * Playwright CDP client for Chrome inside the agent-computer container.
 * Observation is the accessibility tree (text), not pixels.
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

async function snapshotAccessibility(cdpUrl, { playwrightImpl, timeoutMs = 12_000 } = {}) {
  const { chromium } = playwrightImpl || loadPlaywright();
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs });
  try {
    const contexts = browser.contexts();
    const pages = contexts.flatMap((c) => c.pages());
    const page = pages[0] || await contexts[0]?.newPage();
    if (!page) return { text: '(no page)', url: null };
    let snapshot = null;
    try {
      snapshot = await page.accessibility.snapshot({ interestingOnly: false });
    } catch (_) {
      snapshot = await page.accessibility.snapshot();
    }
    const title = await page.title().catch(() => '');
    const url = page.url();
    const lines = flattenA11y(snapshot);
    return {
      url,
      title,
      text: [`url: ${url}`, `title: ${title}`, ...lines].join('\n').slice(0, 24_000),
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
