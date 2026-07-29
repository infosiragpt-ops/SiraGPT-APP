/**
 * business-analyzer.test.js — P3.2 Business presence audit.
 *
 * All deps are fakes: no network is ever touched.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeBusinessPresence,
  inspectLandingHtml,
  detectSoftwareSignals,
  SOCIAL_NETWORKS,
  PRIORITY_ORDER,
  SUMMARY_MAX_CHARS,
} = require('../src/services/business-analyzer');

// ── Fakes ─────────────────────────────────────────────────────────────────

const emptySearch = async () => [];

const HEALTHY_HTML = `<!doctype html>
<html><head>
  <title>Acme Corp — Soluciones industriales</title>
  <meta name="description" content="Acme Corp fabrica soluciones industriales">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head><body>
  <h1>Bienvenido a Acme</h1>
  <p>Descarga la app y accede con tu login al portal de clientes.</p>
  <form><input type="password" name="pw"></form>
</body></html>`;

function assertSortedByPriority(gaps) {
  for (let i = 1; i < gaps.length; i += 1) {
    assert.ok(
      PRIORITY_ORDER[gaps[i - 1].priority] <= PRIORITY_ORDER[gaps[i].priority],
      `gaps out of priority order at index ${i}: ${gaps[i - 1].priority} > ${gaps[i].priority}`,
    );
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('business-analyzer', () => {
  describe('input validation', () => {
    it('rejects a missing company name', async () => {
      await assert.rejects(() => analyzeBusinessPresence({ company: {} }), TypeError);
      await assert.rejects(() => analyzeBusinessPresence(), TypeError);
    });
  });

  describe('empresa sin nada', () => {
    it('produces the full prioritized gap list', async () => {
      let fetchCalls = 0;
      const result = await analyzeBusinessPresence({
        company: { name: 'Fantasma SL' },
        deps: {
          webSearch: emptySearch,
          fetchPage: async () => { fetchCalls += 1; return { status: 200, html: '' }; },
        },
      });

      assert.equal(fetchCalls, 0, 'no URL resolved, fetchPage must not be called');
      assert.deepEqual(result.landing, { exists: false });

      for (const { id } of SOCIAL_NETWORKS) {
        assert.deepEqual(result.socials[id], { found: false });
      }
      assert.deepEqual(result.software.signals, []);

      const ids = result.gaps.map((g) => g.id);
      assert.ok(ids.includes('missing-landing'));
      for (const { id } of SOCIAL_NETWORKS) {
        assert.ok(ids.includes(`social-${id}-missing`), `missing social gap for ${id}`);
      }
      assert.ok(ids.includes('no-software-signals'));

      const landingGap = result.gaps.find((g) => g.id === 'missing-landing');
      assert.equal(landingGap.priority, 'alta');
      assert.equal(landingGap.suggestedDepartment, 'product-engineering');
      assert.equal(result.gaps[0].id, 'missing-landing', 'alta gap must come first');

      for (const gap of result.gaps) {
        assert.ok(['alta', 'media', 'baja'].includes(gap.priority), `invalid priority ${gap.priority}`);
        assert.equal(typeof gap.gap, 'string');
        assert.equal(typeof gap.suggestedDepartment, 'string');
      }
      assertSortedByPriority(result.gaps);
      assert.equal(result.gaps.find((g) => g.id === 'no-software-signals').priority, 'baja');
    });
  });

  describe('empresa con landing sana + 2 redes', () => {
    it('only reports gaps for what is actually missing', async () => {
      const searches = [];
      const result = await analyzeBusinessPresence({
        company: {
          name: 'Acme Corp',
          urls: {
            web: 'https://acme.example.com',
            socials: { instagram: 'https://instagram.com/acmecorp' },
          },
        },
        deps: {
          webSearch: async ({ query }) => {
            searches.push(query);
            if (query.includes('site:linkedin.com')) {
              return [{ title: 'Acme Corp | LinkedIn', url: 'https://www.linkedin.com/company/acmecorp', snippet: 'Perfil oficial' }];
            }
            return [];
          },
          fetchPage: async (url) => {
            assert.equal(url, 'https://acme.example.com');
            return { status: 200, html: HEALTHY_HTML };
          },
        },
      });

      assert.deepEqual(result.landing, {
        exists: true,
        url: 'https://acme.example.com',
        httpOk: true,
        hasTitle: true,
        hasMetaDescription: true,
        hasViewport: true,
      });

      // Provided instagram is trusted without searching for it.
      assert.ok(!searches.some((q) => q.includes('site:instagram.com')), 'must not search provided socials');
      assert.deepEqual(result.socials.instagram, { found: true, url: 'https://instagram.com/acmecorp' });
      assert.equal(result.socials.linkedin.found, true);
      assert.equal(result.socials.linkedin.url, 'https://www.linkedin.com/company/acmecorp');
      assert.equal(result.socials.x.found, false);
      assert.equal(result.socials.facebook.found, false);
      assert.equal(result.socials.tiktok.found, false);

      // Software signals detected from the landing (app + login + password input).
      const signalIds = result.software.signals.map((s) => s.id);
      assert.ok(signalIds.includes('app'));
      assert.ok(signalIds.includes('login'));

      const ids = result.gaps.map((g) => g.id);
      assert.ok(!ids.some((id) => id.startsWith('landing') || id === 'missing-landing'), 'no landing gaps expected');
      assert.ok(!ids.includes('social-instagram-missing'));
      assert.ok(!ids.includes('social-linkedin-missing'));
      assert.ok(!ids.includes('no-software-signals'));
      assert.deepEqual(
        ids.sort(),
        ['social-facebook-missing', 'social-tiktok-missing', 'social-x-missing'],
      );
      for (const gap of result.gaps) {
        assert.equal(gap.suggestedDepartment, 'marketing');
      }
      assertSortedByPriority(result.gaps);
    });
  });

  describe('degradación ante deps rotas', () => {
    it('a throwing fetchPage degrades to an unreachable landing without exploding', async () => {
      const result = await analyzeBusinessPresence({
        company: { name: 'Rota SA', urls: { web: 'https://rota.example.com' } },
        deps: {
          webSearch: emptySearch,
          fetchPage: async () => { throw new Error('boom'); },
        },
      });

      assert.equal(result.landing.exists, true);
      assert.equal(result.landing.url, 'https://rota.example.com');
      assert.equal(result.landing.httpOk, false);

      const landingGap = result.gaps.find((g) => g.id === 'landing-unreachable');
      assert.ok(landingGap, 'landing-unreachable gap expected');
      assert.equal(landingGap.priority, 'alta');
      assert.equal(landingGap.suggestedDepartment, 'product-engineering');
      assertSortedByPriority(result.gaps);
    });

    it('a throwing webSearch degrades socials/landing discovery to not-found', async () => {
      const result = await analyzeBusinessPresence({
        company: { name: 'Ciega SL' },
        deps: {
          webSearch: async () => { throw new Error('search down'); },
          fetchPage: async () => ({ status: 200, html: HEALTHY_HTML }),
        },
      });

      assert.deepEqual(result.landing, { exists: false });
      for (const { id } of SOCIAL_NETWORKS) {
        assert.deepEqual(result.socials[id], { found: false });
      }
      assert.equal(typeof result.summary, 'string');
    });

    it('non-2xx status counts as not httpOk and skips HTML checks', async () => {
      const result = await analyzeBusinessPresence({
        company: { name: 'Caida SA', urls: { web: 'https://caida.example.com' } },
        deps: {
          webSearch: emptySearch,
          fetchPage: async () => ({ status: 500, html: HEALTHY_HTML }),
        },
      });
      assert.equal(result.landing.httpOk, false);
      assert.equal(result.landing.hasTitle, false);
      assert.ok(result.gaps.some((g) => g.id === 'landing-unreachable'));
    });
  });

  describe('summary', () => {
    it('is Spanish, mentions the company and never exceeds 600 chars', async () => {
      const longName = 'Compañía Internacional de Manufacturas Avanzadas y Servicios Tecnológicos del Atlántico Norte SL'.repeat(3);
      const result = await analyzeBusinessPresence({
        company: { name: longName },
        deps: { webSearch: emptySearch, fetchPage: async () => ({ status: 200, html: '' }) },
      });

      assert.equal(typeof result.summary, 'string');
      assert.ok(result.summary.length <= SUMMARY_MAX_CHARS, `summary too long: ${result.summary.length}`);
      assert.ok(result.summary.includes('Auditoría de presencia digital'));
    });

    it('reports landing + socials + gap counts for a healthy company', async () => {
      const result = await analyzeBusinessPresence({
        company: {
          name: 'Acme Corp',
          urls: { web: 'https://acme.example.com', socials: { instagram: 'https://instagram.com/acme' } },
        },
        deps: { webSearch: emptySearch, fetchPage: async () => ({ status: 200, html: HEALTHY_HTML }) },
      });
      assert.ok(result.summary.length <= SUMMARY_MAX_CHARS);
      assert.ok(result.summary.includes('Landing activa'));
      assert.ok(result.summary.includes('instagram'));
      assert.ok(result.summary.includes('gaps priorizados'));
    });
  });

  describe('helpers', () => {
    it('inspectLandingHtml handles attribute-order variants and empty content', () => {
      const html = '<head><TITLE> Hola </TITLE><meta content="desc" name="description"><meta name="viewport" content=""></head>';
      const out = inspectLandingHtml(html);
      assert.equal(out.hasTitle, true);
      assert.equal(out.hasMetaDescription, true);
      assert.equal(out.hasViewport, false, 'empty content must not count');
    });

    it('detectSoftwareSignals finds mentions in search results too', () => {
      const signals = detectSoftwareSignals({
        landingHtml: '',
        searchTexts: ['Acme lanza su API pública para desarrolladores'],
      });
      assert.deepEqual(signals.map((s) => s.id), ['api']);
      assert.equal(signals[0].source, 'search');
    });

    it('detectSoftwareSignals ignores application/* mime noise in raw html', () => {
      const signals = detectSoftwareSignals({
        landingHtml: '<script type="application/ld+json">{}</script><p>Solo texto plano</p>',
        searchTexts: [],
      });
      assert.deepEqual(signals, []);
    });
  });
});
