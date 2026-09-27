import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const theme = vi.hoisted(() => ({ resolvedTheme: "dark" as string | undefined }))
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: theme.resolvedTheme }) }))

import { AdminLightTheme } from "@/components/admin/admin-light-theme"

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("AdminLightTheme — the admin shell stays light under the global dark theme", () => {
  beforeEach(() => {
    document.documentElement.className = "dark midnight"
    document.documentElement.style.colorScheme = "dark"
    theme.resolvedTheme = "dark"
  })
  afterEach(() => {
    cleanup()
    document.documentElement.className = ""
    document.documentElement.style.colorScheme = ""
  })

  it("removes the dark class while an admin page is mounted and keeps it off", async () => {
    const view = render(<AdminLightTheme />)
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe("light")
    // The theme machinery re-applying `dark` (system change, boot script) is undone.
    document.documentElement.classList.add("dark")
    await flush()
    expect(document.documentElement.classList.contains("dark")).toBe(false)

    view.unmount()
    // Leaving the admin restores the user's dark theme.
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe("dark")
  })

  it("leaves a light user light when the admin unmounts", () => {
    document.documentElement.className = ""
    document.documentElement.style.colorScheme = "light"
    theme.resolvedTheme = "light"
    const view = render(<AdminLightTheme />)
    view.unmount()
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })
})
