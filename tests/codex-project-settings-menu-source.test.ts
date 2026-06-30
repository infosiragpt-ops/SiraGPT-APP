import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const treePath = path.join(process.cwd(), "components", "codex", "codex-workspace-tree.tsx")
const globalsPath = path.join(process.cwd(), "app", "globals.css")

const treeSource = fs.readFileSync(treePath, "utf8")
const globalsSource = fs.readFileSync(globalsPath, "utf8")

describe("Codex project settings menu source contract", () => {
  it("exposes the full professional APPS project menu", () => {
    for (const label of [
      "Anclar proyecto",
      "Mostrar en Finder",
      "Crear un worktree permanente",
      "Cambiar el nombre del proyecto",
      "Marcar todo como leído",
      "Archivar chats",
      "Eliminar",
    ]) {
      assert.match(treeSource, new RegExp(label), `missing project menu option: ${label}`)
    }
  })

  it("uses the shared liquid surface and item treatment", () => {
    assert.match(
      treeSource,
      /className="project-settings-menu liquid-menu-surface w-64"/,
      "project settings menu should use the liquid dropdown surface"
    )
    assert.match(
      treeSource,
      /"group liquid-menu-item project-settings-menu__item/,
      "project settings rows should use liquid menu item motion"
    )
    assert.match(
      globalsSource,
      /\.project-settings-menu\.liquid-menu-surface/,
      "project settings menu should have scoped liquid polish"
    )
  })
})
