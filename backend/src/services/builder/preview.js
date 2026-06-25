'use strict';

/**
 * siraGPT Builder · E5 (preview seed) — self-contained HTML mockup.
 *
 * Turns a ProjectBrief + its blueprint into a single, dependency-free HTML
 * document that approximates how the app would look: themed palette, a nav
 * derived from the pages, a hero from the purpose/audience, and a card grid
 * for the screens. Pure and deterministic — no LLM, no network, no JS — so it
 * is safe to drop straight into an `<iframe srcdoc>` (sandboxed, scripts off).
 *
 * It is intentionally a *mockup*, not the real app: the live, runnable preview
 * (WebContainers / sandbox) is a later epic. This gives an instant visual.
 */

const { ProjectBriefSchema } = require('./contracts');
const { planFromBrief } = require('./blueprint');

// Theme keyword → palette. First keyword found in the brief's theme wins.
const THEMES = {
  oscuro: { bg: '#0b0f17', surface: '#141b27', text: '#eef2f7', sub: '#9aa7b8', primary: '#7c5cff', border: '#222c3a' },
  dark: { bg: '#0b0f17', surface: '#141b27', text: '#eef2f7', sub: '#9aa7b8', primary: '#7c5cff', border: '#222c3a' },
  minimalista: { bg: '#ffffff', surface: '#f7f7f8', text: '#111418', sub: '#6b7280', primary: '#111418', border: '#e7e8ea' },
  corporativo: { bg: '#f4f7fb', surface: '#ffffff', text: '#0f1b2d', sub: '#5b6b80', primary: '#1d4ed8', border: '#dde5ef' },
  colorido: { bg: '#fff7fb', surface: '#ffffff', text: '#1f1235', sub: '#6b5b80', primary: '#e0218a', border: '#f3d9e8' },
  moderno: { bg: '#0e1116', surface: '#171b22', text: '#f3f5f7', sub: '#9aa3ad', primary: '#22d3ee', border: '#252b34' },
};
const DEFAULT_THEME = { bg: '#0e1116', surface: '#171b22', text: '#f3f5f7', sub: '#9aa3ad', primary: '#7c5cff', border: '#252b34' };

function paletteFor(theme) {
  const raw = String(theme || '').toLowerCase();
  for (const key of Object.keys(THEMES)) {
    if (raw.includes(key)) return THEMES[key];
  }
  return DEFAULT_THEME;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A short, human app name derived from the purpose. */
function appName(brief) {
  const purpose = String(brief.purpose || '').trim();
  if (!purpose) return 'Mi App';
  const firstClause = purpose.split(/[.,;\n]/)[0].trim();
  const words = firstClause.split(/\s+/).slice(0, 4).join(' ');
  // Truncate by CODE POINT, not UTF-16 code unit — slicing at 38 units could cut
  // a surrogate pair (emoji) in half and emit a lone surrogate before the ellipsis.
  const chars = [...words];
  return chars.length > 38 ? `${chars.slice(0, 38).join('')}…` : words;
}

function navLinks(blueprint) {
  return blueprint.pages.slice(0, 5).map((p) => `<a>${escapeHtml(p.name)}</a>`).join('');
}

function pageCards(blueprint, pal) {
  return blueprint.pages
    .map(
      (p) => `
      <article class="card">
        <div class="thumb"></div>
        <h3>${escapeHtml(p.name)}</h3>
        <p>${escapeHtml(p.purpose)}</p>
        <div class="tags">${p.components
          .slice(0, 4)
          .map((c) => `<span>${escapeHtml(c)}</span>`)
          .join('')}</div>
      </article>`,
    )
    .join('');
}

function appShell(brief, blueprint, pal) {
  const name = escapeHtml(appName(brief));
  const cta = brief.platform === 'landing' ? 'Empezar gratis' : 'Entrar';
  return `
  <header class="nav">
    <div class="brand"><span class="dot"></span>${name}</div>
    <nav class="links">${navLinks(blueprint)}</nav>
    <button class="cta">${cta}</button>
  </header>
  <section class="hero">
    <span class="eyebrow">${escapeHtml(brief.platform.toUpperCase())}</span>
    <h1>${escapeHtml(brief.purpose || name)}</h1>
    <p class="lead">${escapeHtml(brief.audience ? `Para ${brief.audience}.` : 'Construido con siraGPT Builder.')}</p>
    <div class="hero-actions">
      <button class="cta lg">${cta}</button>
      <button class="ghost lg">Ver más</button>
    </div>
  </section>
  <section class="grid">${pageCards(blueprint, pal)}</section>
  <footer class="foot">${name} · ${escapeHtml(blueprint.stack.frontend)}</footer>`;
}

/**
 * Build a self-contained HTML preview from a ProjectBrief.
 * @param {object} rawBrief — must satisfy ProjectBriefSchema.
 * @returns {string} a complete HTML document (safe for iframe srcdoc).
 */
function buildPreviewHtml(rawBrief) {
  const parsed = ProjectBriefSchema.safeParse(rawBrief);
  if (!parsed.success) {
    throw new Error(`preview: invalid ProjectBrief: ${parsed.error.message}`);
  }
  const brief = parsed.data;
  const blueprint = planFromBrief(brief);
  const pal = paletteFor(brief.style && brief.style.theme);

  // Platform frame: mobile → phone, desktop → window chrome, web/landing → plain.
  const frameClass = brief.platform === 'mobile' ? 'mobile' : brief.platform === 'desktop' ? 'desktop' : 'web';
  const chrome =
    brief.platform === 'desktop'
      ? '<div class="winbar"><span></span><span></span><span></span></div>'
      : '';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(appName(brief))} — preview</title>
<style>
  :root{
    --bg:${pal.bg}; --surface:${pal.surface}; --text:${pal.text};
    --sub:${pal.sub}; --primary:${pal.primary}; --border:${pal.border};
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased;padding:24px}
  .frame{margin:0 auto;background:var(--bg);border:1px solid var(--border);
    border-radius:16px;overflow:hidden;box-shadow:0 30px 80px -40px rgba(0,0,0,.6)}
  .frame.web{max-width:980px}
  .frame.desktop{max-width:1040px}
  .frame.mobile{max-width:390px;border-radius:34px;padding:8px;background:var(--surface)}
  .frame.mobile .inner{border-radius:26px;overflow:hidden;background:var(--bg)}
  .winbar{display:flex;gap:7px;padding:10px 14px;background:var(--surface);border-bottom:1px solid var(--border)}
  .winbar span{width:11px;height:11px;border-radius:50%;background:var(--border)}
  .winbar span:first-child{background:#ff5f57}.winbar span:nth-child(2){background:#febc2e}.winbar span:nth-child(3){background:#28c840}
  .nav{display:flex;align-items:center;gap:16px;padding:14px 22px;border-bottom:1px solid var(--border);background:var(--surface)}
  .brand{display:flex;align-items:center;gap:8px;font-weight:700}
  .dot{width:14px;height:14px;border-radius:5px;background:var(--primary)}
  .links{display:flex;gap:16px;margin-left:8px;flex:1;flex-wrap:wrap}
  .links a{color:var(--sub);font-size:13px;cursor:pointer}
  .cta{background:var(--primary);color:#fff;border:0;border-radius:9px;padding:8px 14px;font-weight:600;font-size:13px;cursor:pointer}
  .ghost{background:transparent;color:var(--text);border:1px solid var(--border);border-radius:9px;padding:8px 14px;font-weight:600;font-size:13px;cursor:pointer}
  .lg{padding:12px 20px;font-size:15px}
  .hero{padding:56px 28px 40px;text-align:center}
  .eyebrow{font-size:11px;letter-spacing:.18em;color:var(--primary);font-weight:700}
  .hero h1{font-size:34px;line-height:1.08;margin:14px auto 10px;max-width:18ch}
  .lead{color:var(--sub);max-width:46ch;margin:0 auto 22px}
  .hero-actions{display:flex;gap:10px;justify-content:center}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding:8px 22px 30px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px}
  .thumb{height:84px;border-radius:9px;margin-bottom:12px;
    background:linear-gradient(135deg,var(--primary),transparent 70%),var(--bg);opacity:.9}
  .card h3{margin:0 0 4px;font-size:15px}
  .card p{margin:0 0 10px;color:var(--sub);font-size:13px}
  .tags{display:flex;flex-wrap:wrap;gap:5px}
  .tags span{font-size:10px;color:var(--sub);border:1px solid var(--border);border-radius:5px;padding:2px 6px;font-family:ui-monospace,monospace}
  .foot{padding:16px 22px;border-top:1px solid var(--border);color:var(--sub);font-size:12px;text-align:center;background:var(--surface)}
</style>
</head>
<body>
  <div class="frame ${frameClass}">
    ${chrome}
    <div class="inner">${appShell(brief, blueprint, pal)}</div>
  </div>
</body>
</html>`;
}

module.exports = { buildPreviewHtml, paletteFor, escapeHtml, appName };
