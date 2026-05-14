'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-e2e-tests');
const { extractE2eTests, buildE2eTestsForFiles, renderE2eTestsBlock, _internal } = engine;
const { detectFramework } = _internal;

const CYPRESS_FIXTURE = `describe('Login flow', () => {
  beforeEach(() => {
    cy.fixture('users.json').as('users');
    cy.intercept('POST', '/api/login').as('login');
  });

  it('logs in with valid credentials', () => {
    cy.visit('/login');
    cy.get('[data-test=email]').type('a@b.com');
    cy.get('[data-test=password]').type('secret');
    cy.contains('button', 'Sign in').click();
    cy.wait('@login').its('response.statusCode').should('eq', 200);
    cy.url().should('include', '/dashboard');
  });
});`;

const PLAYWRIGHT_FIXTURE = `import { test, expect } from '@playwright/test';

test.describe('checkout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://example.com');
  });

  test('completes purchase', async ({ page }) => {
    await page.click('text=Buy');
    await page.fill('input[name=email]', 'a@b.com');
    await page.locator('button.submit').click();
    await expect(page).toHaveURL(/confirm/);
    await expect(page.getByRole('heading')).toContainText('Thanks');
  });
});`;

test('empty / non-string tolerated', () => {
  assert.equal(extractE2eTests('').total, 0);
  assert.equal(extractE2eTests(null).total, 0);
});

test('detectFramework: cypress / playwright / webdriverio', () => {
  assert.equal(detectFramework('cy.visit("/")'), 'cypress');
  assert.equal(detectFramework('page.goto("/")'), 'playwright');
  assert.equal(detectFramework('browser.url("/")'), 'webdriverio');
  assert.equal(detectFramework('plain text'), null);
});

test('detects Cypress framework', () => {
  const r = extractE2eTests(CYPRESS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'framework' && e.name === 'cypress'));
});

test('detects cy.visit / cy.get / cy.contains', () => {
  const r = extractE2eTests(CYPRESS_FIXTURE);
  assert.ok(r.entries.some((e) => e.name === 'cy.visit'));
  assert.ok(r.entries.some((e) => e.name === 'cy.get'));
  assert.ok(r.entries.some((e) => e.name === 'cy.contains'));
});

test('detects cy.intercept and cy.wait', () => {
  const r = extractE2eTests(CYPRESS_FIXTURE);
  assert.ok(r.entries.some((e) => e.name === 'cy.intercept'));
  assert.ok(r.entries.some((e) => e.name === 'cy.wait'));
});

test('detects cy.fixture', () => {
  const r = extractE2eTests(CYPRESS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'fixture'));
});

test('detects Playwright framework', () => {
  const r = extractE2eTests(PLAYWRIGHT_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'framework' && e.name === 'playwright'));
});

test('detects page.goto / page.click / page.fill', () => {
  const r = extractE2eTests(PLAYWRIGHT_FIXTURE);
  assert.ok(r.entries.some((e) => e.name === 'page.goto'));
  assert.ok(r.entries.some((e) => e.name === 'page.click'));
  assert.ok(r.entries.some((e) => e.name === 'page.fill'));
});

test('detects page.getByRole / page.locator', () => {
  const r = extractE2eTests(PLAYWRIGHT_FIXTURE);
  assert.ok(r.entries.some((e) => e.name === 'page.locator'));
  assert.ok(r.entries.some((e) => e.name === 'page.getByRole'));
});

test('detects describe / it / test test-runners', () => {
  const r = extractE2eTests(CYPRESS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'testRunner' && e.name === 'describe'));
  assert.ok(r.entries.some((e) => e.kind === 'testRunner' && e.name === 'it'));
});

test('detects beforeEach lifecycle', () => {
  const r = extractE2eTests(CYPRESS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'testRunner' && e.name === 'beforeEach'));
});

test('detects assertions: should / expect / toBe', () => {
  const r = extractE2eTests(CYPRESS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'assertion'));
});

test('detects WebdriverIO browser API', () => {
  const r = extractE2eTests('browser.url("/"); $("button").click(); $$("a.link");');
  assert.ok(r.entries.some((e) => e.kind === 'framework' && e.name === 'webdriverio'));
  assert.ok(r.entries.some((e) => e.kind === 'browser' && e.name === 'browser.url'));
});

test('detects $ / $$ selectors', () => {
  const r = extractE2eTests('browser.url("/"); $("input.email").setValue("a@b.com"); $$("ul li");');
  assert.ok(r.entries.some((e) => e.kind === 'selector' && /input\.email/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'selector' && /ul li/.test(e.name)));
});

test('dedupes identical calls', () => {
  const r = extractE2eTests('cy.get("a"); cy.get("a");');
  assert.equal(r.entries.filter((e) => e.kind === 'cy' && e.name === 'cy.get').length, 1);
});

test('caps entries per file', () => {
  let text = 'describe("x", () => { ';
  for (let i = 0; i < 40; i++) text += `cy.get("[data-test=el-${i}]"); cy.click(); `;
  text += '});';
  const r = extractE2eTests(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractE2eTests(CYPRESS_FIXTURE);
  assert.ok(r.totals.cy >= 3);
  assert.ok(r.totals.testRunner >= 2);
});

test('buildE2eTestsForFiles aggregates across batch', () => {
  const files = [
    { name: 'login.cy.js', extractedText: CYPRESS_FIXTURE },
    { name: 'checkout.spec.ts', extractedText: PLAYWRIGHT_FIXTURE },
  ];
  const r = buildE2eTestsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderE2eTestsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'login.cy.js', extractedText: CYPRESS_FIXTURE }];
  const r = buildE2eTestsForFiles(files);
  const md = renderE2eTestsBlock(r);
  assert.match(md, /^## E2E TEST/);
});

test('renderE2eTestsBlock empty when nothing surfaces', () => {
  assert.equal(renderE2eTestsBlock({ perFile: [] }), '');
  assert.equal(renderE2eTestsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildE2eTestsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: CYPRESS_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
