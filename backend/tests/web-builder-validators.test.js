/**
 * web-builder validators — deterministic tests for SEO + WCAG + CWV
 * modules of the Full-Stack Web Builder component.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { validateSeo } = require("../src/services/software-engineering/seo-validator");
const { checkWcag, contrastRatio } = require("../src/services/software-engineering/wcag-checker");
const { analyzeBudget } = require("../src/services/software-engineering/cwv-budget");

function expect(actual) {
  return {
    toEqual(e) { assert.deepEqual(actual, e); },
    toBe(e) { assert.equal(actual, e); },
    toBeGreaterThan(e) { assert.ok(actual > e, `${actual} not > ${e}`); },
    toBeGreaterThanOrEqual(e) { assert.ok(actual >= e, `${actual} not >= ${e}`); },
    toBeLessThan(e) { assert.ok(actual < e, `${actual} not < ${e}`); },
    toContain(e) { assert.ok(actual.includes(e), `${JSON.stringify(actual)} missing ${JSON.stringify(e)}`); },
    toBeTruthy() { assert.ok(actual); },
    toBeFalsy() { assert.ok(!actual); },
    toMatch(p) { assert.match(String(actual), p); },
  };
}

// ── SEO tests ────────────────────────────────────────────────────────

describe("seo-validator", () => {
  const goodHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Great Product Page — Buy the Best Widget</title>
<meta name="description" content="The highest quality widget on the market, engineered for durability and a delightful user experience.">
<link rel="canonical" href="https://example.com/widget">
<meta property="og:title" content="Widget">
<meta property="og:description" content="Best widget ever.">
<meta property="og:image" content="https://example.com/w.png">
<meta property="og:type" content="product">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Widget">
<meta name="twitter:description" content="Best widget ever.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget"}</script>
</head><body><h1>Widget</h1><p>Body.</p></body></html>`;

  test("clean document produces no high-severity findings", () => {
    const r = validateSeo({ html: goodHtml });
    expect(r.counts.high).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.meta.title.length).toBeGreaterThan(10);
    expect(r.meta.canonical).toBe("https://example.com/widget");
  });

  test("missing title is flagged high", () => {
    const r = validateSeo({ html: "<html><body>Hi</body></html>" });
    expect(r.ok).toBe(false);
    expect(r.findings.some(f => f.code === "title_missing")).toBe(true);
  });

  test("noindex is flagged high", () => {
    const r = validateSeo({ html: `<html lang="en"><head><title>A title here for testing</title><meta name="robots" content="noindex"></head><body><h1>A</h1></body></html>` });
    expect(r.findings.some(f => f.code === "robots_noindex")).toBe(true);
  });

  test("multiple h1 flagged medium", () => {
    const r = validateSeo({ html: `<html lang="en"><head><title>Testing the page heading count scenario</title></head><body><h1>1</h1><h1>2</h1></body></html>` });
    expect(r.findings.some(f => f.code === "h1_multiple")).toBe(true);
  });

  test("vague anchor text flagged low", () => {
    const html = goodHtml.replace("<p>Body.</p>", "<p><a href=\"/about\">click here</a></p>");
    const r = validateSeo({ html });
    expect(r.findings.some(f => f.code === "vague_anchor_text")).toBe(true);
  });

  test("missing og tags flag medium", () => {
    const r = validateSeo({ html: `<html lang="en"><head><title>Missing OG Test Page</title><meta name="description" content="A reasonably long enough description to pass the 50-char minimum threshold here."></head><body><h1>A</h1></body></html>` });
    expect(r.findings.some(f => f.code === "og_og_title_missing")).toBe(true);
  });

  test("bad input returns error shape", () => {
    const r = validateSeo({ html: "" });
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe("bad_input");
  });
});

// ── WCAG tests ───────────────────────────────────────────────────────

describe("wcag-checker", () => {
  test("clean document has no high issues", () => {
    const html = `<!doctype html><html lang="en"><head><title>Hi</title></head>
<body>
<main>
  <h1>Welcome</h1>
  <img src="/hero.png" alt="A person using the product">
  <form><label for="email">Email</label><input id="email" type="email"></form>
  <a href="/about">About our company</a>
</main>
</body></html>`;
    const r = checkWcag({ html });
    expect(r.counts.high).toBe(0);
    expect(r.ok).toBe(true);
  });

  test("missing img alt is flagged high", () => {
    const r = checkWcag({ html: `<!doctype html><html lang="en"><head><title>T</title></head><body><main><img src="/x.png"></main></body></html>` });
    expect(r.findings.some(f => f.code === "img_alt_missing")).toBe(true);
    expect(r.ok).toBe(false);
  });

  test("unlabeled input is flagged high", () => {
    const r = checkWcag({ html: `<!doctype html><html lang="en"><head><title>T</title></head><body><main><form><input type="text" name="q"></form></main></body></html>` });
    expect(r.findings.some(f => f.code === "input_unlabeled")).toBe(true);
  });

  test("duplicate id is flagged medium", () => {
    const r = checkWcag({ html: `<!doctype html><html lang="en"><head><title>T</title></head><body><main><div id="x"></div><div id="x"></div></main></body></html>` });
    expect(r.findings.some(f => f.code === "duplicate_id")).toBe(true);
  });

  test("heading skip flagged medium", () => {
    const r = checkWcag({ html: `<!doctype html><html lang="en"><head><title>Title</title></head><body><main><h1>A</h1><h3>B</h3></main></body></html>` });
    expect(r.findings.some(f => f.code === "heading_skip")).toBe(true);
  });

  test("missing html lang flagged high", () => {
    const r = checkWcag({ html: `<!doctype html><html><head><title>T</title></head><body><main><h1>A</h1></main></body></html>` });
    expect(r.findings.some(f => f.code === "html_lang_missing")).toBe(true);
  });

  test("no bypass block flagged medium", () => {
    const r = checkWcag({ html: `<!doctype html><html lang="en"><head><title>T</title></head><body><h1>A</h1></body></html>` });
    expect(r.findings.some(f => f.code === "no_bypass_block")).toBe(true);
  });

  test("button with no accessible name flagged high", () => {
    const r = checkWcag({ html: `<!doctype html><html lang="en"><head><title>T</title></head><body><main><button></button></main></body></html>` });
    expect(r.findings.some(f => f.code === "button_no_name")).toBe(true);
  });

  test("contrastRatio computes correct values", () => {
    const black = contrastRatio("#000000", "#ffffff");
    expect(black.ratio).toBe(21);
    expect(black.passes_aa).toBe(true);
    expect(black.passes_aaa).toBe(true);

    const poor = contrastRatio("#777777", "#888888");
    expect(poor.passes_aa).toBe(false);

    const mid = contrastRatio("#595959", "#ffffff");
    expect(mid.passes_aa).toBe(true);
  });

  test("contrastRatio handles rgb() syntax and named colours", () => {
    const r = contrastRatio("rgb(0,0,0)", "white");
    expect(r.ratio).toBe(21);
  });

  test("contrastRatio errors on unparseable colour", () => {
    const r = contrastRatio("banana", "#fff");
    expect(r.error).toBe("unparseable_colour");
  });
});

// ── CWV budget tests ─────────────────────────────────────────────────

describe("cwv-budget", () => {
  test("clean page passes budgets", () => {
    const html = `<!doctype html><html><head><title>T</title></head><body><img src="/h.png" alt="x" loading="eager" width="100" height="100"></body></html>`;
    const r = analyzeBudget({ html });
    expect(r.counts.high).toBe(0);
    expect(r.ok).toBe(true);
  });

  test("JS budget exceeded flags high", () => {
    const html = `<html><head>
<script src="/a.js"></script>
</head><body></body></html>`;
    const r = analyzeBudget({
      html,
      assetSizes: { "/a.js": 200 * 1024 }, // 200 KB — over 170 KB budget
    });
    expect(r.findings.some(f => f.code === "js_budget_exceeded")).toBe(true);
    expect(r.ok).toBe(false);
  });

  test("render-blocking count over budget flags medium", () => {
    const html = `<html><head>
<script src="/a.js"></script>
<script src="/b.js"></script>
<script src="/c.js"></script>
<link rel="stylesheet" href="/a.css">
<link rel="stylesheet" href="/b.css">
</head><body></body></html>`;
    const r = analyzeBudget({ html });
    expect(r.findings.some(f => f.code === "render_blocking_excess")).toBe(true);
    expect(r.stats.render_blocking_count).toBeGreaterThan(4);
  });

  test("async + defer + module scripts don't count as render-blocking", () => {
    const html = `<html><head>
<script src="/a.js" async></script>
<script src="/b.js" defer></script>
<script src="/c.js" type="module"></script>
</head><body></body></html>`;
    const r = analyzeBudget({ html });
    expect(r.stats.render_blocking_count).toBe(0);
  });

  test("images without width/height flag CLS risk", () => {
    const html = `<html><body><img src="/x.png" alt="x"></body></html>`;
    const r = analyzeBudget({ html });
    expect(r.findings.some(f => f.code === "cls_risk_images_without_dims")).toBe(true);
  });

  test("first img with loading=lazy flags LCP risk", () => {
    const html = `<html><body><img src="/hero.png" alt="x" loading="lazy" width="100" height="100"></body></html>`;
    const r = analyzeBudget({ html });
    expect(r.findings.some(f => f.code === "lcp_hero_lazy")).toBe(true);
  });

  test("third-party origins counted from absolute URLs", () => {
    const html = `<html><head>
<script src="https://cdn.example.com/a.js"></script>
<script src="https://ads.example.net/b.js"></script>
<script src="https://analytics.example.org/c.js"></script>
<script src="https://widgets.example.io/d.js"></script>
</head><body></body></html>`;
    const r = analyzeBudget({ html, siteOrigin: "https://mysite.com" });
    expect(r.stats.third_party_origins).toBe(4);
    expect(r.findings.some(f => f.code === "too_many_third_parties")).toBe(true);
  });

  test("bad input returns error shape", () => {
    const r = analyzeBudget({ html: "" });
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe("bad_input");
  });

  test("custom budgets override defaults", () => {
    const html = `<html><head><script src="/a.js"></script></head><body></body></html>`;
    const r = analyzeBudget({
      html,
      assetSizes: { "/a.js": 50 * 1024 },
      budgets: { js_bytes: 10 * 1024 },
    });
    expect(r.findings.some(f => f.code === "js_budget_exceeded")).toBe(true);
  });

  test("inline styles and inline scripts counted", () => {
    const html = `<html><head><style>${"a".repeat(2000)}</style><script>${"b".repeat(2000)}</script></head><body></body></html>`;
    const r = analyzeBudget({ html });
    expect(r.stats.inline_styles_bytes).toBeGreaterThanOrEqual(2000);
    expect(r.stats.js_bytes).toBeGreaterThanOrEqual(2000);
  });
});
