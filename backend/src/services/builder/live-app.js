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
 *
 * When the data model looks like a store (a product entity + a sale entity),
 * the app also renders a real "Punto de venta" screen: a product picker, a
 * cart with quantity controls, a live total, and a "Cobrar" action that writes
 * a sale into localStorage and decrements stock — still 100% client-side.
 */

const { ProjectBriefSchema } = require('./contracts');
const { planFromBrief } = require('./blueprint');
const { paletteFor, appName } = require('./preview');

/** The static runtime — reads window.__APP__ and renders the SPA. */
const APP_RUNTIME = [
  'var APP = window.__APP__ || { name: "App", entities: [], purpose: "", audience: "", platform: "web", pos: { enabled: false } };',
  'if (!APP.pos) APP.pos = { enabled: false };',
  'var useState = React.useState, useEffect = React.useEffect, e = React.createElement;',
  'function load(key){ try { return JSON.parse(localStorage.getItem("sgpt:" + key) || "[]"); } catch (_) { return []; } }',
  'function save(key, rows){ try { localStorage.setItem("sgpt:" + key, JSON.stringify(rows)); } catch (_) {} }',
  'function money(n){ var x = Number(n); if (!isFinite(x)) x = 0; return x.toFixed(2); }',
  'function priceOf(p){ var f = APP.pos.priceField; var raw = f ? p[f] : 0; var x = parseFloat(String(raw == null ? 0 : raw).replace(",", ".")); return isFinite(x) ? x : 0; }',
  'function POS_NAV(){ return APP.pos && APP.pos.enabled ? "Punto de venta" : null; }',
  'function Nav(props){',
  '  var items = ["Inicio"];',
  '  if (POS_NAV()) items.push(POS_NAV());',
  '  items = items.concat(APP.entities.map(function(x){ return x.name; }));',
  '  return e("header", { className: "nav" },',
  '    e("div", { className: "brand" }, e("span", { className: "dot" }), APP.name),',
  '    e("nav", { className: "links" }, items.map(function(it){',
  '      return e("button", { key: it, className: "navlink" + (props.page === it ? " active" : ""), onClick: function(){ props.setPage(it); } }, it);',
  '    }))',
  '  );',
  '}',
  'function Home(props){',
  '  var cards = [];',
  '  if (POS_NAV()) {',
  '    cards.push(e("div", { key: "__pos", className: "card", onClick: function(){ props.setPage(POS_NAV()); } },',
  '      e("h3", null, "Punto de venta"),',
  '      e("p", { className: "muted" }, "Cobrar y registrar ventas")',
  '    ));',
  '  }',
  '  APP.entities.forEach(function(x){',
  '    cards.push(e("div", { key: x.name, className: "card", onClick: function(){ props.setPage(x.name); } },',
  '      e("h3", null, x.name),',
  '      e("p", { className: "muted" }, "Gestionar " + x.name)',
  '    ));',
  '  });',
  '  return e("section", { className: "wrap" },',
  '    e("span", { className: "eyebrow" }, String(APP.platform || "").toUpperCase()),',
  '    e("h1", { className: "h1" }, APP.purpose || APP.name),',
  '    e("p", { className: "lead" }, APP.audience ? ("Para " + APP.audience + ".") : "Construido con siraGPT Builder."),',
  '    e("div", { className: "grid" }, cards)',
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
  'function Pos(){',
  '  var pos = APP.pos;',
  '  var prodS = useState(function(){ return load(pos.productKey); }); var products = prodS[0], setProducts = prodS[1];',
  '  var cartS = useState([]); var cart = cartS[0], setCart = cartS[1];',
  '  var custS = useState(""); var customer = custS[0], setCustomer = custS[1];',
  '  var msgS = useState(""); var msg = msgS[0], setMsg = msgS[1];',
  '  function nameOf(p){ return (pos.nameField && p[pos.nameField]) ? p[pos.nameField] : ("#" + p._id); }',
  '  function addToCart(p){',
  '    setMsg("");',
  '    setCart(function(c){',
  '      var found = c.filter(function(x){ return x._id === p._id; })[0];',
  '      if (found) { return c.map(function(x){ return x._id === p._id ? Object.assign({}, x, { qty: x.qty + 1 }) : x; }); }',
  '      return c.concat([{ _id: p._id, nombre: nameOf(p), precio: priceOf(p), qty: 1 }]);',
  '    });',
  '  }',
  '  function setQty(id, q){ q = Math.max(0, q); setCart(function(c){ return c.map(function(x){ return x._id === id ? Object.assign({}, x, { qty: q }) : x; }).filter(function(x){ return x.qty > 0; }); }); }',
  '  function removeLine(id){ setCart(function(c){ return c.filter(function(x){ return x._id !== id; }); }); }',
  '  var total = cart.reduce(function(s, x){ return s + x.precio * x.qty; }, 0);',
  '  function checkout(){',
  '    if (cart.length === 0) { setMsg("Agrega productos al carrito."); return; }',
  '    var sale = { _id: Date.now() };',
  '    sale[pos.saleCustomerField] = customer || "Mostrador";',
  '    sale[pos.saleDateField] = new Date().toISOString().slice(0, 10);',
  '    sale[pos.saleTotalField] = money(total);',
  '    sale.items = cart.map(function(x){ return x.qty + "x " + x.nombre; }).join(", ");',
  '    var sales = load(pos.saleKey); sales.push(sale); save(pos.saleKey, sales);',
  '    if (pos.stockField) {',
  '      var updated = products.map(function(p){',
  '        var line = cart.filter(function(x){ return x._id === p._id; })[0];',
  '        if (!line) return p;',
  '        var n = Object.assign({}, p); var cur = parseInt(p[pos.stockField], 10); if (!isFinite(cur)) cur = 0;',
  '        n[pos.stockField] = Math.max(0, cur - line.qty); return n;',
  '      });',
  '      setProducts(updated); save(pos.productKey, updated);',
  '    }',
  '    setCart([]); setCustomer(""); setMsg("Venta registrada por " + money(total) + ".");',
  '  }',
  '  return e("section", { className: "wrap" },',
  '    e("h2", { className: "h2" }, "Punto de venta"),',
  '    msg ? e("div", { className: "toast" }, msg) : null,',
  '    e("div", { className: "pos" },',
  '      e("div", { className: "pos-products" }, products.length === 0',
  '        ? e("p", { className: "muted" }, "No hay productos. Agregalos en la pestana " + pos.productKey + ".")',
  '        : products.map(function(p){',
  '            var st = pos.stockField != null ? p[pos.stockField] : null;',
  '            return e("button", { key: p._id, className: "pos-item", onClick: function(){ addToCart(p); } },',
  '              e("span", { className: "pos-item-name" }, nameOf(p)),',
  '              e("span", { className: "pos-item-meta" }, money(priceOf(p)) + (st != null && st !== "" ? ("  -  stock " + st) : ""))',
  '            );',
  '          })',
  '      ),',
  '      e("div", { className: "pos-cart" },',
  '        e("h3", { className: "pos-cart-title" }, "Carrito"),',
  '        cart.length === 0 ? e("p", { className: "muted" }, "Carrito vacio.") : cart.map(function(x){',
  '          return e("div", { key: x._id, className: "cart-row" },',
  '            e("span", { className: "cart-name" }, x.nombre),',
  '            e("div", { className: "qty" },',
  '              e("button", { className: "qbtn", onClick: function(){ setQty(x._id, x.qty - 1); } }, "-"),',
  '              e("span", { className: "qnum" }, x.qty),',
  '              e("button", { className: "qbtn", onClick: function(){ setQty(x._id, x.qty + 1); } }, "+")',
  '            ),',
  '            e("span", { className: "cart-sub" }, money(x.precio * x.qty)),',
  '            e("button", { className: "del", onClick: function(){ removeLine(x._id); } }, "x")',
  '          );',
  '        }),',
  '        e("input", { className: "inp pos-cust", placeholder: "Cliente (opcional)", value: customer, onChange: function(ev){ setCustomer(ev.target.value); } }),',
  '        e("div", { className: "pos-total" }, e("span", null, "Total"), e("strong", null, money(total))),',
  '        e("button", { className: "btn pos-pay", onClick: checkout }, "Cobrar")',
  '      )',
  '    )',
  '  );',
  '}',
  'function Root(){',
  '  var ps = useState("Inicio"); var page = ps[0], setPage = ps[1];',
  '  var ent = APP.entities.filter(function(x){ return x.name === page; })[0];',
  '  var body;',
  '  if (page === "Inicio") body = e(Home, { setPage: setPage });',
  '  else if (page === "Punto de venta" && APP.pos && APP.pos.enabled) body = e(Pos, null);',
  '  else if (ent) body = e(Entity, { entity: ent });',
  '  else body = e(Home, { setPage: setPage });',
  '  return e("div", null, e(Nav, { page: page, setPage: setPage }), body);',
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
    '.toast{background:' + pal.primary + ';color:#fff;border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:14px;font-weight:600}',
    '.pos{display:grid;grid-template-columns:1fr 320px;gap:18px;align-items:start}',
    '@media(max-width:720px){.pos{grid-template-columns:1fr}}',
    '.pos-products{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}',
    '.pos-item{display:flex;flex-direction:column;gap:6px;text-align:left;background:' + pal.surface + ';border:1px solid ' + pal.border + ';color:' + pal.text + ';border-radius:12px;padding:12px;cursor:pointer;transition:transform .12s}',
    '.pos-item:hover{transform:translateY(-2px)}',
    '.pos-item-name{font-weight:600;font-size:14px}',
    '.pos-item-meta{color:' + pal.sub + ';font-size:12px}',
    '.pos-cart{background:' + pal.surface + ';border:1px solid ' + pal.border + ';border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px;position:sticky;top:84px}',
    '.pos-cart-title{margin:0 0 4px;font-size:16px}',
    '.cart-row{display:grid;grid-template-columns:1fr auto auto auto;align-items:center;gap:8px;font-size:13px}',
    '.cart-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.qty{display:flex;align-items:center;gap:6px}',
    '.qbtn{width:24px;height:24px;border-radius:7px;border:1px solid ' + pal.border + ';background:' + pal.bg + ';color:' + pal.text + ';cursor:pointer;line-height:1;font-size:15px}',
    '.qnum{min-width:18px;text-align:center}',
    '.cart-sub{font-variant-numeric:tabular-nums}',
    '.pos-cust{width:100%}',
    '.pos-total{display:flex;align-items:center;justify-content:space-between;border-top:1px solid ' + pal.border + ';padding-top:10px;font-size:18px}',
    '.pos-pay{width:100%}',
  ].join('\n');
}

// Detect a store-shaped data model and build the POS configuration consumed by
// the runtime's <Pos> component. Returns { enabled:false } unless there is a
// product-like entity (a sale-like entity is preferred but optional). All field
// picks come straight from the entity's own field names, so the POS adapts to
// whatever the brief produced.
function posConfig(entities) {
  const productEnt = entities.find((x) => /producto|product|articulo|item|plato|prenda|menu|mercanc|bebida/i.test(x.name));
  if (!productEnt) return { enabled: false };
  const saleEnt = entities.find((x) => /venta|sale|pedido|orden|order|ticket|factura|cobro/i.test(x.name));

  const pf = productEnt.fields.map((f) => f.name);
  const pick = (re, fallback) => pf.find((n) => re.test(n)) || fallback;
  const priceField = pick(/precio|price|costo|monto|valor|importe/i, null);
  if (!priceField) return { enabled: false }; // a POS needs a price to total.

  const sf = saleEnt ? saleEnt.fields.map((f) => f.name) : [];
  const spick = (re, fallback) => sf.find((n) => re.test(n)) || fallback;

  return {
    enabled: true,
    productKey: productEnt.name,
    nameField: pick(/nombre|name|titulo|producto|plato|descrip/i, pf[0] || null),
    priceField,
    stockField: pick(/stock|cantidad|existencia|inventario|qty|unidades/i, null),
    saleKey: saleEnt ? saleEnt.name : 'Ventas',
    saleTotalField: spick(/total|monto|importe|precio/i, 'total'),
    saleDateField: spick(/fecha|date|dia|_at/i, 'fecha'),
    saleCustomerField: spick(/cliente|customer|nombre/i, 'cliente'),
  };
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

  const entities = plan.dataModel.map((m) => ({
    name: m.entity,
    fields: m.fields.map((f) => ({ name: f.name, type: f.type })),
  }));

  const data = {
    name: appName(brief),
    purpose: brief.purpose || '',
    audience: brief.audience || '',
    platform: brief.platform,
    entities,
    pos: posConfig(entities),
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

module.exports = { buildLiveApp, posConfig };
