import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

const sidebar = source("components/app-sidebar.tsx")
const folders = source("components/sidebar/sidebar-folders-dropdown.tsx")
const search = source("components/ChatSearchDialog.tsx")
const settings = source("components/settings/settings-panel.tsx")

describe("sidebar trees stay off the streaming context", () => {
  it("folders dropdown and ⌘K search read the list-only context", () => {
    assert.match(folders, /const \{ selectChat, currentChatId \} = useChatList\(\)/)
    assert.match(folders, /activeChatId=\{currentChatId\}/)
    assert.doesNotMatch(folders, /\buseChat\(\)/)
    assert.match(search, /\} = useChatList\(\)/)
    assert.doesNotMatch(search, /\buseChat\(\)/)
  })
})

describe("⌘K search in-flight state", () => {
  it("derives the spinner from typing OR the pending request and blocks Enter on stale rows", () => {
    assert.match(search, /const \[isFetching, setIsFetching\] = React\.useState\(false\)/)
    // A refetch of the query already on screen keeps its rows usable.
    assert.match(search, /setIsFetching\(settledQueryRef\.current !== query\)\s*\n\s*apiClient\s*\n?\s*\.searchChats/)
    assert.match(search, /const isSearching =\s*\n?\s*\(searchQuery\.trim\(\) !== "" && searchQuery !== debouncedQuery\) \|\| isFetching/)
    assert.match(search, /if \(isSearching\) return/)
  })
})

describe("inline chat rename", () => {
  it("cancel and save buttons keep focus in the input and have Spanish names", () => {
    assert.match(sidebar, /aria-label="Nombre del chat"/)
    assert.match(sidebar, /aria-label="Guardar nombre"[\s\S]{0,200}onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/)
    assert.match(sidebar, /aria-label="Cancelar cambio de nombre"[\s\S]{0,200}onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/)
    // Monochrome: cancel is not destructive, so no red / green tints.
    assert.doesNotMatch(sidebar, /hover:bg-red-100 dark:hover:bg-red-900\/20/)
    assert.doesNotMatch(sidebar, /text-green-600 dark:text-green-400/)
  })

  it("saves through the shared renameChat, once, and skips unchanged titles", () => {
    assert.match(sidebar, /if \(editingChatIdRef\.current !== chatId\) return/)
    assert.match(sidebar, /if \(!newTitle \|\| newTitle === originalTitle\) return/)
    assert.match(sidebar, /const ok = await renameChat\(chatId, newTitle\)/)
    assert.match(sidebar, /toast\.error\("No se pudo cambiar el nombre"\)/)
    assert.doesNotMatch(sidebar, /Failed to update chat title/)
    assert.match(sidebar, /data-chat-row-id=\{chat\.id\}/)
    // Blur-save (clicked elsewhere) must not pull focus back to the row.
    assert.match(sidebar, /onBlur=\{\(\) => handleSaveEdit\(chat\.id, false\)\}/)
    assert.match(sidebar, /if \(restoreFocus\) focusChatRow\(chatId\)/)
  })
})

describe("sidebar keyboard + touch affordances", () => {
  it("nav focus ring uses the ink sidebar ring, not the hairline border", () => {
    assert.match(sidebar, /focus-visible:ring-2 focus-visible:ring-sidebar-ring/)
    assert.doesNotMatch(sidebar, /focus-visible:ring-1 focus-visible:ring-border/)
  })

  it("modified / non-primary presses never mark a navigation intent", () => {
    assert.match(sidebar, /markNewChatIntentFromPointer/)
    assert.doesNotMatch(sidebar, /onPointerDown=\{markNewChatIntent\}/)
    assert.doesNotMatch(sidebar, /onPointerDown=\{markIntent\}/)
  })

  it("chat actions trigger reveal is keyed to hover capability, focus and open state", () => {
    assert.match(sidebar, /group group\/chat-row/)
    assert.match(sidebar, /\[@media\(hover:hover\)\]:opacity-0 \[@media\(hover:hover\)\]:group-hover\/chat-row:opacity-100 group-has-\[:focus-visible\]\/chat-row:opacity-100 data-\[state=open\]:opacity-100/)
    assert.doesNotMatch(sidebar, /md:opacity-0 transition-opacity md:group-hover:opacity-100/)
    // The desktop sidebar root is a `.group` too: unscoped group-hover would
    // reveal every row's trigger (and hide every timestamp) at once.
    assert.match(sidebar, /duration-150 group-hover\/chat-row:opacity-0/)
  })
})

describe("sidebar theming", () => {
  it("filter popover and options follow theme tokens and mark the selection", () => {
    assert.match(sidebar, /const FILTER_POPOVER =\s*\n\s*"[^"]*bg-popover[^"]*text-popover-foreground/)
    assert.doesNotMatch(sidebar, /bg-white p-1 text-zinc-800/)
    assert.doesNotMatch(sidebar, /"bg-zinc-100 font-medium"/)
    assert.match(sidebar, /aria-pressed=\{selected\}/)
    assert.match(sidebar, /const SIDEBAR_TIP =\s*\n\s*"[^"]*dark:bg-zinc-100 dark:text-zinc-950"/)
  })
})

describe("sidebar copy and identity", () => {
  it("sync failures use end-user copy, and archive / hide offer undo", () => {
    assert.doesNotMatch(sidebar, /reinicia el backend/)
    assert.match(sidebar, /no se pudo sincronizar con tu cuenta/)
    assert.match(sidebar, /toast\.success\("Chat ocultado", \{\s*\n\s*action: \{\s*\n\s*label: "Deshacer"/)
    assert.match(sidebar, /toast\.success\("Chat archivado", \{\s*\n\s*action: \{\s*\n\s*label: "Deshacer"/)
  })

  it("footer shows the plan name, never the raw plan code, and real initials", () => {
    assert.match(sidebar, /isPaidPlanCode\(user\?\.plan\) \? planDisplayName\(user\?\.plan\) : t\("freePlan"\)/)
    assert.doesNotMatch(sidebar, /user\?\.plan \|\| t\("freePlan"\)/)
    assert.doesNotMatch(sidebar, /"Admin User"/)
    assert.doesNotMatch(sidebar, /placeholder\.svg/)
  })
})

describe("sidebar loading", () => {
  it("settings dialog is lazy-loaded and mounted on first open", () => {
    assert.doesNotMatch(sidebar, /import \{ SettingsDialog \} from "@\/components\/settings\/settings-dialog"/)
    assert.match(sidebar, /const SettingsDialog = dynamic\(/)
    assert.match(sidebar, /\{settingsEverOpened && \(/)
  })

  it("narrowed folder / filter views pull older pages before claiming they are empty", () => {
    assert.match(sidebar, /const sidebarVisibleChats = React\.useMemo/)
    assert.match(sidebar, /SIDEBAR_AUTOLOAD_MAX_PAGES/)
    assert.match(sidebar, /Buscando en chats anteriores…/)
    // Before the first page lands loadMoreChats is a no-op: don't spend
    // the page budget on it.
    assert.match(sidebar, /isLoadingMore \|\| isLoadingChats \|\| !pagination \|\| !loadMoreChats\) return/)
  })
})

describe("settings panel", () => {
  it("Modelos shows canonical model names, never raw ids", () => {
    assert.match(settings, /title=\{current \? brandModelLabel\(current\) : "Sin seleccionar"\}/)
    assert.match(settings, /title=\{brandModelLabel\(m\)\}/)
    assert.doesNotMatch(settings, /`\$\{current\.provider\} · \$\{current\.name\}`/)
    assert.doesNotMatch(settings, /desc=\{m\.description \|\| m\.name\}/)
  })

  it("bulk archive / clear history refresh the chat list", () => {
    assert.match(settings, /const \{ resetChats, setCurrentChat \} = useChatList\(\)/)
    assert.match(settings, /archivado\(s\)`\)\s*\n\s*resetChats\(\)/)
    assert.match(settings, /papelera`\)\s*\n\s*setCurrentChat\(null\)\s*\n\s*resetChats\(\)/)
  })
})
