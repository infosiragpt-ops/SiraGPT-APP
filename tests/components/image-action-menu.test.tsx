import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ImageActionMenu, ImageReplyBanner, PinnedImagesBar } from "@/components/chat/image-action-menu"
import { ImageModal, type ImageViewerAsset } from "@/components/ui/image-modal"
import {
  IMAGE_FORWARD_EVENT,
  IMAGE_PRECISION_EDIT_EVENT,
  IMAGE_REPLY_EVENT,
  IMAGE_TO_VIDEO_EVENT,
  formatVideoDurationEs,
  parseCustomVideoDuration,
  type ChatImageActionPayload,
} from "@/lib/chat/image-actions"
import { getPinnedImages, togglePinnedImage } from "@/lib/chat/pinned-images"
import { maskBoundingBox } from "@/lib/image-viewer"

const sampleImage: ChatImageActionPayload = {
  id: "img-cat-1",
  fileId: "file-cat-1",
  url: "/uploads/images/cat-blue.png",
  name: "gato-azul.png",
  prompt: "créame una imagen de un gato azul",
  aspectRatio: "1:1",
  chatId: "chat-cat-1",
  messageId: "msg-cat-1",
  width: 1024,
  height: 1024,
}

class TestPointerEvent extends MouseEvent {
  pointerId: number
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
  }
}

beforeEach(() => {
  const memoryStorage = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => { memoryStorage.set(key, String(value)) },
    removeItem: (key: string) => { memoryStorage.delete(key) },
    clear: () => { memoryStorage.clear() },
  })
  vi.stubGlobal("PointerEvent", TestPointerEvent)
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.style.overflow = ""
})

describe("WhatsApp-style ImageActionMenu & precision studio", () => {
  it("opens the top-right chevron dropdown and dispatches reply & precision-edit events", () => {
    const replyEvents: CustomEvent[] = []
    const editEvents: CustomEvent[] = []
    const onReply = (e: Event) => replyEvents.push(e as CustomEvent)
    const onEdit = (e: Event) => editEvents.push(e as CustomEvent)
    window.addEventListener(IMAGE_REPLY_EVENT, onReply)
    window.addEventListener(IMAGE_PRECISION_EDIT_EVENT, onEdit)

    try {
      render(<ImageActionMenu image={sampleImage} onOpen={vi.fn()} onDownload={vi.fn()} />)
      const trigger = screen.getByTestId("image-action-chevron")
      fireEvent.click(trigger)

      expect(screen.getByTestId("image-action-menu")).toBeInTheDocument()
      fireEvent.click(screen.getByRole("menuitem", { name: /Responder a esta imagen/i }))
      expect(replyEvents).toHaveLength(1)
      expect(replyEvents[0].detail).toMatchObject({ fileId: "file-cat-1", url: sampleImage.url })

      fireEvent.click(trigger)
      fireEvent.click(screen.getByRole("menuitem", { name: /Editar algo en concreto/i }))
      expect(editEvents).toHaveLength(1)
      expect(editEvents[0].detail).toMatchObject({ fileId: "file-cat-1", chatId: "chat-cat-1" })
    } finally {
      window.removeEventListener(IMAGE_REPLY_EVENT, onReply)
      window.removeEventListener(IMAGE_PRECISION_EDIT_EVENT, onEdit)
    }
  })

  it("converts image to video with preset minutes and custom seconds/minutes durations", () => {
    const videoEvents: CustomEvent[] = []
    const onVideo = (e: Event) => videoEvents.push(e as CustomEvent)
    window.addEventListener(IMAGE_TO_VIDEO_EVENT, onVideo)

    try {
      render(<ImageActionMenu image={sampleImage} />)
      fireEvent.click(screen.getByTestId("image-action-chevron"))
      fireEvent.click(screen.getByRole("menuitem", { name: /Convertir en video/i }))
      expect(screen.getByTestId("image-action-video-panel")).toBeInTheDocument()

      fireEvent.click(screen.getByRole("button", { name: "1 min" }))
      expect(videoEvents).toHaveLength(1)
      expect(videoEvents[0].detail).toMatchObject({ fileId: "file-cat-1", durationSeconds: 60 })

      // Custom duration: 2 minutes -> 120 seconds
      fireEvent.click(screen.getByTestId("image-action-chevron"))
      fireEvent.click(screen.getByRole("menuitem", { name: /Convertir en video/i }))
      fireEvent.click(screen.getByRole("button", { name: "min" }))
      fireEvent.change(screen.getByLabelText("Duración personalizada del video"), { target: { value: "2" } })
      fireEvent.click(screen.getByRole("button", { name: "Usar" }))
      expect(videoEvents).toHaveLength(2)
      expect(videoEvents[1].detail).toMatchObject({ fileId: "file-cat-1", durationSeconds: 120 })
    } finally {
      window.removeEventListener(IMAGE_TO_VIDEO_EVENT, onVideo)
    }
  })

  it("supports forwarding to new chat or picking another chat, and pins/unpins per chat", () => {
    const forwardEvents: CustomEvent[] = []
    const onForward = (e: Event) => forwardEvents.push(e as CustomEvent)
    window.addEventListener(IMAGE_FORWARD_EVENT, onForward)

    try {
      render(<ImageActionMenu image={sampleImage} />)

      // Forward to new chat
      fireEvent.click(screen.getByTestId("image-action-chevron"))
      fireEvent.click(screen.getByRole("menuitem", { name: /Reenviar/i }))
      fireEvent.click(screen.getByRole("menuitem", { name: /Nuevo chat con esta imagen/i }))
      expect(forwardEvents).toHaveLength(1)
      expect(forwardEvents[0].detail).toMatchObject({ fileId: "file-cat-1", mode: "new-chat" })

      // Forward to pick chat
      fireEvent.click(screen.getByTestId("image-action-chevron"))
      fireEvent.click(screen.getByRole("menuitem", { name: /Reenviar/i }))
      fireEvent.click(screen.getByRole("menuitem", { name: /Enviar a otro chat/i }))
      expect(forwardEvents).toHaveLength(2)
      expect(forwardEvents[1].detail).toMatchObject({ fileId: "file-cat-1", mode: "pick-chat" })

      // Pin & unpin image
      expect(screen.queryByTestId("image-pinned-badge")).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId("image-action-chevron"))
      fireEvent.click(screen.getByRole("menuitem", { name: /Fijar imagen/i }))
      expect(screen.getByTestId("image-pinned-badge")).toBeInTheDocument()
      expect(getPinnedImages("chat-cat-1")).toHaveLength(1)

      fireEvent.click(screen.getByTestId("image-action-chevron"))
      fireEvent.click(screen.getByRole("menuitem", { name: /Desfijar imagen/i }))
      expect(screen.queryByTestId("image-pinned-badge")).not.toBeInTheDocument()
      expect(getPinnedImages("chat-cat-1")).toHaveLength(0)
    } finally {
      window.removeEventListener(IMAGE_FORWARD_EVENT, onForward)
    }
  })

  it("renders ImageReplyBanner & PinnedImagesBar for edit and video reply states", () => {
    const onClear = vi.fn()
    const onPrecisionEdit = vi.fn()
    const { rerender } = render(
      <ImageReplyBanner
        target={{ ...sampleImage, intent: "edit" }}
        onClear={onClear}
        onPrecisionEdit={onPrecisionEdit}
      />,
    )
    expect(screen.getByTestId("composer-image-reply-banner")).toHaveTextContent("Respondiendo a esta imagen")
    fireEvent.click(screen.getByRole("button", { name: /Pincel/i }))
    expect(onPrecisionEdit).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole("button", { name: /Cancelar respuesta a imagen/i }))
    expect(onClear).toHaveBeenCalledOnce()

    rerender(
      <ImageReplyBanner
        target={{ ...sampleImage, intent: "video", videoDurationSeconds: 90 }}
        onClear={onClear}
      />,
    )
    expect(screen.getByTestId("composer-image-reply-banner")).toHaveTextContent("Convertir esta imagen en video · 1 min 30 s")

    const pinned = togglePinnedImage("chat-cat-1", {
      id: "file-cat-1",
      fileId: "file-cat-1",
      url: sampleImage.url,
      name: sampleImage.name,
      prompt: sampleImage.prompt,
    }).items
    const onReplyPinned = vi.fn()
    const onUnpin = vi.fn()
    render(<PinnedImagesBar items={pinned} onReply={onReplyPinned} onUnpin={onUnpin} />)
    expect(screen.getByTestId("pinned-images-bar")).toHaveTextContent("Fijadas (1)")
    fireEvent.click(screen.getByRole("button", { name: /Desfijar gato-azul.png/i }))
    expect(onUnpin).toHaveBeenCalledWith("file-cat-1")
  })

  it("launches ImageModal directly in millimeter brush mode and submits exact brush alpha mask + bounds", async () => {
    const ctxStub = {
      fillStyle: "",
      strokeStyle: "",
      lineCap: "",
      lineJoin: "",
      lineWidth: 0,
      globalCompositeOperation: "",
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
    }
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctxStub as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,brushmask")
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this.getAttribute("data-testid") === "image-viewer-canvas") {
        return { width: 1032, height: 632, x: 0, y: 0, left: 0, top: 0, right: 1032, bottom: 632, toJSON() {} }
      }
      return { width: 1000, height: 600, x: 100, y: 80, left: 100, top: 80, right: 1100, bottom: 680, toJSON() {} }
    })

    const onEdit = vi.fn().mockResolvedValue(undefined)
    const asset: ImageViewerAsset = {
      id: "cat",
      fileId: "file-cat-1",
      url: "/cat.png",
      name: "Gato.png",
      width: 2000,
      height: 1200,
      chatId: "chat-1",
    }

    render(
      <ImageModal
        isOpen
        onClose={vi.fn()}
        images={[asset]}
        onEdit={onEdit}
        initialMode="erase"
        initialEraseTool="brush"
      />,
    )

    expect(screen.getByRole("button", { name: /Pincel milimétrico/i })).toHaveAttribute("aria-pressed", "true")

    const canvas = screen.getByTestId("image-viewer-canvas")
    fireEvent.pointerDown(canvas, { clientX: 300, clientY: 200, button: 0, pointerId: 1 })
    fireEvent.pointerMove(canvas, { clientX: 400, clientY: 260, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 260, pointerId: 1 })

    expect(screen.getAllByTestId("image-viewer-mask-stroke")).toHaveLength(1)

    fireEvent.change(screen.getByRole("textbox", { name: "Describir ediciones" }), {
      target: { value: "Cambia solo el ojo a verde esmeralda" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Aplicar edición a la zona" }))

    await waitFor(() => expect(onEdit).toHaveBeenCalledOnce())
    expect(ctxStub.fillRect).toHaveBeenCalledWith(0, 0, 2000, 1200)
    expect(ctxStub.stroke).toHaveBeenCalled()
    expect(onEdit.mock.calls[0][1]).toMatchObject({
      operation: "erase",
      prompt: "Cambia solo el ojo a verde esmeralda",
      maskDataUrl: "data:image/png;base64,brushmask",
      selection: expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      }),
    })
  })

  it("formats video durations and computes mask bounding boxes accurately", () => {
    expect(formatVideoDurationEs(8)).toBe("8 s")
    expect(formatVideoDurationEs(60)).toBe("1 min")
    expect(formatVideoDurationEs(135)).toBe("2 min 15 s")
    expect(parseCustomVideoDuration("1.5", "minutes")).toBe(90)
    expect(parseCustomVideoDuration("45", "seconds")).toBe(45)
    expect(parseCustomVideoDuration("10", "minutes")).toBe(300)
    expect(parseCustomVideoDuration("0", "seconds")).toBeNull()

    const box = maskBoundingBox([{ points: [{ x: 20, y: 30 }, { x: 40, y: 50 }], color: "#38BDF8", width: 4 }])
    expect(box).toEqual({ x: 18, y: 28, width: 24, height: 24 })
  })

  it("uses SiraGPT liquid-glass surface classes and places assistant image menu outside-right when viewport allows", () => {
    const originalInnerWidth = window.innerWidth
    try {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 })
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 32,
        height: 32,
        x: 428,
        y: 180,
        left: 428,
        top: 180,
        right: 460,
        bottom: 212,
        toJSON() {},
      })

      const { unmount } = render(<ImageActionMenu image={sampleImage} preferOutsideRight />)
      const trigger = screen.getByTestId("image-action-chevron")
      expect(trigger.className).toContain("image-action-liquid-trigger")

      fireEvent.click(trigger)
      const menu = screen.getByTestId("image-action-menu")
      expect(menu.className).toContain("image-action-liquid-menu")
      expect(menu.className).not.toContain("/98")
      expect(menu).toHaveAttribute("data-placement", "outside-right")
      expect(menu.className).toContain("left-[calc(100%+18px)]")
      unmount()

      // Narrow viewport falls back cleanly inside-right
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 480 })
      const { unmount: unmountNarrow } = render(<ImageActionMenu image={sampleImage} preferOutsideRight />)
      fireEvent.click(screen.getByTestId("image-action-chevron"))
      const narrowMenu = screen.getByTestId("image-action-menu")
      expect(narrowMenu).toHaveAttribute("data-placement", "inside-right")
      expect(narrowMenu.className).toContain("right-0")
      unmountNarrow()

      // Default (preferOutsideRight=false, right-aligned user images) stays inside-right even on wide screens
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 })
      render(<ImageActionMenu image={sampleImage} />)
      fireEvent.click(screen.getByTestId("image-action-chevron"))
      expect(screen.getByTestId("image-action-menu")).toHaveAttribute("data-placement", "inside-right")
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth })
    }
  })
})
