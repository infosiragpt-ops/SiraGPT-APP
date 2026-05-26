"use client"

/**
 * Global keyboard shortcuts + help modal + command palette.
 *
 * Lote B del plan de 100 mejoras (#53, #57, #64–#69).
 *
 * Mounts a single global keydown listener on `window` that handles:
 *   · "?"               → open shortcuts help modal
 *   · Cmd/Ctrl+K        → open command palette (cmdk)
 *   · Cmd/Ctrl+N        → new chat (router.push("/"))
 *   · Cmd/Ctrl+/        → toggle theme (light ↔ dark)
 *   · Esc               → close any open shortcut UI we own
 *
 * Already handled elsewhere (we document them in the help modal but
 * do NOT re-bind):
 *   · Cmd/Ctrl+B        → toggle sidebar (components/ui/sidebar.tsx)
 *   · Shift+Enter       → newline in composers
 *   · Enter             → send (composer-local)
 *
 * Design notes:
 *   · We skip our listener entirely when the focused element is an
 *     input / textarea / contenteditable, EXCEPT for the Cmd/Ctrl
 *     combos. Without this, hitting "?" inside the chat composer
 *     would open the help modal instead of typing a question mark.
 *   · We respect `data-no-global-shortcuts` on any ancestor element
 *     so editors (Monaco, CodeMirror, Syncfusion spreadsheet) can
 *     opt out of Cmd+K hijacking inside their own command palettes.
 *   · The command palette items are intentionally minimal for v1:
 *     navigation + theme + new chat. Chat search is its own thing
 *     (ChatSearchDialog) and we don't duplicate it here.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Home,
  MessageSquarePlus,
  Image as ImageIcon,
  Video,
  Code2,
  Folder,
  Settings,
  CreditCard,
  Sun,
  Moon,
  Keyboard,
  Camera,
} from "lucide-react"

type Shortcut = { combo: string; description: string }

const SHORTCUTS: Array<{ section: string; items: Shortcut[] }> = [
  {
    section: "Navegación",
    items: [
      { combo: "Cmd/Ctrl + K", description: "Abrir paleta de comandos" },
      { combo: "Cmd/Ctrl + N", description: "Nuevo chat" },
      { combo: "Cmd/Ctrl + B", description: "Mostrar u ocultar la barra lateral" },
    ],
  },
  {
    section: "Composición",
    items: [
      { combo: "Enter", description: "Enviar mensaje" },
      { combo: "Shift + Enter", description: "Nueva línea sin enviar" },
    ],
  },
  {
    section: "Apariencia",
    items: [
      { combo: "Cmd/Ctrl + /", description: "Cambiar entre tema claro y oscuro" },
    ],
  },
  {
    section: "General",
    items: [
      { combo: "?", description: "Mostrar este panel de atajos" },
      { combo: "Esc", description: "Cerrar diálogos y menús" },
    ],
  },
]

/**
 * Returns true when the currently focused element is something where
 * single-key shortcuts ("?", "/") would interfere with normal typing.
 * Combo shortcuts (Cmd/Ctrl + ...) are always honored regardless.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (target.isContentEditable) return true
  return false
}

/**
 * Returns true when the event originated inside an opt-out subtree
 * (e.g. Monaco editor, Syncfusion spreadsheet) that has its own
 * keybindings and should swallow ours.
 */
function isInOptOutSubtree(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !!target.closest("[data-no-global-shortcuts]")
}

export function KeyboardShortcutsProvider() {
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const [helpOpen, setHelpOpen] = React.useState(false)
  const [paletteOpen, setPaletteOpen] = React.useState(false)

  // Stable ref to the latest theme so the keydown handler doesn't
  // need to re-bind whenever next-themes flips the resolved value.
  const themeRef = React.useRef(resolvedTheme)
  React.useEffect(() => {
    themeRef.current = resolvedTheme
  }, [resolvedTheme])

  const toggleTheme = React.useCallback(() => {
    const next = themeRef.current === "dark" ? "light" : "dark"
    setTheme(next)
  }, [setTheme])

  const newChat = React.useCallback(() => {
    // Same destination the sidebar "Nuevo chat" button uses.
    router.push("/")
  }, [router])

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isInOptOutSubtree(event.target)) return

      const meta = event.metaKey || event.ctrlKey
      const typing = isTypingTarget(event.target)

      // Cmd/Ctrl combos — always honored.
      if (meta && !event.shiftKey && !event.altKey) {
        const key = event.key.toLowerCase()
        if (key === "k") {
          event.preventDefault()
          setPaletteOpen((v) => !v)
          return
        }
        if (key === "n") {
          event.preventDefault()
          newChat()
          return
        }
        if (key === "/") {
          event.preventDefault()
          toggleTheme()
          return
        }
        // Cmd+B is owned by SidebarProvider — don't touch.
      }

      // Single-key shortcuts — only when NOT typing.
      if (!meta && !event.altKey && !typing) {
        if (event.key === "?") {
          event.preventDefault()
          setHelpOpen((v) => !v)
          return
        }
      }
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [newChat, toggleTheme])

  const go = React.useCallback(
    (path: string) => {
      setPaletteOpen(false)
      router.push(path)
    },
    [router],
  )

  return (
    <>
      <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <CommandInput placeholder="Escribe una acción o página…" />
        <CommandList>
          <CommandEmpty>Sin resultados.</CommandEmpty>
          <CommandGroup heading="Acciones">
            <CommandItem
              onSelect={() => {
                setPaletteOpen(false)
                newChat()
              }}
            >
              <MessageSquarePlus className="mr-2 h-4 w-4" />
              <span>Nuevo chat</span>
              <span className="ml-auto text-xs text-muted-foreground">Cmd/Ctrl+N</span>
            </CommandItem>
            <CommandItem
              onSelect={() => {
                setPaletteOpen(false)
                toggleTheme()
              }}
            >
              {themeRef.current === "dark" ? (
                <Sun className="mr-2 h-4 w-4" />
              ) : (
                <Moon className="mr-2 h-4 w-4" />
              )}
              <span>Cambiar tema</span>
              <span className="ml-auto text-xs text-muted-foreground">Cmd/Ctrl+/</span>
            </CommandItem>
            <CommandItem
              onSelect={() => {
                setPaletteOpen(false)
                setHelpOpen(true)
              }}
            >
              <Keyboard className="mr-2 h-4 w-4" />
              <span>Ver atajos de teclado</span>
              <span className="ml-auto text-xs text-muted-foreground">?</span>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Ir a">
            <CommandItem onSelect={() => go("/")}>
              <Home className="mr-2 h-4 w-4" />
              <span>Inicio</span>
            </CommandItem>
            <CommandItem onSelect={() => go("/chat")}>
              <MessageSquarePlus className="mr-2 h-4 w-4" />
              <span>Chat</span>
            </CommandItem>
            <CommandItem onSelect={() => go("/library")}>
              <Folder className="mr-2 h-4 w-4" />
              <span>Biblioteca</span>
            </CommandItem>
            <CommandItem onSelect={() => go("/code")}>
              <Code2 className="mr-2 h-4 w-4" />
              <span>Codex</span>
            </CommandItem>
            <CommandItem onSelect={() => go("/gpts")}>
              <ImageIcon className="mr-2 h-4 w-4" />
              <span>GPTs</span>
            </CommandItem>
            <CommandItem onSelect={() => go("/voice")}>
              <Video className="mr-2 h-4 w-4" />
              <span>Voz</span>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Cuenta">
            <CommandItem onSelect={() => go("/settings")}>
              <Settings className="mr-2 h-4 w-4" />
              <span>Configuración</span>
            </CommandItem>
            <CommandItem onSelect={() => go("/settings/appshots")}>
              <Camera className="mr-2 h-4 w-4" />
              <span>Sira Appshots</span>
            </CommandItem>
            <CommandItem onSelect={() => go("/billing")}>
              <CreditCard className="mr-2 h-4 w-4" />
              <span>Facturación</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Keyboard className="h-5 w-5" />
              Atajos de teclado
            </DialogTitle>
            <DialogDescription>
              Acelera tu flujo con estos atajos. En Mac usa <kbd className="rounded border px-1 text-xs">Cmd</kbd>; en Windows / Linux usa <kbd className="rounded border px-1 text-xs">Ctrl</kbd>.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 space-y-5">
            {SHORTCUTS.map((group) => (
              <div key={group.section}>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.section}
                </h3>
                <ul className="space-y-1.5">
                  {group.items.map((s) => (
                    <li
                      key={s.combo}
                      className="flex items-center justify-between gap-4 text-sm"
                    >
                      <span className="text-foreground/90">{s.description}</span>
                      <kbd className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs text-foreground">
                        {s.combo}
                      </kbd>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
