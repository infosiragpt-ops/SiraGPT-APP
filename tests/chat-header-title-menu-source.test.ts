import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

describe("/agentes header · chat title menu (claude.ai style)", () => {
  const menu = source("components/chat/chat-title-menu.tsx")
  const chatInterface = source("components/chat-interface-enhanced.tsx")
  const sidebar = source("components/app-sidebar.tsx")

  it("mounts the title menu top-left of the chat header", () => {
    assert.match(chatInterface, /import \{ ChatTitleMenu \} from "@\/components\/chat\/chat-title-menu"/)
    assert.match(chatInterface, /className="chat-header-left[^"]*"[\s\S]{0,1400}<ChatTitleMenu/)
    assert.match(menu, /NEW_CHAT_TITLE = "Nuevo chat"/)
  })

  it("puts a claude.ai-style laptop before the title that opens this chat's computer", () => {
    const badge = source("components/chat/chat-computer-badge.tsx")
    assert.match(chatInterface, /import \{ ChatComputerBadge \} from "@\/components\/chat\/chat-computer-badge"/)
    assert.match(chatInterface, /<ChatComputerBadge working=\{isStopButtonVisible\}[^>]*onOpen=\{toggleComputerPanel\} \/>\s*<ChatTitleMenu/)
    assert.match(chatInterface, /const toggleComputerPanel = React\.useCallback\(\(\) => \{[\s\S]{0,160}openComputerPanel\(\)/)
    assert.match(badge, /<Laptop /)
    assert.match(badge, /data-testid="chat-computer-badge"/)
    assert.match(badge, /aria-pressed=\{active\}/)
    assert.match(badge, /animate-ping[^"]*motion-reduce:animate-none/)
    assert.match(badge, /Computadora de este chat/)
  })

  it("offers Fijar · Cambiar nombre · Compartir chat · Eliminar with P/R/D hints", () => {
    assert.match(menu, /\{isPinned \? "Desfijar" : "Fijar"\}/)
    assert.match(menu, /Cambiar nombre/)
    assert.match(menu, /Compartir chat/)
    assert.match(menu, /<DropdownMenuSeparator/)
    assert.match(menu, /Eliminar\s*<DropdownMenuShortcut[^>]*>D<\/DropdownMenuShortcut>/)
    assert.match(menu, /<DropdownMenuShortcut className=\{MENU_KEY\}>P<\/DropdownMenuShortcut>/)
    assert.match(menu, /<DropdownMenuShortcut className=\{MENU_KEY\}>R<\/DropdownMenuShortcut>/)
    assert.match(menu, /text-red-600/)
  })

  it("single-key shortcuts only work while the menu is open, never globally", () => {
    assert.match(menu, /<DropdownMenuContent[\s\S]{0,200}onKeyDown=\{handleMenuKeyDown\}/)
    assert.match(menu, /if \(key === "p"\)/)
    assert.match(menu, /else if \(key === "r"\)/)
    assert.match(menu, /else if \(key === "d"\)/)
    assert.doesNotMatch(menu, /addEventListener\("keydown"/)
  })

  it("is accessible: menu trigger semantics, labelled rename input, AlertDialog delete", () => {
    assert.match(menu, /aria-haspopup="menu"/)
    assert.match(menu, /aria-expanded=\{menuOpen\}/)
    assert.match(menu, /aria-label="Nombre del chat"/)
    assert.match(menu, /event\.key === "Enter"/)
    assert.match(menu, /event\.key === "Escape"/)
    assert.match(menu, /onBlur=\{\(\) => \{ void finishRename\(true\) \}\}/)
    assert.match(menu, /<AlertDialog/)
    assert.match(menu, /<AlertDialogTitle>Eliminar chat<\/AlertDialogTitle>/)
    assert.match(menu, /max-w-\[48ch\] truncate/)
  })

  it("shares one pinned-chats module between the sidebar and the header", () => {
    assert.match(menu, /from "@\/lib\/chat\/pinned-chats"/)
    assert.match(sidebar, /from "@\/lib\/chat\/pinned-chats"/)
    assert.match(sidebar, /PINNED_CHATS_CHANGED_EVENT/)
    const lib = source("lib/chat/pinned-chats.ts")
    assert.match(lib, /PINNED_CHATS_STORAGE_KEY = "sira:pinned-chat-ids"/)
    assert.match(lib, /PINNED_CHATS_CHANGED_EVENT = "siragpt:pinned-chats-changed"/)
    assert.match(lib, /apiClient\.pinChat\(chatId, pinned\)/)
    assert.doesNotMatch(sidebar, /apiClient\.pinChat\(/)
  })

  it("renames through the chat context so the sidebar list refreshes", () => {
    const ctx = source("lib/chat-context-integrated.tsx")
    assert.match(ctx, /renameChat: \(chatId: string, title: string\) => Promise<boolean>/)
    assert.match(menu, /const \{ renameChat, deleteChat \} = useChatList\(\)/)
  })

  it("keeps the header actions compact with a «Compartir» pill", () => {
    assert.match(chatInterface, /title="Compartir conversación completa"[\s\S]{0,400}<span>Compartir<\/span>/)
    assert.match(chatInterface, /data-testid="chat-computer-button"[\s\S]{0,200}h-9 w-9/)
    assert.match(chatInterface, /tChat\("disclaimer"\)/)
    const es = JSON.parse(source("messages/es.json"))
    assert.equal(es.chat.disclaimer, "SiraGPT puede cometer errores. Comprueba la información importante.")
  })
})
