import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { describe, it } from "node:test"

const cjsRequire = createRequire(__filename)

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

const generator = cjsRequire("../../backend/src/services/design-generator") as DesignGenerator

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
})
