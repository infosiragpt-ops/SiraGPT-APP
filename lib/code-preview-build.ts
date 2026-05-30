/**
 * code-preview-build — turn the in-memory workspace files into a single
 * self-contained HTML document that an embedded <iframe> can render live.
 *
 * Supported project kinds (detected from the active file first, then the
 * project as a whole):
 *   · html      → multi-file static site (local <link>/<script> inlined)
 *   · react     → single-scope JSX/TSX bundle via Babel standalone (the
 *                 artifact-sandbox technique, generalised to many files)
 *   · markdown  → rendered with marked from CDN
 *   · svg       → rendered centered
 *   · unsupported / empty → friendly placeholder
 *
 * The document is sandboxed by the caller (sandbox="allow-scripts", null
 * origin). A console bridge forwards console.* + errors to the parent via
 * postMessage so the preview pane can show a live console.
 */

import type { CodeFiles } from "./code-workspace-utils"

export type PreviewKind = "html" | "react" | "markdown" | "svg" | "unsupported" | "empty"

export type PreviewResult = {
  html: string
  kind: PreviewKind
  /** Logical entry path shown in the preview URL pill. */
  entry: string | null
  /** Optional human note for unsupported/empty states. */
  note?: string
}

function ext(path: string): string {
  const i = path.lastIndexOf(".")
  return i >= 0 ? path.slice(i + 1).toLowerCase() : ""
}

function stripLead(p: string): string {
  return p.replace(/^\.?\//, "").replace(/^\//, "")
}

const JS_EXTS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs"])

// Forwarded into every previewed document — captures console + errors and
// posts them to the parent window. Uses string concat (no backticks) so it
// stays safe inside this module's template literals.
const CONSOLE_BRIDGE = `<script>
(function(){
  function ser(a){try{if(a instanceof Error)return a.stack||a.message;return typeof a==='object'?JSON.stringify(a):String(a)}catch(e){return String(a)}}
  function send(level,args){try{parent.postMessage({type:'sgpt-preview-console',level:level,text:Array.prototype.map.call(args,ser).join(' ')},'*')}catch(e){}}
  ['log','info','warn','error','debug'].forEach(function(k){var o=console[k]?console[k].bind(console):function(){};console[k]=function(){send(k,arguments);o.apply(null,arguments)}});
  window.addEventListener('error',function(e){send('error',[(e.message||'Error')+' ('+(e.filename||'preview').split('/').pop()+':'+e.lineno+')'])});
  window.addEventListener('unhandledrejection',function(e){send('error',['Unhandled rejection: '+ser(e.reason)])});
})();
</script>`

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Resolve a path referenced from HTML against the workspace file map. */
function findFile(files: CodeFiles, ref: string): string | null {
  const want = stripLead(ref.split("?")[0].split("#")[0])
  if (files[want]) return want
  for (const key of Object.keys(files)) {
    if (stripLead(key) === want || key.endsWith("/" + want)) return key
  }
  return null
}

function buildHtmlDocument(files: CodeFiles, entry: string): string {
  let html = files[entry]?.content ?? ""

  // Inline local stylesheets: <link rel="stylesheet" href="styles.css">
  html = html.replace(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi, (m, href) => {
    if (/^https?:|^\/\//i.test(href)) return m
    const f = findFile(files, href)
    if (!f) return m
    return `<style data-src="${escapeHtml(f)}">\n${files[f].content}\n</style>`
  })

  // Inline local scripts: <script src="app.js"></script>
  html = html.replace(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (m, src) => {
    if (/^https?:|^\/\//i.test(src)) return m
    const f = findFile(files, src)
    if (!f) return m
    const safe = files[f].content.replace(/<\/script/gi, "<\\/script")
    return `<script data-src="${escapeHtml(f)}">\n${safe}\n</script>`
  })

  // Inject the console bridge as early as possible.
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${CONSOLE_BRIDGE}`)
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html[^>]*>/i, (m) => `${m}\n${CONSOLE_BRIDGE}`)
  } else {
    html = `${CONSOLE_BRIDGE}\n${html}`
  }
  return html
}

// Remove ESM import/export so every module shares one global scope (a
// pragmatic single-bundle that covers most small components-by-name apps).
function stripModuleSyntax(code: string): string {
  return code
    .replace(/^\s*import\s+type\s+[^\n]*$/gm, "")
    .replace(/^\s*import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"]\s*;?\s*$/gm, "")
    .replace(/^\s*import\s+[\w*\s,{}]*\s+from\s*['"][^'"]+['"]\s*;?\s*$/gm, "")
    .replace(/^\s*import\s+['"][^'"]+['"]\s*;?\s*$/gm, "")
    .replace(/export\s+default\s+(function|class)/g, "$1")
    .replace(/export\s+default\s+/g, "window.__sgpt_default = ")
    .replace(/export\s+(const|let|var|async\s+function|function|class)/g, "$1")
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "")
}

function buildReactDocument(files: CodeFiles, entry: string | null): string {
  const jsPaths = Object.keys(files).filter((p) => JS_EXTS.has(ext(p)))
  // Order: dependencies first, entry last, so component consts are defined
  // before the entry renders them.
  const ordered = jsPaths
    .filter((p) => p !== entry)
    .sort((a, b) => a.localeCompare(b))
  if (entry) ordered.push(entry)

  const bundle = ordered
    .map((p) => `// ── ${p} ──\n${stripModuleSyntax(files[p].content)}`)
    .join("\n\n")
    .replace(/<\/script/gi, "<\\/script")

  const footer = `
const __sgptTarget = (typeof App !== 'undefined' && App)
  || window.__sgpt_default
  || (typeof Page !== 'undefined' && Page)
  || (typeof Main !== 'undefined' && Main)
  || null;
try {
  if (!__sgptTarget) throw new Error('No se encontró un componente para renderizar. Define App() o usa export default.');
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(React.createElement(__sgptTarget));
} catch (e) {
  const el = document.getElementById('root');
  if (el) el.innerHTML = '<pre style="color:#e11d48;padding:16px;font:12px ui-monospace,monospace;white-space:pre-wrap">' + String((e && e.stack) || e) + '</pre>';
  console.error(e);
}`.trim()

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${CONSOLE_BRIDGE}
<script src="https://cdn.tailwindcss.com"></script>
<style>
  html,body{margin:0;padding:0;background:#fff;font-family:Inter,system-ui,sans-serif}
  #root{min-height:100vh}
  *:focus-visible{outline:2px solid #6366f1;outline-offset:2px;border-radius:4px}
</style>
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://unpkg.com/lodash/lodash.min.js"></script>
<script src="https://unpkg.com/recharts/umd/Recharts.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<script src="https://unpkg.com/lucide@latest"></script>
<script src="https://unpkg.com/framer-motion@11/dist/framer-motion.js"></script>
</head>
<body>
<div id="root"></div>
<script type="text/babel" data-presets="react,typescript">
const { useState, useEffect, useMemo, useRef, useCallback, useReducer, useContext, useLayoutEffect, Fragment, createContext } = React;
const _ = window._;
const Recharts = window.Recharts;
const d3 = window.d3;
const lucide = window.lucide;
const motion = (window.Motion && window.Motion.motion) || undefined;
const AnimatePresence = (window.Motion && window.Motion.AnimatePresence) || (function(p){ return p.children; });

// ── workspace bundle ──
${bundle}

${footer}
</script>
</body>
</html>`
}

function buildMarkdownDocument(files: CodeFiles, entry: string): string {
  const raw = files[entry]?.content ?? ""
  const json = JSON.stringify(raw)
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${CONSOLE_BRIDGE}
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
  body{margin:0;background:#fff;color:#111;font-family:Inter,system-ui,sans-serif;line-height:1.65}
  .doc{max-width:760px;margin:0 auto;padding:40px 28px}
  .doc pre{background:#f4f4f5;padding:14px;border-radius:10px;overflow:auto}
  .doc code{font-family:ui-monospace,monospace;font-size:.9em}
  .doc h1,.doc h2,.doc h3{line-height:1.25}
  .doc img{max-width:100%}
  .doc a{color:#4f46e5}
  .doc table{border-collapse:collapse}.doc td,.doc th{border:1px solid #e4e4e7;padding:6px 10px}
</style>
</head>
<body>
<div class="doc" id="doc"></div>
<script>
  try { document.getElementById('doc').innerHTML = marked.parse(${json}); }
  catch (e) { document.getElementById('doc').textContent = ${json}; console.error(e); }
</script>
</body>
</html>`
}

function buildSvgDocument(files: CodeFiles, entry: string): string {
  const svg = files[entry]?.content ?? ""
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8" />${CONSOLE_BRIDGE}
<style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;background:#fafafa}svg{max-width:96vw;max-height:96vh}</style>
</head><body>${svg}</body></html>`
}

function placeholder(note: string): string {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8" />
<style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;background:#0b0b0c;color:#a1a1aa;font-family:Inter,system-ui,sans-serif}
.box{max-width:380px;text-align:center;padding:24px;line-height:1.6}.box svg{opacity:.4}</style></head>
<body><div class="box"><div style="font-size:13px">${escapeHtml(note)}</div></div></body></html>`
}

/** Pick the best entry + kind given the active file and the whole project. */
export function buildPreviewDocument(files: CodeFiles, activePath: string | null): PreviewResult {
  const paths = Object.keys(files)
  if (paths.length === 0) return { html: placeholder("Aún no hay archivos. Empieza a programar y el preview aparecerá aquí."), kind: "empty", entry: null }

  const activeExt = activePath ? ext(activePath) : ""

  // 1) Follow the active file when it is directly previewable.
  if (activePath) {
    if (activeExt === "html" || activeExt === "htm") {
      return { html: buildHtmlDocument(files, activePath), kind: "html", entry: activePath }
    }
    if (activeExt === "md" || activeExt === "mdx") {
      return { html: buildMarkdownDocument(files, activePath), kind: "markdown", entry: activePath }
    }
    if (activeExt === "svg") {
      return { html: buildSvgDocument(files, activePath), kind: "svg", entry: activePath }
    }
  }

  // 2) Project-level detection.
  const htmlEntry =
    paths.find((p) => stripLead(p).toLowerCase() === "index.html") ??
    paths.find((p) => ext(p) === "html" || ext(p) === "htm")
  if (htmlEntry) return { html: buildHtmlDocument(files, htmlEntry), kind: "html", entry: htmlEntry }

  const jsPaths = paths.filter((p) => JS_EXTS.has(ext(p)))
  if (jsPaths.length > 0) {
    const reactEntry =
      (activePath && JS_EXTS.has(activeExt) ? activePath : null) ??
      paths.find((p) => /(^|\/)app\.(t|j)sx?$/i.test(p)) ??
      paths.find((p) => /(^|\/)(src\/)?(main|index)\.(t|j)sx?$/i.test(p)) ??
      jsPaths[0]
    return { html: buildReactDocument(files, reactEntry), kind: "react", entry: reactEntry }
  }

  if (activePath && (activeExt === "md" || activeExt === "mdx")) {
    return { html: buildMarkdownDocument(files, activePath), kind: "markdown", entry: activePath }
  }
  const mdEntry = paths.find((p) => ext(p) === "md" || ext(p) === "mdx")
  if (mdEntry) return { html: buildMarkdownDocument(files, mdEntry), kind: "markdown", entry: mdEntry }

  return {
    html: placeholder("El preview en vivo soporta web (HTML/CSS/JS), React/JSX, Markdown y SVG. Para apps de servidor (Python, Go…), ejecútalas con el agente."),
    kind: "unsupported",
    entry: activePath,
  }
}
