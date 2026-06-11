import assert from "node:assert/strict"
import { createRequire } from "node:module"
import * as path from "node:path"
import { describe, it } from "node:test"

// Anchor CJS resolution at the repo root (the runner always runs from the
// repo root) so backend requires work no matter where test-dist lives.
const cjsRequire = createRequire(path.join(process.cwd(), "package.json"))

type QualityReport = {
  passed: boolean
  score: number
  issues: Array<{ id: string; message: string }>
  warnings: Array<{ id: string; message: string }>
}

type DesignGenerator = {
  extractHtml: (raw: string) => string
  systemPromptFor: (opts: { kind: string; fidelity?: string; speakerNotes?: boolean; effort?: string }) => string
  qualityReportForHtml: (html: string, opts?: { kind?: string; fidelity?: string }) => QualityReport
  shouldRepairDesign: (report: QualityReport, effort?: string) => boolean
}

const generator = cjsRequire("./backend/src/services/design-generator") as DesignGenerator

describe("design-generator · html extraction", () => {
  it("strips markdown/prose and keeps one complete HTML document", () => {
    const html = generator.extractHtml("Here it is:\n```html\n<!DOCTYPE html><html><body>ok</body></html>\n```\nextra")
    assert.equal(html, "<!DOCTYPE html><html><body>ok</body></html>")
  })

  it("adds a doctype when a model starts directly at the html tag", () => {
    const html = generator.extractHtml("<html><head></head><body>ok</body></html>")
    assert.equal(html, "<!DOCTYPE html>\n<html><head></head><body>ok</body></html>")
  })
})

describe("design-generator · effort prompt", () => {
  it("turns thorough mode into a real self-review workflow", () => {
    const prompt = generator.systemPromptFor({ kind: "prototype", fidelity: "high", effort: "thorough" })
    assert.match(prompt, /Effort mode: THOROUGH/)
    assert.match(prompt, /30-60 minute design sprint/)
    assert.match(prompt, /Self-review/i)
    assert.match(prompt, /real local-state interactions/)
  })
})

describe("design-generator · quality gate", () => {
  it("blocks visually blank HTML artifacts before they reach chat", () => {
    const report = generator.qualityReportForHtml(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body{background:#fff}</style>
</head>
<body>
  <main></main>
</body>
</html>`, { kind: "prototype", fidelity: "high" })

    assert.equal(report.passed, false)
    assert.ok(report.issues.some(issue => issue.id === "empty_body"))
    assert.ok(report.issues.some(issue => issue.id === "missing_heading"))
    assert.equal(generator.shouldRepairDesign(report, "balanced"), true)
  })

  it("flags incomplete or inert HTML for repair", () => {
    const report = generator.qualityReportForHtml("<!DOCTYPE html><html><head></head><body><button>Buy</button></body></html>", {
      kind: "prototype",
      fidelity: "high",
    })
    assert.equal(report.passed, false)
    assert.ok(report.issues.some(issue => issue.id === "missing_viewport"))
    assert.ok(report.issues.some(issue => issue.id === "inert_controls"))
    assert.equal(generator.shouldRepairDesign(report, "balanced"), true)
  })

  it("passes a complete responsive interactive document", () => {
    const report = generator.qualityReportForHtml(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>@media (max-width: 700px){ .grid { display: block; } }</style>
</head>
<body>
  <main aria-label="Tienda">
    <section class="grid">
      <h1>Ventas profesionales</h1>
      <label for="plan">Plan</label>
      <select id="plan"><option>Pro</option></select>
      <button id="buy">Comprar</button>
      <p id="status" role="status">Selecciona un plan</p>
    </section>
  </main>
  <script>
    const button = document.getElementById('buy');
    button.addEventListener('click', () => {
      document.getElementById('status').textContent = 'Compra simulada lista';
    });
  </script>
</body>
</html>`, { kind: "prototype", fidelity: "high" })

    assert.equal(report.passed, true)
    assert.equal(generator.shouldRepairDesign(report, "balanced"), false)
  })

  it("accepts a dense car-company landing page with real visible structure", () => {
    const report = generator.qualityReportForHtml(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @media (max-width: 700px){ .fleet-grid { display: block; } }
    .hero { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
  </style>
</head>
<body>
  <header aria-label="Navegación principal"><nav><a href="#catalogo">Catálogo</a><a href="#contacto">Contacto</a></nav></header>
  <main>
    <section class="hero">
      <article>
        <p>Concesionario premium</p>
        <h1>Autos ejecutivos y eléctricos para empresas modernas</h1>
        <p>Asesoría, financiamiento, mantenimiento y entrega corporativa con garantías claras para flotas de alto desempeño.</p>
        <button id="quote">Solicitar cotización</button>
      </article>
      <svg role="img" aria-label="Silueta de auto" viewBox="0 0 400 220"><rect width="400" height="220" fill="#eef2ff"/><path d="M70 145h260l-35-58H135z" fill="#111827"/></svg>
    </section>
    <section id="catalogo" class="fleet-grid">
      <h2>Modelos destacados</h2>
      <article class="card product"><h3>Sedan Executive E</h3><p>Autonomía extendida, interior silencioso y asistencia avanzada para viajes corporativos.</p></article>
      <article class="card product"><h3>SUV Atlas Pro</h3><p>Capacidad familiar, seguridad activa y conectividad para operaciones comerciales.</p></article>
      <article class="card product"><h3>Fleet Van Cargo</h3><p>Solución logística con monitoreo, carga flexible y costos operativos controlados.</p></article>
    </section>
    <section id="contacto"><h2>Agenda una prueba</h2><label for="email">Correo</label><input id="email" aria-label="Correo"><p id="status" role="status">Completa tus datos para recibir una propuesta.</p></section>
  </main>
  <script>
    document.getElementById('quote').addEventListener('click', () => {
      document.getElementById('status').textContent = 'Cotización preparada para ventas corporativas.';
    });
  </script>
</body>
</html>`, { kind: "prototype", fidelity: "high" })

    assert.equal(report.passed, true)
    assert.equal(generator.shouldRepairDesign(report, "balanced"), false)
  })
})
