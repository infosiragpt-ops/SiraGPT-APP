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

function isCafeShowcase(brief, entities) {
  if (entities.length > 0) return false;
  return /\b(cafeter[ií]a|cafe|coffee|barista|espresso|latte|brunch|panader[ií]a)\b/i.test(
    `${brief.purpose || ''} ${brief.style && brief.style.theme ? brief.style.theme : ''}`,
  );
}

function buildCafeShowcase(brief) {
  const name = 'Cafetería Aurora';
  const title = brief.purpose || 'Cafetería de especialidad con menú artesanal, reservas y ubicación';
  return [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>' + name + '</title>',
    '<style>',
    '*{box-sizing:border-box}',
    'html{scroll-behavior:smooth}',
    'body{margin:0;background:#0f1110;color:#f7f3ea;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    'a{color:inherit;text-decoration:none}',
    '.nav{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:16px clamp(18px,5vw,64px);border-bottom:1px solid rgba(255,255,255,.08);background:rgba(15,17,16,.84);backdrop-filter:blur(18px)}',
    '.brand{display:flex;align-items:center;gap:10px;font-weight:760;letter-spacing:.01em}.mark{width:12px;height:24px;border-radius:999px;background:#2dd4bf;box-shadow:0 0 32px rgba(45,212,191,.45)}',
    '.links{display:flex;gap:18px;color:#b7afa3;font-size:14px}.links a:hover{color:#f7f3ea}',
    '.btn{border:0;border-radius:999px;background:#2dd4bf;color:#07110f;padding:11px 17px;font-weight:750;cursor:pointer}',
    '.ghost{border:1px solid rgba(255,255,255,.14);background:transparent;color:#f7f3ea}',
    '.hero{display:grid;grid-template-columns:minmax(0,1.02fr) minmax(320px,.98fr);gap:clamp(26px,5vw,64px);align-items:center;min-height:calc(100vh - 68px);padding:clamp(42px,7vw,88px) clamp(18px,5vw,64px) 56px}',
    '.eyebrow{color:#2dd4bf;font-size:12px;font-weight:800;letter-spacing:.22em;text-transform:uppercase}',
    'h1{font-size:clamp(44px,7.2vw,92px);line-height:.94;letter-spacing:-.04em;margin:16px 0 18px;max-width:10.2ch}',
    '.lead{max-width:55ch;color:#c8c0b4;font-size:clamp(17px,2vw,20px);line-height:1.6;margin:0 0 28px}',
    '.actions{display:flex;flex-wrap:wrap;gap:12px}.stats{display:flex;flex-wrap:wrap;gap:10px;margin-top:32px}.stat{border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:13px 15px;background:#171a17}.stat strong{display:block;font-size:18px}.stat span{color:#b7afa3;font-size:12px}',
    '.photo{position:relative;min-height:560px;border-radius:28px;overflow:hidden;border:1px solid rgba(255,255,255,.1);background:#171a17}.photo img{width:100%;height:100%;position:absolute;inset:0;object-fit:cover;filter:saturate(.95) contrast(1.02)}.photo:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 34%,rgba(15,17,16,.72))}.photo-card{position:absolute;left:22px;right:22px;bottom:22px;z-index:1;border:1px solid rgba(255,255,255,.12);border-radius:22px;background:rgba(15,17,16,.76);backdrop-filter:blur(14px);padding:20px}.photo-card h2{margin:0 0 8px;font-size:22px}.photo-card p{margin:0;color:#c8c0b4;line-height:1.5}',
    '.section{padding:68px clamp(18px,5vw,64px);border-top:1px solid rgba(255,255,255,.08)}.section-head{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:22px}.section h2{font-size:clamp(30px,4vw,48px);letter-spacing:-.03em;margin:0}.section p{color:#b7afa3}',
    '.menu{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.item{border:1px solid rgba(255,255,255,.1);background:#171a17;border-radius:22px;padding:20px}.item img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:16px;margin-bottom:16px}.item h3{display:flex;justify-content:space-between;gap:16px;margin:0 0 8px;font-size:20px}.item p{margin:0;line-height:1.5}',
    '.split{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel{border:1px solid rgba(255,255,255,.1);background:#171a17;border-radius:24px;padding:26px}.panel h3{margin:0 0 10px;font-size:24px}.panel p{line-height:1.6}.hours{display:grid;gap:10px;margin-top:18px}.hours div{display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:10px;color:#c8c0b4}',
    'footer{padding:26px clamp(18px,5vw,64px);display:flex;justify-content:space-between;gap:16px;color:#b7afa3;border-top:1px solid rgba(255,255,255,.08)}',
    '@media(max-width:900px){.hero,.split{grid-template-columns:1fr}.photo{min-height:420px}.menu{grid-template-columns:1fr}.links{display:none}footer{flex-direction:column}h1{max-width:11ch}}',
    '</style>',
    '</head>',
    '<body>',
    '<header class="nav"><a class="brand" href="#inicio"><span class="mark"></span>' + name + '</a><nav class="links"><a href="#menu">Menu</a><a href="#experiencia">Experiencia</a><a href="#visitanos">Ubicación</a></nav><a class="btn" href="#visitanos">Reservar mesa</a></header>',
    '<main id="inicio" class="hero"><section><span class="eyebrow">Cafe de especialidad</span><h1>' + title + '</h1><p class="lead">Un espacio cálido para desayunos, brunch y café filtrado con granos seleccionados. Diseño listo para presentar menú, horarios, reservas y ubicación desde el primer preview.</p><div class="actions"><a class="btn" href="#menu">Ver menú</a><a class="btn ghost" href="#visitanos">Cómo llegar</a></div><div class="stats"><div class="stat"><strong>07:30</strong><span>abre todos los días</span></div><div class="stat"><strong>18+</strong><span>bebidas y postres</span></div><div class="stat"><strong>4.9</strong><span>experiencia promedio</span></div></div></section><aside class="photo"><img alt="Café servido en barra de cafetería" src="https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=1400&q=80"><div class="photo-card"><h2>Brunch, espresso y panadería fresca</h2><p>Hero visual, CTA claro y secciones listas para editar desde el agente.</p></div></aside></main>',
    '<section id="menu" class="section"><div class="section-head"><div><span class="eyebrow">Menu</span><h2>Favoritos de la casa</h2></div><p>Precios, descripciones y fotos listos para reemplazar.</p></div><div class="menu"><article class="item"><img alt="Latte artesanal" src="https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=900&q=80"><h3>Latte Aurora <span>$4.90</span></h3><p>Espresso doble, leche texturizada y notas de cacao.</p></article><article class="item"><img alt="Croissant y café" src="https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=900&q=80"><h3>Croissant brunch <span>$7.50</span></h3><p>Horneado del día con mantequilla, queso y mermelada.</p></article><article class="item"><img alt="Cold brew" src="https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=900&q=80"><h3>Cold brew <span>$5.20</span></h3><p>Extracción lenta, cítricos suaves y final limpio.</p></article></div></section>',
    '<section id="experiencia" class="section"><div class="split"><article class="panel"><span class="eyebrow">Ambiente</span><h3>Minimalista, cómodo y profesional</h3><p>La web vende la experiencia: buena tipografía, fotos reales, tarjetas de menú, CTA de reserva y contenido escaneable en desktop y celular.</p></article><article class="panel"><span class="eyebrow">Servicios</span><h3>Para llevar, mesas y eventos pequeños</h3><p>Incluye bloques para desayuno, reuniones, café para llevar y contacto directo. El agente puede seguir editando colores, menú o secciones.</p></article></div></section>',
    '<section id="visitanos" class="section"><div class="split"><article class="panel"><span class="eyebrow">Ubicación</span><h3>Av. Central 248, Centro</h3><p>Reserva por WhatsApp o visítanos sin cita. Esta sección queda lista para mapa, teléfono y redes.</p><div class="actions"><a class="btn" href="tel:+100000000">Llamar</a><a class="btn ghost" href="mailto:hola@cafeteria.test">Escribir</a></div></article><article class="panel"><span class="eyebrow">Horarios</span><h3>Abierto todos los días</h3><div class="hours"><div><span>Lunes a viernes</span><strong>07:30 - 20:00</strong></div><div><span>Sábado</span><strong>08:00 - 21:00</strong></div><div><span>Domingo</span><strong>08:30 - 18:00</strong></div></div></article></div></section>',
    '</main><footer><span>' + name + '</span><span>Web responsive generada por siraGPT Builder</span></footer>',
    '</body>',
    '</html>',
  ].join('\n');
}

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

  if (isCafeShowcase(brief, entities)) {
    return buildCafeShowcase(brief);
  }

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
