'use strict';

/**
 * siraGPT Builder · live-app.
 *
 * Generates a single, self-contained `index.html` that is a *working* app —
 * not a static mockup. It loads React 18 + Tailwind from CDN and ships a small
 * SPA with real navigation and a localStorage-backed CRUD per data entity, so
 * it RUNS as-is in the workspace live preview (an iframe that serves .html
 * verbatim) with zero npm/build. Deterministic and pure.
 *
 * The embedded app reads its data from `window.__APP__` (injected as JSON), so
 * no user text is ever interpolated into executable code — only into a JSON
 * blob — which keeps it injection-safe. The app logic itself is a static
 * string written with React.createElement (no JSX, no template literals) so it
 * can live inside this module's own string without escaping headaches.
 */

const { ProjectBriefSchema } = require('./contracts');
const { planFromBrief } = require('./blueprint');
const { paletteFor, appName } = require('./preview');

/** The static runtime — reads window.__APP__ and renders the SPA. */
const APP_RUNTIME = [
  'var APP = window.__APP__ || { name: "App", entities: [], purpose: "", audience: "", platform: "web" };',
  'var useState = React.useState, useEffect = React.useEffect, e = React.createElement;',
  'function load(key){ try { return JSON.parse(localStorage.getItem("sgpt:" + key) || "[]"); } catch (_) { return []; } }',
  'function save(key, rows){ try { localStorage.setItem("sgpt:" + key, JSON.stringify(rows)); } catch (_) {} }',
  'function Nav(props){',
  '  var items = ["Inicio"].concat(APP.entities.map(function(x){ return x.name; }));',
  '  return e("header", { className: "nav" },',
  '    e("div", { className: "brand" }, e("span", { className: "dot" }), APP.name),',
  '    e("nav", { className: "links" }, items.map(function(it){',
  '      return e("button", { key: it, className: "navlink" + (props.page === it ? " active" : ""), onClick: function(){ props.setPage(it); } }, it);',
  '    }))',
  '  );',
  '}',
  'function Home(props){',
  '  return e("section", { className: "wrap" },',
  '    e("span", { className: "eyebrow" }, String(APP.platform || "").toUpperCase()),',
  '    e("h1", { className: "h1" }, APP.purpose || APP.name),',
  '    e("p", { className: "lead" }, APP.audience ? ("Para " + APP.audience + ".") : "Construido con siraGPT Builder."),',
  '    e("div", { className: "grid" }, APP.entities.map(function(x){',
  '      return e("div", { key: x.name, className: "card", onClick: function(){ props.setPage(x.name); } },',
  '        e("h3", null, x.name),',
  '        e("p", { className: "muted" }, "Gestionar " + x.name)',
  '      );',
  '    }))',
  '  );',
  '}',
  'function Entity(props){',
  '  var ent = props.entity;',
  '  var fields = ent.fields.filter(function(f){ return !/(^|_)id$|created/i.test(f.name); });',
  '  var rs = useState(function(){ return load(ent.name); }); var rows = rs[0], setRows = rs[1];',
  '  var fs = useState({}); var form = fs[0], setForm = fs[1];',
  '  function add(){ var rec = Object.assign({ _id: Date.now() }, form); var next = rows.concat([rec]); setRows(next); save(ent.name, next); setForm({}); }',
  '  function del(id){ var next = rows.filter(function(r){ return r._id !== id; }); setRows(next); save(ent.name, next); }',
  '  return e("section", { className: "wrap" },',
  '    e("h2", { className: "h2" }, ent.name),',
  '    e("div", { className: "form" },',
  '      fields.map(function(f){',
  '        return e("input", { key: f.name, className: "inp", placeholder: f.name, value: form[f.name] || "",',
  '          onChange: function(ev){ var v = ev.target.value; setForm(function(p){ var n = Object.assign({}, p); n[f.name] = v; return n; }); } });',
  '      }),',
  '      e("button", { className: "btn", onClick: add }, "Anadir")',
  '    ),',
  '    e("div", { className: "list" }, rows.length === 0',
  '      ? e("p", { className: "muted" }, "Sin registros todavia.")',
  '      : rows.map(function(r){',
  '          return e("div", { key: r._id, className: "row" },',
  '            e("span", null, fields.map(function(f){ return r[f.name]; }).filter(Boolean).join("  -  ") || "(vacio)"),',
  '            e("button", { className: "del", onClick: function(){ del(r._id); } }, "x")',
  '          );',
  '        })',
  '    )',
  '  );',
  '}',
  'function Root(){',
  '  var ps = useState("Inicio"); var page = ps[0], setPage = ps[1];',
  '  var ent = APP.entities.filter(function(x){ return x.name === page; })[0];',
  '  return e("div", null,',
  '    e(Nav, { page: page, setPage: setPage }),',
  '    page === "Inicio" ? e(Home, { setPage: setPage }) : (ent ? e(Entity, { entity: ent }) : e(Home, { setPage: setPage }))',
  '  );',
  '}',
  'ReactDOM.createRoot(document.getElementById("root")).render(e(Root));',
].join('\n');

function styles(pal) {
  return [
    '*{box-sizing:border-box}',
    'body{margin:0;background:' + pal.bg + ';color:' + pal.text + ';font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '.nav{display:flex;align-items:center;gap:16px;padding:14px 22px;border-bottom:1px solid ' + pal.border + ';background:' + pal.surface + ';position:sticky;top:0}',
    '.brand{display:flex;align-items:center;gap:8px;font-weight:700}',
    '.dot{width:14px;height:14px;border-radius:5px;background:' + pal.primary + ';display:inline-block}',
    '.links{display:flex;gap:6px;flex-wrap:wrap}',
    '.navlink{background:transparent;border:0;color:' + pal.sub + ';font-size:13px;padding:6px 10px;border-radius:8px;cursor:pointer}',
    '.navlink.active{background:' + pal.primary + ';color:#fff}',
    '.wrap{max-width:880px;margin:0 auto;padding:32px 22px}',
    '.eyebrow{font-size:11px;letter-spacing:.18em;color:' + pal.primary + ';font-weight:700}',
    '.h1{font-size:34px;line-height:1.1;margin:10px 0 8px}',
    '.h2{font-size:24px;margin:0 0 16px}',
    '.lead{color:' + pal.sub + ';margin:0 0 24px}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}',
    '.card{background:' + pal.surface + ';border:1px solid ' + pal.border + ';border-radius:14px;padding:16px;cursor:pointer;transition:transform .15s}',
    '.card:hover{transform:translateY(-2px)}',
    '.card h3{margin:0 0 4px}',
    '.muted{color:' + pal.sub + ';font-size:13px}',
    '.form{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}',
    '.inp{background:' + pal.bg + ';border:1px solid ' + pal.border + ';color:' + pal.text + ';border-radius:9px;padding:9px 11px;font-size:14px;min-width:140px}',
    '.btn{background:' + pal.primary + ';color:#fff;border:0;border-radius:9px;padding:9px 16px;font-weight:600;cursor:pointer}',
    '.list{display:flex;flex-direction:column;gap:8px}',
    '.row{display:flex;align-items:center;justify-content:space-between;background:' + pal.surface + ';border:1px solid ' + pal.border + ';border-radius:10px;padding:10px 14px}',
    '.del{background:transparent;border:0;color:' + pal.sub + ';font-size:18px;cursor:pointer;line-height:1}',
  ].join('\n');
}

/**
 * Build a runnable single-file app (index.html) from a ProjectBrief.
 * @param {object} rawBrief — must satisfy ProjectBriefSchema.
 * @param {object} [blueprint] — reuse a precomputed plan; derived if omitted.
 * @returns {string} a complete HTML document that runs in the live preview.
 */
function buildLiveApp(rawBrief, blueprint) {
  const parsed = ProjectBriefSchema.safeParse(rawBrief);
  if (!parsed.success) {
    throw new Error(`live-app: invalid ProjectBrief: ${parsed.error.message}`);
  }
  const brief = parsed.data;
  const plan = blueprint || planFromBrief(brief);
  const pal = paletteFor(brief.style && brief.style.theme);

  const data = {
    name: appName(brief),
    purpose: brief.purpose || '',
    audience: brief.audience || '',
    platform: brief.platform,
    entities: plan.dataModel.map((m) => ({
      name: m.entity,
      fields: m.fields.map((f) => ({ name: f.name, type: f.type })),
    })),
  };

  // JSON.stringify is injection-safe here, but escape "<" so a value like
  // "</script>" can't break out of the data <script> tag.
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');

  return [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>' + data.name.replace(/[<>&"]/g, '') + '</title>',
    '<script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>',
    '<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>',
    '<style>',
    styles(pal),
    '</style>',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    '<script>window.__APP__ = ' + dataJson + ';</script>',
    '<script>',
    APP_RUNTIME,
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
}

module.exports = { buildLiveApp };
