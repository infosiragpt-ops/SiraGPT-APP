import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

describe("Select trigger label", () => {
  afterEach(() => cleanup())

  it("shows the caller's label instead of the raw value when given", () => {
    render(
      <Select value="all">
        <SelectTrigger data-testid="trigger"><SelectValue>Todos los tipos</SelectValue></SelectTrigger>
        <SelectContent><SelectItem value="all">Todos los tipos</SelectItem></SelectContent>
      </Select>,
    )
    expect(screen.getByTestId("trigger").textContent).toBe("Todos los tipos")
  })

  it("keeps the old behaviour (raw value, then placeholder) without children", () => {
    const { rerender } = render(
      <Select value="warn">
        <SelectTrigger data-testid="trigger"><SelectValue placeholder="Nivel" /></SelectTrigger>
        <SelectContent><SelectItem value="warn">Avisos</SelectItem></SelectContent>
      </Select>,
    )
    expect(screen.getByTestId("trigger").textContent).toBe("warn")
    rerender(
      <Select value="">
        <SelectTrigger data-testid="trigger"><SelectValue placeholder="Nivel" /></SelectTrigger>
        <SelectContent><SelectItem value="warn">Avisos</SelectItem></SelectContent>
      </Select>,
    )
    expect(screen.getByTestId("trigger").textContent).toBe("Nivel")
  })
})
