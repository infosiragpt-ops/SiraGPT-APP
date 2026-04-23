"use client"

/**
 * InteractiveArtifactDisplay — renders server-generated JSX inside a
 * sandboxed iframe using Babel-standalone for in-browser transpile.
 *
 * The iframe is intentionally `sandbox="allow-scripts"` WITHOUT
 * allow-same-origin — the artefact runs with a null origin and
 * cannot reach the parent's cookies, localStorage, or DOM. Scripts
 * from the whitelisted CDNs load because script execution is still
 * allowed inside the sandbox.
 *
 * The shell HTML pre-loads: React 18, ReactDOM 18, Babel standalone,
 * Tailwind CDN, Recharts, Lucide, Lodash, D3, Math.js, Plotly,
 * PapaParse, SheetJS, Three.js (small set), and exposes them on
 * `window` so the generated JSX can use them via globals (no imports
 * / no bundler — simpler for the LLM to author).
 */

import * as React from "react"
import { Code2, Download, Maximize2, Minimize2, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"

interface ArtifactFile {
  type: "artifact"
  runtime: "react"
  title?: string
  explanation?: string
  jsx: string
}

export function InteractiveArtifactDisplay({ files }: { files: any[] }) {
  const artefacts = React.useMemo<ArtifactFile[]>(
    () => (Array.isArray(files) ? files.filter((f: any) => f?.type === "artifact") : []),
    [files]
  )
  if (artefacts.length === 0) return null
  return (
    <div className="mt-3 space-y-3">
      {artefacts.map((a, i) => <ArtifactCard key={i} artefact={a} />)}
    </div>
  )
}

function ArtifactCard({ artefact }: { artefact: ArtifactFile }) {
  const [expanded, setExpanded] = React.useState(false)
  const [showSource, setShowSource] = React.useState(false)
  const [reloadKey, setReloadKey] = React.useState(0)
  const srcDoc = React.useMemo(() => buildShellHtml(artefact.jsx), [artefact.jsx])

  function downloadHtml() {
    const blob = new Blob([srcDoc], { type: "text/html" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${(artefact.title || "artifact").replace(/[^\w\s-]/g, "").trim()}.html`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-background">
      <div className="flex items-center justify-between border-b border-border/50 bg-muted/10 px-3 py-2 text-[12px]">
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <Code2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-medium text-foreground">
            {artefact.title || "Artefacto interactivo"}
          </span>
          <span>· React</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="sm" onClick={() => setShowSource(v => !v)} className="h-7 px-2">
            <span className="text-[11.5px]">{showSource ? "Vista" : "Código"}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setReloadKey(k => k + 1)} className="h-7 px-2">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(v => !v)} className="h-7 px-2">
            {expanded
              ? <Minimize2 className="h-3.5 w-3.5" />
              : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={downloadHtml} className="h-7 px-2">
            <Download className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {showSource ? (
        <pre className="max-h-[70vh] overflow-auto bg-muted/5 p-3 text-[12px] leading-snug">
          <code>{artefact.jsx}</code>
        </pre>
      ) : (
        <div className={expanded ? "h-[75vh]" : "h-[560px]"}>
          <iframe
            key={reloadKey}
            srcDoc={srcDoc}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts"
            title={artefact.title || "artifact"}
          />
        </div>
      )}
    </div>
  )
}

// ─── HTML shell ────────────────────────────────────────────────────────────

/**
 * Build a self-contained HTML document that hosts the artefact JSX
 * inside an isolated iframe. The shell:
 *   · loads React 18 UMD + ReactDOM 18 UMD
 *   · loads Babel standalone and runs the jsx via
 *     <script type="text/babel" data-presets="env,react">
 *   · pre-populates Recharts / lucide / lodash / d3 / mathjs / plotly
 *     / papaparse / sheetjs / three as globals
 *   · exposes React hooks (useState, etc.) via a small header so the
 *     LLM can write `useState()` without `React.` prefix
 *   · mounts the component into <div id="root">
 *
 * The string building is careful: we NEVER template-literal-interpolate
 * the LLM's JSX into a JS string context (that would let it break out
 * by closing the string). We use an HTML text node strategy: the JSX
 * goes inside a <script type="text/babel"> tag whose *content* is the
 * JSX — we only need to make sure no "</script>" appears in the body.
 */
function buildShellHtml(jsx: string): string {
  const safeJsx = String(jsx || "").replace(/<\/script/gi, "<\\/script")

  // Header that exposes React hooks + common libs as bare identifiers,
  // and wires the artifact's `App` component to the DOM on mount.
  const footer = `
// Wire up — the artefact defines `App`; render it.
try {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(React.createElement(App));
} catch (e) {
  const el = document.getElementById('root');
  el.innerHTML = '<pre style="color:#b91c1c;padding:12px;font:12px ui-monospace">' +
    String(e && e.stack || e) + '</pre>';
}
`.trim()

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Artefacto</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  html, body { margin: 0; padding: 0; background: #fff; font-family: Inter, system-ui, sans-serif; }
  #root { min-height: 100vh; padding: 16px; }
  *:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; border-radius: 4px; }
</style>
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<!-- Visual / data libs — kept small-ish, omits three.js + tensorflow to
     keep boot time reasonable; the user can load them inside their
     component via fetch(...) if they really need them. -->
<script src="https://unpkg.com/lodash/lodash.min.js"></script>
<script src="https://unpkg.com/recharts/umd/Recharts.min.js"></script>
<script src="https://unpkg.com/mathjs/lib/browser/math.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<script src="https://unpkg.com/papaparse@5.4.1/papaparse.min.js"></script>
<script src="https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js"></script>
<script src="https://unpkg.com/lucide@latest"></script>
</head>
<body>
<div id="root"></div>
<script type="text/babel" data-presets="env,react">
// Expose hooks + common libs as bare identifiers so the generated
// component can write idiomatic React without any imports.
const { useState, useEffect, useMemo, useRef, useCallback, useReducer, useLayoutEffect, Fragment } = React;
const _ = window._;
const Recharts = window.Recharts;
const math = window.math;
const d3 = window.d3;
const Plotly = window.Plotly;
const Papa = window.Papa;
const XLSX = window.XLSX;
const lucide = window.lucide;

// ─── Generated artefact ──────────────────────────────────────────────
${safeJsx}
// ─── End generated ───────────────────────────────────────────────────

${footer}
</script>
</body>
</html>`
}
