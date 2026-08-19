/**
 * web-automation regression — deterministic tests for the
 * compliant-scraping foundation (url-canonical, robots, scraper-
 * policy, rate-limiter, html-extract). No network.
 */

const { strict: assert } = require("assert");

const { canonicalize, sameResource, dedupeUrlList, registrableDomain, isTrackingParam } = require("../src/services/web/url-canonical");
const { parseRobots, pickGroup, isAllowed } = require("../src/services/web/robots");
const { reviewScraperPolicy } = require("../src/services/web/scraper-policy");
const { createRateLimiter } = require("../src/services/web/rate-limiter");
const { extractAll, extractJsonLd, extractOpenGraph, extractMeta, extractBreadcrumbs } = require("../src/services/web/html-extract");
const { getComponent, assertRegistryIntegrity } = require("../src/services/agents/component-registry");

const cases = [
  // ── URL canonical ─────────────────────────────────────────────────
  () => {
    const c = canonicalize("HTTPS://Example.COM:443/path/?b=2&a=1#frag");
    assert.equal(c, "https://example.com/path/?a=1&b=2");
  },

  () => {
    // utm_* + fbclid stripped
    const c = canonicalize("https://x.com/p?utm_source=x&fbclid=y&z=1");
    assert.equal(c, "https://x.com/p?z=1");
  },

  () => {
    assert.equal(canonicalize("not-a-url"), null);
    assert.equal(canonicalize("mailto:x@y.com"), null);
  },

  () => {
    assert.equal(sameResource("https://X.com/A?utm_source=1", "https://x.com/A"), true);
    assert.equal(sameResource("https://x.com/a", "https://x.com/b"), false);
  },

  () => {
    const urls = ["https://x.com/a", "HTTPS://X.COM/a?utm_campaign=x", "https://x.com/b"];
    const r = dedupeUrlList(urls);
    assert.equal(r.unique.length, 2);
  },

  () => {
    assert.equal(registrableDomain("https://foo.bar.example.com.ar/path"), "example.com.ar");
    assert.equal(registrableDomain("https://a.b.co.uk"), "b.co.uk");
    assert.equal(registrableDomain("https://x.com"), "x.com");
  },

  () => {
    assert.equal(isTrackingParam("utm_source"), true);
    assert.equal(isTrackingParam("fbclid"), true);
    assert.equal(isTrackingParam("product_id"), false);
  },

  // ── robots.txt ────────────────────────────────────────────────────
  () => {
    const text = [
      "User-agent: *",
      "Disallow: /private/",
      "Allow: /private/public-page",
      "Crawl-delay: 2",
      "",
      "User-agent: BadBot",
      "Disallow: /",
      "",
      "Sitemap: https://example.com/sitemap.xml",
    ].join("\n");
    const p = parseRobots(text);
    assert.equal(p.groups.length, 2);
    assert.equal(p.sitemaps.length, 1);
    const star = pickGroup(p, "my-crawler/1.0");
    assert.ok(star.agents.includes("*"));
    assert.equal(star.crawlDelay, 2);
  },

  () => {
    const text = "User-agent: *\nDisallow: /private/";
    const ok = isAllowed("my-bot", "https://site.com/public", text);
    assert.equal(ok.allowed, true);
    const no = isAllowed("my-bot", "https://site.com/private/x", text);
    assert.equal(no.allowed, false);
  },

  () => {
    // Longest-match: Allow overrides Disallow when it's longer
    const text = [
      "User-agent: *",
      "Disallow: /private/",
      "Allow: /private/public-page",
    ].join("\n");
    const r = isAllowed("bot", "https://x.com/private/public-page", text);
    assert.equal(r.allowed, true);
    assert.ok(r.reason.includes("allow"));
  },

  () => {
    // Exact UA match wins over *
    const text = [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: my-bot",
      "Disallow:",
    ].join("\n");
    const r = isAllowed("my-bot", "https://x.com/any", text);
    assert.equal(r.allowed, true);
  },

  // ── scraper-policy ────────────────────────────────────────────────
  () => {
    const r = reviewScraperPolicy({
      project_name: "research",
      owner_contact: "me@siragpt.io",
      purpose: "academic citation verification",
      user_agent: "siraGPT-crawler/1.0 (+https://siragpt.io/bot)",
      respect_robots: true,
      allow_hosts: ["example.com"],
      deny_paths: ["/private/"],
    });
    assert.equal(r.ok, true, `good config should pass. Findings: ${JSON.stringify(r.findings)}`);
  },

  () => {
    const r = reviewScraperPolicy({
      project_name: "bad",
      owner_contact: "me@x.com",
      purpose: "scrape",
      user_agent: "siraGPT-crawler/1.0 (+https://siragpt.io/bot)",
      respect_robots: true,
      allow_hosts: ["example.com"],
      captcha_bypass: true,
    });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "banned_compliance_flag"));
  },

  () => {
    const r = reviewScraperPolicy({
      project_name: "bad",
      owner_contact: "me@x.com",
      purpose: "scrape",
      user_agent: "siraGPT (+https://siragpt.io/bot)",
      respect_robots: true,
      allow_hosts: ["example.com"],
      resolver: "2captcha.com",
    });
    assert.ok(r.findings.some(f => f.code === "banned_value_token"));
  },

  () => {
    const r = reviewScraperPolicy({
      project_name: "x",
      owner_contact: "me@x.com",
      purpose: "y",
      user_agent: "curl",
      respect_robots: true,
      allow_hosts: ["example.com"],
    });
    assert.ok(r.findings.some(f => f.code === "opaque_user_agent"));
  },

  () => {
    const r = reviewScraperPolicy({});
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "respect_robots_not_set"));
    assert.ok(r.findings.some(f => f.code === "incomplete_metadata"));
  },

  () => {
    const r = reviewScraperPolicy({
      project_name: "x",
      owner_contact: "me@x.com",
      purpose: "y",
      user_agent: "siraGPT (+https://siragpt.io/bot)",
      respect_robots: true,
      respect_rate_limit: false,
      allow_hosts: ["example.com"],
    });
    assert.ok(r.findings.some(f => f.code === "rate_limit_disabled"));
  },

  // ── rate-limiter ──────────────────────────────────────────────────
  () => {
    let t = 0;
    const rl = createRateLimiter({ clock: () => t, capacity: 2, windowMs: 1000 });
    const r1 = rl.acquireDelay("a.com");
    const r2 = rl.acquireDelay("a.com");
    const r3 = rl.acquireDelay("a.com");
    assert.equal(r1.reason, "ready");
    assert.equal(r2.reason, "ready");
    assert.equal(r3.reason, "throttled");
    assert.ok(r3.delay > 0);
  },

  () => {
    let t = 0;
    const rl = createRateLimiter({ clock: () => t, capacity: 1, windowMs: 1000 });
    rl.recordFailure("host.com", { is5xx: true });
    const r = rl.acquireDelay("host.com");
    assert.equal(r.reason, "backoff");
    assert.ok(r.delay > 0);
    t += 100000;
    const r2 = rl.acquireDelay("host.com");
    assert.notEqual(r2.reason, "backoff");
  },

  () => {
    let t = 0;
    const rl = createRateLimiter({ clock: () => t });
    rl.recordFailure("h", { retryAfterMs: 5000 });
    const r = rl.acquireDelay("h");
    assert.equal(r.reason, "backoff");
    assert.ok(r.delay >= 4000 && r.delay <= 5000);
  },

  () => {
    const rl = createRateLimiter();
    rl.recordFailure("h", {});
    rl.recordSuccess("h");
    const snap = rl.snapshot();
    assert.equal(snap.h.backoffMs, 0);
  },

  // ── html-extract ──────────────────────────────────────────────────
  () => {
    const html = `
      <html lang="en">
      <head>
        <title>Example — Hello</title>
        <meta charset="utf-8">
        <meta name="description" content="desc"/>
        <link rel="canonical" href="https://example.com/"/>
        <meta property="og:title" content="OG Title"/>
        <meta property="og:image" content="https://example.com/img.jpg"/>
        <meta name="twitter:card" content="summary"/>
        <script type="application/ld+json">{"@type":"Article","headline":"Hello"}</script>
      </head>
      <body></body></html>`;
    const r = extractAll(html);
    assert.equal(r.meta.title, "Example — Hello");
    assert.equal(r.meta.description, "desc");
    assert.equal(r.meta.canonical, "https://example.com/");
    assert.equal(r.meta.lang, "en");
    assert.equal(r.meta.charset, "utf-8");
    assert.equal(r.openGraph.title, "OG Title");
    assert.equal(r.openGraph.image, "https://example.com/img.jpg");
    assert.equal(r.twitter.card, "summary");
    assert.equal(r.jsonLd.length, 1);
    assert.equal(r.jsonLd[0].headline, "Hello");
  },

  () => {
    const html = `<script type="application/ld+json">
      {"@type":"BreadcrumbList","itemListElement":[
        {"position":1,"name":"Home","item":"https://x.com/"},
        {"position":2,"name":"Store","item":"https://x.com/store"}
      ]}</script>`;
    const bcs = extractBreadcrumbs(html);
    assert.equal(bcs.length, 2);
    assert.equal(bcs[1].name, "Store");
  },

  () => {
    // Bad JSON-LD doesn't throw
    const html = `<script type="application/ld+json">{ this is not json</script>`;
    const arr = extractJsonLd(html);
    assert.deepEqual(arr, []);
  },

  () => {
    // HTML entities decoded in title
    const r = extractMeta(`<html><head><title>Foo &amp; Bar</title></head><body/></html>`);
    assert.equal(r.title, "Foo & Bar");
  },

  () => {
    // No OG tags → empty object, not null
    const r = extractOpenGraph(`<html><body>hi</body></html>`);
    assert.deepEqual(r, {});
  },

  // ── registry reflects the new partial ─────────────────────────────
  () => {
    assertRegistryIntegrity();
    const c = getComponent("web-automation-scraping");
    assert.equal(c.status, "partial");
    assert.ok(c.backing_modules.length >= 5);
  },
];

let passed = 0, failed = 0;
const failures = [];
cases.forEach((fn, i) => {
  try { fn(); passed++; }
  catch (err) { failed++; failures.push({ case: i + 1, message: err.message }); }
});

console.log(`web-automation regression: ${passed}/${cases.length} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  FAIL ${f.case}: ${f.message}`);
  process.exit(1);
}
process.exit(0);
