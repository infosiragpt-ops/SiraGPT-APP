'use strict';

/**
 * document-e2e-tests.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects end-to-end test framework constructs:
 *
 *   - Cypress:        cy.visit / cy.get / cy.contains / cy.intercept / cy.fixture / cy.task
 *   - Playwright:     page.goto / page.click / page.locator / page.fill / expect(page)
 *   - WebdriverIO:    browser.url / $('selector').click() / $$('selector')
 *   - Test runners:   describe() / it() / test() / beforeEach() / afterAll() / context()
 *   - Assertions:     .should() / expect(X).toBe(Y) / .toHaveBeenCalled()
 *   - Fixtures:       cy.fixture('x') / test.use({ ... })
 *
 * Public API:
 *   extractE2eTests(text)             → { entries, totals, total }
 *   buildE2eTestsForFiles(files)      → { perFile, aggregate, totals }
 *   renderE2eTestsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const CY_RE = /\bcy\.(visit|get|contains|click|type|intercept|wait|task|fixture|stub|spy|window|location|url|title|reload|go|screenshot|viewport|hash|getCookie|setCookie|clearCookies|exec|then|invoke|its|each|wrap|trigger|focus|blur|select|check|uncheck|clear|scrollTo|scrollIntoView|find|first|last|eq|next|prev|parent|children|siblings|filter|not|within|shadow|root|origin|session)\b/g;
const PAGE_RE = /\bpage\.(goto|click|fill|type|locator|getByRole|getByLabel|getByText|getByTestId|getByPlaceholder|getByTitle|getByAltText|waitFor|waitForSelector|waitForLoadState|waitForURL|press|hover|check|uncheck|selectOption|setInputFiles|screenshot|reload|goBack|goForward|close|content|title|url|evaluate|exposeFunction|addInitScript|route|unroute|on|once|frame|frames|mainFrame|context|isVisible|isHidden|isChecked|isDisabled|isEnabled|isEditable)\b/g;
const BROWSER_RE = /\bbrowser\.(url|getUrl|getTitle|newWindow|switchToWindow|setTimeout|setViewport|saveScreenshot|execute|executeAsync|pause|debug|waitUntil)\b/g;
const TESTRUNNER_RE = /\b(describe|context|it|test|beforeEach|afterEach|beforeAll|afterAll|before|after)(?:\.(?:skip|only|each))?\s*\(/g;
const ASSERTION_RE = /(\.should|\.expect|\bexpect\s*\(.{1,80}?\)\.(?:to|not|resolves|rejects)\b|\.toBe|\.toEqual|\.toMatch|\.toContain|\.toHaveLength|\.toHaveBeenCalled|\.toThrow|\.toHaveURL|\.toContainText)/g;
const FIXTURE_RE = /\b(cy\.fixture\s*\(\s*["']([^"']{1,80})["']|test\.use\s*\(|test\.beforeEach\s*\(\s*async\s*\(\s*\{\s*page)/g;
const SELECTOR_RE = /\$\(["']([^"'\n]{1,80})["']\)|\$\$\(["']([^"'\n]{1,80})["']\)/g;

function detectFramework(body) {
  if (/\bcy\.(visit|get|intercept)/.test(body)) return 'cypress';
  if (/\bpage\.(goto|getByRole|locator)/.test(body)) return 'playwright';
  if (/\bbrowser\.(url|newWindow)/.test(body) || /\$\$?\(/.test(body)) return 'webdriverio';
  return null;
}

function extractE2eTests(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const framework = detectFramework(body);
  if (!framework && !/\b(describe|test|it)\s*\(\s*["']/.test(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    framework: framework ? 1 : 0,
    cy: 0, page: 0, browser: 0,
    testRunner: 0, assertion: 0, fixture: 0, selector: 0,
  };
  if (framework) {
    entries.push({ kind: 'framework', name: framework, detail: null });
  }

  function push(kind, name, detail) {
    const sig = `${kind}:${name}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  CY_RE.lastIndex = 0;
  let m;
  while ((m = CY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('cy', `cy.${m[1]}`, null);
  }
  if (entries.length < MAX_PER_FILE) {
    PAGE_RE.lastIndex = 0;
    while ((m = PAGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('page', `page.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    BROWSER_RE.lastIndex = 0;
    while ((m = BROWSER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('browser', `browser.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    TESTRUNNER_RE.lastIndex = 0;
    while ((m = TESTRUNNER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('testRunner', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ASSERTION_RE.lastIndex = 0;
    while ((m = ASSERTION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('assertion', m[1].replace(/^\./, '').slice(0, 30), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    FIXTURE_RE.lastIndex = 0;
    while ((m = FIXTURE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('fixture', (m[2] || 'fixture').slice(0, 40), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SELECTOR_RE.lastIndex = 0;
    while ((m = SELECTOR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const sel = (m[1] || m[2] || '').slice(0, 40);
      push('selector', sel, null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildE2eTestsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    framework: 0, cy: 0, page: 0, browser: 0,
    testRunner: 0, assertion: 0, fixture: 0, selector: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractE2eTests(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderE2eTestsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## E2E TEST FRAMEWORK CALLS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      lines.push(`- [${e.kind}] \`${e.name}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractE2eTests,
  buildE2eTestsForFiles,
  renderE2eTestsBlock,
  _internal: { detectFramework },
};
