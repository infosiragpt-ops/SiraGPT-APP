import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const componentPath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const source = fs.readFileSync(componentPath, "utf8")

describe("premium tool preview source contract", () => {
  it("lets free users open premium preview/configuration tools while normal chat is loading", () => {
    assert.match(
      source,
      /const isMenuDisabled = isLoading \|\| isUploading \|\| isWebSearching \|\| isProcessingGmail \|\| isProcessingGoogleServices;/,
      "baseline should keep regular menu disable logic visible without disabling tools for a running video render"
    )
    assert.match(
      source,
      /const isPremiumPreviewSwitchDisabled = isGeneratingImage \|\| isUploading;/,
      "premium preview tools must use a narrow disabled guard so video config remains selectable during assistant loading and video rendering"
    )

    const premiumMenuStart = source.indexOf("{/* Image Generation */}")
    const premiumMenuEnd = source.indexOf("</DropdownMenuContent>", premiumMenuStart)
    assert.notEqual(premiumMenuStart, -1, "missing premium tools menu start")
    assert.notEqual(premiumMenuEnd, -1, "missing premium tools menu end")

    const premiumMenu = source.slice(premiumMenuStart, premiumMenuEnd)
    for (const label of ["Imágenes", "Voz", "Video Generation", "Música", "Generador de tesis"]) {
      assert.match(premiumMenu, new RegExp(label), `missing premium menu label ${label}`)
    }
    // The graduation-cap logo shipped as an emoji span and was later
    // restyled to the lucide <GraduationCap /> icon in the liquid menu —
    // either rendering satisfies the visual contract.
    assert.match(
      premiumMenu,
      /aria-hidden="true">🎓<\/span>|<GraduationCap\b/,
      "thesis generator premium menu item should show the graduation cap logo"
    )

    const previewDisabledCount = (premiumMenu.match(/disabled=\{isPremiumPreviewSwitchDisabled\}/g) || []).length
    assert.equal(previewDisabledCount, 5, "all five premium preview tools should use the narrow preview disabled guard")
    assert.doesNotMatch(
      premiumMenu,
      /disabled=\{[^}]*currentPlan[^}]*FREE|disabled=\{isToolSwitchDisabled\}/,
      "premium preview tools must not be disabled only because the user is FREE or a normal chat response is loading"
    )
  })
})
