import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"

const root = process.cwd()
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), "utf8"))
const readSrc = (rel: string) => readFileSync(path.join(root, rel), "utf8")

// ── Regression 1 ────────────────────────────────────────────────────
// The document viewer imports the pdfjs *API* from react-pdf, but loads
// the pdfjs *worker* from the top-level `pdfjs-dist`. If those resolve
// to different versions, pdfjs aborts with
//   "The API version X does not match the Worker version Y"
// and EVERY PDF / server-converted-DOCX preview renders blank
// ("No se pudo abrir el documento"). Keep them on one exact version.
test("pdfjs-dist is pinned to the exact version react-pdf bundles (worker must match the API)", () => {
  const pkg = readJson("package.json")
  const reactPdfPkg = readJson("node_modules/react-pdf/package.json")
  const wanted = reactPdfPkg.dependencies?.["pdfjs-dist"]

  assert.ok(wanted, "react-pdf should declare a pdfjs-dist dependency")
  assert.match(wanted, /^\d+\.\d+\.\d+$/, "react-pdf pins an exact pdfjs-dist version")

  assert.equal(
    pkg.dependencies?.["pdfjs-dist"],
    wanted,
    "top-level pdfjs-dist must equal react-pdf's pinned version, or the worker/API versions mismatch and previews go blank",
  )

  // The installed copy (post-install dedupe) must also be that version.
  const installed = readJson("node_modules/pdfjs-dist/package.json").version
  assert.equal(installed, wanted, "the installed pdfjs-dist worker must match react-pdf's API version")

  // An override keeps any transitive bump from reintroducing a 2nd copy.
  if (pkg.overrides?.["pdfjs-dist"]) {
    assert.equal(pkg.overrides["pdfjs-dist"], wanted, "the pdfjs-dist override must equal react-pdf's pinned version")
  }
})

// ── Regression 2 ────────────────────────────────────────────────────
// SyncfusionBannerRemover used to querySelectorAll('[role="dialog"]')
// and remove() any match whose text contained generic words like
// "trial"/"license"/"account"+"sign in". That ripped the app's OWN
// dialogs out of the DOM — including the document-viewer panel, which
// opened and then vanished a tick later. The remover must be scoped to
// Syncfusion's own element shapes and an unambiguous Syncfusion signal.
test("SyncfusionBannerRemover never removes generic app dialogs", () => {
  const src = readSrc("components/SyncfusionBannerRemover.tsx")

  // No generic role-based removal (single-quoted selector strings + the
  // MutationObserver role trigger). Comments may still mention the role.
  assert.doesNotMatch(src, /'\[role="dialog"\]'/, "generic [role=dialog] selector collides with app dialogs")
  assert.doesNotMatch(src, /'\[role="alertdialog"\]'/, "generic [role=alertdialog] selector collides with app dialogs")
  assert.doesNotMatch(
    src,
    /getAttribute\(['"]role['"]\)\s*===\s*['"](?:dialog|alertdialog)['"]/,
    "the MutationObserver must not treat any role=dialog node as a Syncfusion nag",
  )

  // The app's own document-viewer dialog must be explicitly protected.
  assert.match(src, /unified-document-viewer-dialog/, "must skip the app's own document-viewer dialog")

  // Removal must require an unambiguous Syncfusion signal, not generic words.
  assert.match(src, /isSyncfusionNag/, "removal must go through the strict Syncfusion-only text gate")
  assert.match(src, /claim your free/, "the strict gate keys off Syncfusion's own trial wording")
})
