import React from "react"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { DocumentArtifactIcon } from "@/components/doc/document-artifact-chrome"
import { OfficeFileIcon, officeKindFor, officeKindForMime, officeKindForName } from "@/components/office-file-icon"

describe("SPSS file identity", () => {
  it.each(["encuesta.sav", "encuesta.ZSAV", "encuesta.por", "analisis.sps", "sav"])("recognizes %s as SPSS", (name) => {
    expect(officeKindForName(name)).toBe("spss")
  })

  it.each(["application/x-spss-sav", "application/x-spss-zsav", "application/x-spss-por", "application/x-spss-syntax", "application/spss; charset=utf-8"])("recognizes %s when a filename has no extension", (mimeType) => {
    expect(officeKindForMime(mimeType)).toBe("spss")
    expect(officeKindFor({ name: "Encuesta", mimeType })).toBe("spss")
  })

  it.each(["sav", "zsav", "por", "sps"])("renders an accessible SPSS badge on %s deliveries and previews", (format) => {
    const { container } = render(<DocumentArtifactIcon format={format} />)
    const icon = screen.getByRole("img", { name: "SPSS" })
    expect(icon).toHaveAttribute("data-office-icon", "spss")
    expect(icon).toHaveTextContent("SPSS")
    expect(container.querySelector('[aria-label="Archivo"]')).toBeNull()
  })

  it("also renders the same compact vector in attachment rows", () => {
    const { container } = render(<OfficeFileIcon kind="spss" size={16} />)
    const icon = container.querySelector("svg")!
    expect(icon).toHaveAttribute("width", "16")
    expect(icon).toHaveAttribute("aria-hidden", "true")
    expect(icon).toHaveAttribute("data-office-icon", "spss")
  })

  it("retains the generic fallback for unrelated files and avoids SPSS MIME prefix collisions", () => {
    render(<DocumentArtifactIcon format="unknown" />)
    expect(screen.getByLabelText("Archivo")).toBeInTheDocument()
    expect(officeKindForMime("application/x-spss-unrelated")).toBeNull()
  })
})
