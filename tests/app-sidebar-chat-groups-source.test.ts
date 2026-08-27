import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const sidebarPath = path.join(process.cwd(), "components", "app-sidebar.tsx")
const source = fs.readFileSync(sidebarPath, "utf8")

describe("app sidebar single recent-chats collapse source contract", () => {
  it("persists one collapsed state for the whole recent-chats section", () => {
    assert.match(source, /sira:sidebar:recent-collapsed/,
      "recent-chats collapse state must be persisted under its own key")
    assert.match(source, /recentChatsCollapsed/,
      "component should keep a single collapsed state for the recent-chats section")
    assert.match(source, /toggleRecentChatsCollapsed/,
      "component should expose one toggle handler for the recent-chats section")
  })

  it("exposes the collapse control on the Recent chats header with accessible wiring", () => {
    assert.match(source, /aria-expanded=\{!recentChatsCollapsed\}/,
      "the section header must disclose its expanded state")
    assert.match(source, /aria-controls="sidebar-recent-chats-content"/,
      "the header must point to the controlled recent-chats region")
    assert.match(source, /id="sidebar-recent-chats-content"/,
      "the recent-chats content region needs a stable controlled id")
  })

  it("no longer collapses individual date buckets", () => {
    assert.doesNotMatch(source, /toggleChatGroupCollapsed/,
      "per-date-group collapse handlers should be gone")
    assert.doesNotMatch(source, /collapsedChatGroups/,
      "per-date-group collapse state should be gone")
    assert.doesNotMatch(source, /sira:sidebar:chat-groups-collapsed/,
      "the per-group storage key should be removed")
  })
})

describe("app sidebar recent-chats toolbar source contract", () => {
  it("removes the standalone Buscar chats row from the Nuevo chat / Library nav block", () => {
    const navStart = source.indexOf("New Chat, Search, and Library")
    const libraryStart = source.indexOf('href="/library"')
    assert.ok(navStart > 0 && libraryStart > navStart, "nav block markers must exist")
    const navBlock = source.slice(navStart, libraryStart)
    assert.doesNotMatch(navBlock, /t\("searchChats"\)/,
      "the open sidebar nav must not keep a Buscar chats menu row")
    assert.doesNotMatch(navBlock, /<SidebarMenuButton[\s\S]*searchChats/,
      "search must not remain a SidebarMenuButton in the nav list")
    assert.match(source, /data-sidebar-collapsed-search="1"/,
      "the collapsed icon-rail may keep a search affordance that opens the dialog")
  })

  it("renders Carpetas above recent chats with a + aligned to the 3-dot column", () => {
    const foldersStart = source.indexOf('id="sidebar-chat-folders-toolbar"')
    const recentsStart = source.indexOf('id="sidebar-recent-chats-toolbar"')
    assert.ok(foldersStart > 0, "Carpetas toolbar must exist")
    assert.ok(recentsStart > foldersStart, "Carpetas must sit above Chats recientes")
    const folders = source.slice(foldersStart, recentsStart)
    assert.match(folders, /data-sidebar-folders-toolbar="1"/)
    assert.match(folders, /data-sidebar-folders-add="1"/)
    assert.match(folders, />\s*Carpetas\s*</)
    assert.match(folders, /aria-label="Nueva carpeta"/)
    assert.match(folders, /<Plus className="h-3\.5 w-3\.5"/)
    assert.match(folders, /FOLDER_ADD_ICON/)
    assert.match(folders, /flex h-8 min-w-0 flex-1 items-center/)
    assert.match(source, /const CHAT_ROW_SLOT =[\s\S]*flex h-8 w-8/)
    assert.match(source, /const FOLDER_ADD_ICON =[\s\S]*CHAT_ROW_SLOT/)
    assert.match(source, /CHAT_ROW_SLOT[\s\S]*aria-label="Acciones del chat"/)
    assert.match(source, /openCreateFolderDialog/)
    assert.doesNotMatch(source, /createFolderAndMove/)
    assert.doesNotMatch(source, /window\.prompt\("Nombre de la carpeta"\)/)
  })

  it("lets folders receive conversations by click, drop, and send dialog", () => {
    const foldersStart = source.indexOf('id="sidebar-chat-folders-toolbar"')
    const recentsStart = source.indexOf('id="sidebar-recent-chats-toolbar"')
    const folders = source.slice(foldersStart, recentsStart)
    assert.match(folders, /data-sidebar-folder-row="1"/)
    assert.match(folders, /openSendChatToFolderDialog/)
    assert.match(folders, /Enviar conversación/)
    assert.match(folders, /onDrop=/)
    assert.match(source, /selectedFolder/)
    assert.match(source, /filterChatsByFolder/)
    assert.match(source, /encodeChatFolderDragId/)
    assert.match(source, /draggable=\{!isEditing\}/)
    assert.match(source, /Esta carpeta está vacía/)
  })

  it("opens the centered ChatSearchDialog from the recent-chats lupa and ⌘K", () => {
    const toolbarStart = source.indexOf('id="sidebar-recent-chats-toolbar"')
    assert.ok(toolbarStart > 0, "recent-chats toolbar id must exist")
    const toolbar = source.slice(toolbarStart, source.indexOf('id="sidebar-recent-chats-content"'))
    assert.match(toolbar, /data-sidebar-recent-toolbar="1"/)
    assert.match(toolbar, /data-sidebar-recent-search="1"/)
    assert.match(toolbar, /data-sidebar-recent-filter="1"/)
    assert.match(toolbar, /Buscar ⌘K/)
    assert.match(toolbar, /onClick=\{handleSearchClick\}/)
    assert.match(toolbar, /SlidersHorizontal/)
    assert.match(toolbar, /Filtrar chats/)
    assert.match(toolbar, /label: "Tipo"/)
    assert.match(toolbar, /label: "Estado"/)
    assert.match(toolbar, /Última actividad/)
    assert.match(toolbar, /Agrupar por/)
    assert.match(toolbar, /Programados/)
    assert.match(toolbar, /Archivados/)
    assert.match(toolbar, /Fijados/)
    assert.match(source, /filterRecentChats/)
    assert.match(source, /groupChatsByTime/)
    assert.match(source, /ChatSearchDialog/)
    assert.match(source, /setSearchOpen\(\(current\) => !current\)/)
    assert.match(source, /addEventListener\("keydown", onKeyDown, true\)/)
    assert.doesNotMatch(source, /openInlineSearch/)
    assert.doesNotMatch(source, /inlineSearchOpen/)
    assert.doesNotMatch(source, /inlineSearchQuery/)
    assert.doesNotMatch(source, /Buscar en todo el historial/)
    assert.doesNotMatch(toolbar, /<input/)
  })

  it("keeps Spanish collapse tooltips and the Claude-style header strip", () => {
    assert.match(source, /Contraer barra lateral ⌘B/)
    assert.match(source, /Expandir barra lateral ⌘B/)
    // The old Agentes|Empresas tablist moved out of the header; Empresas is
    // now a nav-row mode toggle and the strip carries history + new chat.
    assert.doesNotMatch(source, /Modo de la barra lateral/)
    assert.match(source, /aria-label="Atrás"/)
    assert.match(source, /aria-label="Adelante"/)
    assert.match(source, /aria-label="Nuevo chat ⌘N"/)
    assert.match(source, /aria-label="Empresas"/)
    assert.doesNotMatch(source, /data-testid="sidebar-apps-tab"/)
    assert.doesNotMatch(source, /aria-label="Chats"/)
    assert.doesNotMatch(source, /<Code2/)
    assert.match(source, /href="\/conexiones"/)
    assert.match(source, /label="Apps"/)
  })
})
