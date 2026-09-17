import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ImageModal, type ImageViewerAsset } from "@/components/ui/image-modal"
import * as imageTools from "@/lib/image-viewer"

const beach: ImageViewerAsset = { id: "beach", fileId: "beach-file", url: "/beach.png", name: "Playa.png", width: 2000, height: 1200, chatId: "chat-1" }
const portrait: ImageViewerAsset = { id: "portrait", fileId: "portrait-file", url: "/portrait.png", name: "Playa vertical.png", width: 900, height: 1600, parentFileId: "beach-file" }

class TestPointerEvent extends MouseEvent {
  pointerId: number
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1 }
}

beforeEach(() => {
  document.body.style.overflow = ""
  vi.stubGlobal("PointerEvent", TestPointerEvent)
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (this.getAttribute("data-testid") === "image-viewer-canvas") return { width: 1032, height: 632, x: 0, y: 0, left: 0, top: 0, right: 1032, bottom: 632, toJSON() {} }
    const width = Number.parseFloat(this.style.width) || 1000
    const height = Number.parseFloat(this.style.height) || 600
    return { width, height, x: 100, y: 80, left: 100, top: 80, right: 100 + width, bottom: 80 + height, toJSON() {} }
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.style.overflow = "" })

function draw(from = { x: 200, y: 140 }, to = { x: 600, y: 380 }) {
  const canvas = screen.getByTestId("image-viewer-canvas")
  fireEvent.pointerDown(canvas, { clientX: from.x, clientY: from.y, button: 0, pointerId: 1 })
  fireEvent.pointerMove(canvas, { clientX: to.x, clientY: to.y, pointerId: 1 })
  fireEvent.pointerUp(canvas, { clientX: to.x, clientY: to.y, pointerId: 1 })
}

function changeZoom(label: string) {
  fireEvent.click(screen.getByRole("button", { name: /^Zoom:/ }))
  fireEvent.click(within(screen.getByRole("group", { name: "Nivel de zoom" })).getByRole("button", { name: label, exact: true }))
}

describe("image workspace", () => {
  it("opens legacy images in a body portal, fits the whole image and uses natural pixels at 100%", () => {
    const { container } = render(<ImageModal isOpen onClose={vi.fn()} imageUrl="/legacy.png" altText="Original" />)
    expect(container).not.toContainElement(screen.getByRole("dialog"))
    const image = screen.getByTestId("image-viewer-image")
    Object.defineProperties(image, { naturalWidth: { value: 2000 }, naturalHeight: { value: 1200 } })
    fireEvent.load(image)
    expect(image).toHaveStyle({ width: "1000px", height: "600px", imageRendering: "auto" })
    expect(screen.getByRole("button", { name: "Zoom: 50 %, ajustar" })).toBeInTheDocument()
    changeZoom("100 %")
    expect(image).toHaveStyle({ width: "2000px", height: "1200px" })
    changeZoom("Ajustar")
    expect(image).toHaveStyle({ width: "1000px", height: "600px" })
  })

  it("edits the selected thumbnail, preserves its parent identity, and submits selected quality", async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    const onSelect = vi.fn()
    render(<ImageModal isOpen onClose={vi.fn()} images={[beach, portrait]} onEdit={onEdit} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("button", { name: "Ver imagen 2: Playa vertical.png" }))
    expect(onSelect).toHaveBeenCalledWith(1)
    fireEvent.change(screen.getByRole("textbox", { name: "Describir ediciones" }), { target: { value: "Mantén el mar y cambia solo el cielo" } })
    fireEvent.change(screen.getByRole("combobox", { name: "Calidad de imagen" }), { target: { value: "4K" } })
    fireEvent.click(screen.getByRole("button", { name: "Enviar edición" }))
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(portrait, { operation: "edit", prompt: "Mantén el mar y cambia solo el cielo", quality: "4K" }))
    expect(screen.getByTestId("image-viewer-image")).toHaveAttribute("src", portrait.url)
  })

  it("retains each image draft across navigation and retains failed edits", async () => {
    const onEdit = vi.fn().mockRejectedValue(new Error("El modelo seleccionado no admite esta edición."))
    render(<ImageModal isOpen onClose={vi.fn()} images={[beach, portrait]} onEdit={onEdit} />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Conserva las olas" } })
    fireEvent.click(screen.getByRole("button", { name: "Ver imagen 2: Playa vertical.png" }))
    expect(screen.getByRole("textbox")).toHaveValue("")
    fireEvent.click(screen.getByRole("button", { name: "Ver imagen 1: Playa.png" }))
    expect(screen.getByRole("textbox")).toHaveValue("Conserva las olas")
    fireEvent.click(screen.getByRole("button", { name: "Enviar edición" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("El modelo seleccionado no admite esta edición.")
    expect(screen.getByRole("textbox")).toHaveValue("Conserva las olas")
  })

  it("inherits the selected asset quality and keeps a deliberate quality choice for its next edit", async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    const high = { ...beach, quality: "4K" }
    const standard = { ...portrait, quality: "1K" }
    render(<ImageModal isOpen onClose={vi.fn()} images={[high, standard]} onEdit={onEdit} />)
    expect(screen.getByRole("combobox", { name: "Calidad de imagen" })).toHaveValue("4K")
    fireEvent.click(screen.getByRole("button", { name: "Ver imagen 2: Playa vertical.png" }))
    expect(screen.getByRole("combobox", { name: "Calidad de imagen" })).toHaveValue("1K")
    fireEvent.change(screen.getByRole("combobox", { name: "Calidad de imagen" }), { target: { value: "2K" } })
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Más luz" } })
    fireEvent.click(screen.getByRole("button", { name: "Enviar edición" }))
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(standard, expect.objectContaining({ quality: "2K" })))
  })

  it("keeps comment coordinates tied to the image and persists metadata without a generated-image request", async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    render(<ImageModal isOpen onClose={vi.fn()} images={[beach]} onEdit={onEdit} />)
    fireEvent.click(screen.getByRole("button", { name: "Comentar", exact: true }))
    fireEvent.pointerDown(screen.getByTestId("image-viewer-canvas"), { clientX: 350, clientY: 230, button: 0, pointerId: 1 })
    fireEvent.change(screen.getByRole("textbox", { name: "Escribir comentario" }), { target: { value: "Mantener este reflejo" } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar comentario" }))
    await waitFor(() => expect(onEdit).toHaveBeenCalledOnce())
    expect(onEdit.mock.calls[0][1]).toMatchObject({ operation: "comment", comments: [{ text: "Mantener este reflejo", x: 25, y: 25 }] })
    expect(await screen.findByRole("button", { name: "Comentario 1: Mantener este reflejo" })).toBeInTheDocument()
  })

  it("creates a source-sized alpha mask from the selected region and blocks empty erasing", async () => {
    const clearRect = vi.fn()
    const fillRect = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect, fillRect } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,mask")
    const onEdit = vi.fn().mockResolvedValue(undefined)
    render(<ImageModal isOpen onClose={vi.fn()} images={[beach]} onEdit={onEdit} />)
    fireEvent.click(screen.getByRole("button", { name: "Borrar", exact: true }))
    fireEvent.click(screen.getByRole("button", { name: "Borrar selección" }))
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("Marca en la imagen")
    draw()
    fireEvent.click(screen.getByRole("button", { name: "Borrar selección" }))
    await waitFor(() => expect(onEdit).toHaveBeenCalledOnce())
    expect(fillRect).toHaveBeenCalledWith(0, 0, 2000, 1200)
    expect(clearRect).toHaveBeenCalledWith(200, 120, 800, 480)
    expect(onEdit.mock.calls[0][1]).toMatchObject({ operation: "erase", selection: { x: 10, y: 10, width: 40, height: 40 }, maskDataUrl: "data:image/png;base64,mask" })
  })

  it("exports annotations as actual PNG bytes and provides undo before saving", async () => {
    const rasterize = vi.spyOn(imageTools, "rasterizeImageAnnotations").mockResolvedValue("data:image/png;base64,annotated")
    const onEdit = vi.fn().mockResolvedValue(undefined)
    render(<ImageModal isOpen onClose={vi.fn()} images={[beach]} onEdit={onEdit} />)
    fireEvent.click(screen.getByRole("button", { name: "Anotar", exact: true }))
    draw()
    fireEvent.click(screen.getByRole("button", { name: "Deshacer último trazo" }))
    expect(screen.getByRole("button", { name: "Deshacer último trazo" })).toBeDisabled()
    draw()
    fireEvent.click(screen.getByRole("button", { name: "Guardar anotaciones" }))
    await waitFor(() => expect(onEdit).toHaveBeenCalledOnce())
    expect(rasterize).toHaveBeenCalledWith(beach.url, [expect.objectContaining({ points: expect.arrayContaining([{ x: 10, y: 10 }, { x: 50, y: 50 }]) })])
    expect(onEdit.mock.calls[0][1]).toMatchObject({ operation: "annotate", sourceImageDataUrl: "data:image/png;base64,annotated" })
  })

  it("keeps an erase region aligned to original pixels after zooming to 200%", async () => {
    const clearRect = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect, fillRect: vi.fn() } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,mask")
    const onEdit = vi.fn().mockResolvedValue(undefined)
    render(<ImageModal isOpen onClose={vi.fn()} images={[beach]} onEdit={onEdit} />)
    changeZoom("200 %")
    fireEvent.click(screen.getByRole("button", { name: "Borrar", exact: true }))
    draw({ x: 1100, y: 680 }, { x: 1500, y: 920 })
    fireEvent.click(screen.getByRole("button", { name: "Borrar selección" }))
    await waitFor(() => expect(onEdit).toHaveBeenCalledOnce())
    expect(clearRect).toHaveBeenCalledWith(500, 300, 200, 120)
    expect(onEdit.mock.calls[0][1].selection).toEqual({ x: 25, y: 25, width: 10, height: 10 })
  })

  it("sends real output dimensions and explains that fitting preserves content", async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    render(<ImageModal isOpen onClose={vi.fn()} images={[beach]} onEdit={onEdit} />)
    fireEvent.click(screen.getByRole("button", { name: "Tamaño", exact: true }))
    expect(screen.getByRole("status")).toHaveTextContent("puede añadir transparencia")
    fireEvent.change(screen.getByRole("spinbutton", { name: "Ancho en píxeles" }), { target: { value: "900" } })
    fireEvent.change(screen.getByRole("spinbutton", { name: "Alto en píxeles" }), { target: { value: "1600" } })
    fireEvent.click(screen.getByRole("button", { name: "Aplicar tamaño" }))
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(beach, expect.objectContaining({ operation: "resize", width: 900, height: 1600, aspectRatio: "900:1600" })))
  })

  it("requires confirmation before deleting and shares/downloads exactly the selected asset", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const onShare = vi.fn().mockResolvedValue(undefined)
    const onDownload = vi.fn().mockResolvedValue(undefined)
    render(<ImageModal isOpen onClose={vi.fn()} images={[beach, portrait]} selectedIndex={1} onDelete={onDelete} onShare={onShare} onDownload={onDownload} />)
    fireEvent.click(screen.getByRole("button", { name: "Compartir imagen" }))
    await waitFor(() => expect(onShare).toHaveBeenCalledWith(portrait))
    await waitFor(() => expect(screen.getByRole("button", { name: "Descargar imagen" })).not.toBeDisabled())
    fireEvent.click(screen.getByRole("button", { name: "Descargar imagen" }))
    await waitFor(() => expect(onDownload).toHaveBeenCalledWith(portrait))
    await waitFor(() => expect(screen.getByRole("button", { name: "Descargar imagen" })).not.toBeDisabled())
    fireEvent.click(screen.getByRole("button", { name: "Más opciones de imagen" }))
    fireEvent.click(screen.getByRole("button", { name: "Eliminar imagen", exact: true }))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Eliminar", exact: true }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(portrait))
  })

  it("traps/restores focus, closes menus before viewer, and ignores arrows inside the composer", () => {
    const opener = document.createElement("button")
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const onSelect = vi.fn()
    const { unmount } = render(<ImageModal isOpen onClose={onClose} images={[beach, portrait]} onSelect={onSelect} />)
    expect(document.body.style.overflow).toBe("hidden")
    expect(screen.getByRole("button", { name: "Cerrar imagen" })).toHaveFocus()
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true })
    expect(screen.getByRole("button", { name: "Dictar edición" })).toHaveFocus()
    screen.getByRole("textbox").focus()
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowRight" })
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: /^Zoom:/ }))
    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledOnce()
    unmount()
    expect(opener).toHaveFocus()
    expect(document.body.style.overflow).toBe("")
    opener.remove()
  })

  it("keeps a failed deletion reviewable and restores focus when cancelling confirmation", async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error("No se pudo eliminar. Inténtalo de nuevo."))
    render(<ImageModal isOpen onClose={vi.fn()} images={[beach]} onDelete={onDelete} />)
    fireEvent.click(screen.getByRole("button", { name: "Más opciones de imagen" }))
    fireEvent.click(screen.getByRole("button", { name: "Eliminar imagen", exact: true }))
    const confirmation = screen.getByRole("alertdialog")
    fireEvent.click(within(confirmation).getByRole("button", { name: "Eliminar", exact: true }))
    expect(await within(confirmation).findByRole("alert")).toHaveTextContent("No se pudo eliminar")
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancelar" }))
    expect(screen.getByRole("button", { name: "Más opciones de imagen" })).toHaveFocus()
  })

  it("explains unavailable actions and blocks duplicate submissions while work is pending", async () => {
    let finish!: () => void
    const onEdit = vi.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    render(<ImageModal isOpen onClose={vi.fn()} images={[beach]} onEdit={onEdit} unavailableOperations={{ "remove-background": "Este modelo no admite fondos transparentes." }} />)
    fireEvent.click(screen.getByRole("button", { name: "Quitar fondo" }))
    expect(screen.getByRole("alert")).toHaveTextContent("no admite fondos transparentes")
    expect(onEdit).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Una nube pequeña" } })
    fireEvent.click(screen.getByRole("button", { name: "Enviar edición" }))
    fireEvent.click(screen.getByRole("button", { name: "Enviar edición" }))
    expect(onEdit).toHaveBeenCalledOnce()
    expect(screen.getByRole("textbox")).toBeDisabled()
    await act(async () => finish())
    expect(screen.getByRole("textbox")).toHaveValue("")
  })
})
