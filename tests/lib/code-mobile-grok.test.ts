import { describe, expect, it } from "vitest"

import {
  agentInitials,
  askAgentPlaceholder,
  CODE_MOBILE_GROK_MAX_PX,
  isCodeMobileGrokWidth,
} from "@/lib/code-mobile-grok"

describe("code mobile Grok helpers", () => {
  it("builds the Ask {agentName} placeholder", () => {
    expect(askAgentPlaceholder("Prueba")).toBe("Ask Prueba")
    expect(askAgentPlaceholder("  CEO Office  ")).toBe("Ask CEO Office")
    expect(askAgentPlaceholder(null)).toBe("Ask Agent")
  })

  it("treats widths under 768 as the phone shell", () => {
    expect(CODE_MOBILE_GROK_MAX_PX).toBe(768)
    expect(isCodeMobileGrokWidth(390)).toBe(true)
    expect(isCodeMobileGrokWidth(768)).toBe(false)
  })

  it("initials the agent pill", () => {
    expect(agentInitials("Prueba")).toBe("P")
    expect(agentInitials("CEO Office")).toBe("CO")
  })
})
