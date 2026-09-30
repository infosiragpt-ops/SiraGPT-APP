import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const chatList = vi.hoisted(() => ({ renameChat: vi.fn(), deleteChat: vi.fn() }))
const clipboard = vi.hoisted(() => ({ writeText: vi.fn() }))
vi.mock("@/lib/chat-context-integrated", () => ({ useChatList: () => chatList }))
vi.mock("@/lib/chat/pinned-chats", () => ({
  usePinnedChats: () => [],
  setChatPinned: vi.fn(async () => ({ synced: true })),
  removePinnedChatId: vi.fn(),
}))
vi.mock("@/lib/native/clipboard", () => ({ writeText: clipboard.writeText }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { ChatTitleMenu } from "@/components/chat/chat-title-menu"
import { CHAT_ACTION_EVENT, COMPOSER_PREFILL_EVENT, consumeComposerPrefill } from "@/lib/chat/chat-actions"
import { SKILL_NEW_CHAT_EVENT } from "@/lib/chat/skills-events"

const chat = { id: "chat_123", title: "resolver" }

beforeEach(() => {
  chatList.renameChat.mockReset().mockResolvedValue(true)
  clipboard.writeText.mockReset().mockResolvedValue({ ok: true })
  window.localStorage.clear()
  window.sessionStorage.clear()
})
afterEach(() => cleanup())

describe("chat title (claude.ai style)", () => {
  it("clicking the title opens the inline rename with the light-blue border and saves on Enter", async () => {
    render(<ChatTitleMenu chat={chat} />)
    await userEvent.click(screen.getByTestId("chat-title-rename-trigger"))
    const input = await screen.findByTestId("chat-title-rename-input")
    expect(input).toHaveClass("chat-title-input--celeste")
    expect((input as HTMLInputElement).value).toBe("resolver")
    await userEvent.clear(input)
    await userEvent.type(input, "binomio al cuadrado{Enter}")
    await waitFor(() => expect(chatList.renameChat).toHaveBeenCalledWith("chat_123", "binomio al cuadrado"))
    expect(screen.queryByTestId("chat-title-rename-input")).toBeNull()
  })

  it("the chevron opens the menu in claude.ai order and «Copiar ID de sesión» copies the chat id", async () => {
    render(<ChatTitleMenu chat={chat} />)
    await userEvent.click(screen.getByTestId("chat-title-menu-trigger"))
    const menu = await screen.findByRole("menu")
    const labels = within(menu).getAllByRole("menuitem").map((el) => el.textContent?.replace(/[PRAD]$/, "").trim())
    expect(labels).toEqual([
      "Programar",
      "Convertir en habilidad",
      "Copiar ID de sesión",
      "Fijar",
      "Cambiar nombre",
      "Añadir al proyecto",
      "Archivar",
      "Eliminar",
    ])
    await userEvent.click(within(menu).getByText("Copiar ID de sesión"))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith("chat_123"))
  })

  it("«Programar» and «Archivar» are delegated to the sidebar through the chat-action event", async () => {
    const seen: any[] = []
    const onAction = (event: Event) => seen.push((event as CustomEvent).detail)
    window.addEventListener(CHAT_ACTION_EVENT, onAction)
    render(<ChatTitleMenu chat={chat} />)
    await userEvent.click(screen.getByTestId("chat-title-menu-trigger"))
    await userEvent.click(await screen.findByText("Programar"))
    await waitFor(() => expect(seen).toEqual([{ action: "schedule", chatId: "chat_123", title: "resolver" }]))
    await userEvent.click(screen.getByTestId("chat-title-menu-trigger"))
    await userEvent.click(await screen.findByText("Archivar"))
    await waitFor(() => expect(seen[1]).toEqual({ action: "archive", chatId: "chat_123", title: "resolver" }))
    window.removeEventListener(CHAT_ACTION_EVENT, onAction)
  })

  it("«Convertir en habilidad» prefills a skill-creator brief and asks for a new chat", async () => {
    const prefill = vi.fn()
    const newChat = vi.fn()
    window.addEventListener(COMPOSER_PREFILL_EVENT, prefill)
    window.addEventListener(SKILL_NEW_CHAT_EVENT, newChat)
    render(<ChatTitleMenu chat={chat} />)
    await userEvent.click(screen.getByTestId("chat-title-menu-trigger"))
    await userEvent.click(await screen.findByText("Convertir en habilidad"))
    await waitFor(() => expect(newChat).toHaveBeenCalledTimes(1))
    expect(prefill).toHaveBeenCalledTimes(1)
    expect((newChat.mock.calls[0][0] as CustomEvent).detail.name).toBe("skill-creator")
    expect(consumeComposerPrefill()).toMatch(/«resolver» \(ID de sesión chat_123\)/)
    expect(consumeComposerPrefill()).toBeNull()
    window.removeEventListener(COMPOSER_PREFILL_EVENT, prefill)
    window.removeEventListener(SKILL_NEW_CHAT_EVENT, newChat)
  })

  it("«Añadir al proyecto» lists the sidebar folders and marks the current one", async () => {
    window.localStorage.setItem("sira:chat-folder-names", JSON.stringify(["Tesis"]))
    window.localStorage.setItem("sira:chat-folders", JSON.stringify({ chat_123: "Tesis" }))
    const seen: any[] = []
    const onAction = (event: Event) => seen.push((event as CustomEvent).detail)
    window.addEventListener(CHAT_ACTION_EVENT, onAction)
    render(<ChatTitleMenu chat={chat} />)
    await userEvent.click(screen.getByTestId("chat-title-menu-trigger"))
    await userEvent.click(await screen.findByText("Añadir al proyecto"))
    const current = await screen.findByTestId("chat-title-folder-Tesis")
    expect(current).toHaveTextContent("Actual")
    await userEvent.click(await screen.findByTestId("chat-title-folder-Trabajo"))
    await waitFor(() => expect(seen).toEqual([{ action: "folder", chatId: "chat_123", title: "resolver", folder: "Trabajo" }]))
    window.removeEventListener(CHAT_ACTION_EVENT, onAction)
  })

  it("a new chat shows the title without the chevron and cannot be renamed", () => {
    render(<ChatTitleMenu chat={null} />)
    expect(screen.getByTestId("chat-title-rename-trigger")).toBeDisabled()
    expect(screen.getByTestId("chat-title-rename-trigger")).toHaveTextContent("Nuevo chat")
    expect(screen.queryByTestId("chat-title-menu-trigger")).toBeNull()
  })
})
