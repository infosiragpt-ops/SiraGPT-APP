"use client"

import * as React from "react"
import { Check, History, Plus, X } from "lucide-react"

import { cn } from "@/lib/utils"

export const CODE_DEPT_CHAT_CHROME_EVENT = "siragpt:code-dept-chat-chrome"
export const CODE_OPEN_DEPT_DRAWER_EVENT = "siragpt:code-open-dept-drawer"
export const CODE_NEW_DEPT_CONVERSATION_EVENT = "siragpt:code-new-dept-conversation"

export type DeptChatBardDepartment = {
  id: string
  name: string
}

export type DeptChatBardSession = {
  id: string
  title: string
}

export type DeptChatBardNav = {
  companyName: string
  departmentId: string
  departmentName: string
  departments: readonly DeptChatBardDepartment[]
  recentSessions?: readonly DeptChatBardSession[]
  activeSessionId?: string | null
  onSelectDepartment: (departmentId: string) => void
  onSelectSession?: (sessionId: string) => void
  onNewConversation: () => void
  onBackToCompany: () => void
}

export function setDeptChatChrome(active: boolean) {
  if (typeof window === "undefined") return
  if (active) document.documentElement.dataset.deptChatBard = "1"
  else delete document.documentElement.dataset.deptChatBard
  window.dispatchEvent(
    new CustomEvent(CODE_DEPT_CHAT_CHROME_EVENT, { detail: { active } }),
  )
}

export function useDeptChatChrome() {
  const [active, setActive] = React.useState(false)
  React.useEffect(() => {
    const sync = (event: Event) => {
      setActive(Boolean((event as CustomEvent<{ active?: boolean }>).detail?.active))
    }
    setActive(document.documentElement.dataset.deptChatBard === "1")
    window.addEventListener(CODE_DEPT_CHAT_CHROME_EVENT, sync)
    return () => window.removeEventListener(CODE_DEPT_CHAT_CHROME_EVENT, sync)
  }, [])
  return active
}

export function DeptChatBardHeader({
  departmentName: _departmentName,
  onOpenDrawer: _onOpenDrawer,
  onNewConversation: _onNewConversation,
  history: _history,
}: {
  departmentName: string
  onOpenDrawer: () => void
  onNewConversation: () => void
  history?: React.ReactNode
}) {
  // Duplicate title + history + plus bar removed. Sidebar is the nav.
  // Mobile hamburger lives in WorkspaceTopBar; Computadora stays there too.
  return <span hidden data-drop-dup-header="20260815" data-testid="dept-chat-bard-header-hidden" />
}

export function DeptChatDrawer({
  open,
  nav,
  onClose,
}: {
  open: boolean
  nav: DeptChatBardNav
  onClose: () => void
}) {
  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="dept-chat-bard fixed inset-0 z-[80]" data-testid="dept-chat-drawer">
      <button
        type="button"
        className="absolute inset-0 bg-zinc-950/35 backdrop-blur-[2px]"
        aria-label="Cerrar menú"
        onClick={onClose}
      />
      <aside
        className="absolute inset-y-0 left-0 flex w-[86vw] max-w-[320px] flex-col border-r border-border bg-background"
        style={{
          paddingTop: "max(12px, env(safe-area-inset-top))",
          paddingBottom: "max(12px, env(safe-area-inset-bottom))",
        }}
        role="dialog"
        aria-label="Navegación de departamentos"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{nav.companyName}</span>
          <button
            type="button"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            aria-label="Cerrar menú"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <button
            type="button"
            className="flex min-h-11 w-full items-center gap-2 border-b border-border px-3 text-left text-[13px] font-medium hover:bg-muted/50"
            onClick={() => {
              nav.onNewConversation()
              onClose()
            }}
          >
            <Plus className="h-4 w-4 shrink-0" />
            Nueva conversación
          </button>

          <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Departamentos
          </p>
          <nav aria-label="Departamentos">
            {nav.departments.map((department) => {
              const current = department.id === nav.departmentId
              return (
                <button
                  key={department.id}
                  type="button"
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-muted/50",
                    current && "bg-muted/70 font-semibold",
                  )}
                  aria-current={current ? "page" : undefined}
                  onClick={() => {
                    nav.onSelectDepartment(department.id)
                    onClose()
                  }}
                >
                  <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]">{department.name}</span>
                  {current ? <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                </button>
              )
            })}
          </nav>

          {nav.recentSessions && nav.recentSessions.length > 0 ? (
            <>
              <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Recientes en este departamento
              </p>
              {nav.recentSessions.map((session) => {
                const current = session.id === nav.activeSessionId
                return (
                  <button
                    key={session.id}
                    type="button"
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-muted/50",
                      current && "bg-muted/70 font-medium",
                    )}
                    onClick={() => {
                      nav.onSelectSession?.(session.id)
                      onClose()
                    }}
                  >
                    <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                  </button>
                )
              })}
            </>
          ) : null}
        </div>

        <div className="shrink-0 border-t border-border px-3 py-2">
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-center rounded-md border border-border text-[13px] font-medium hover:bg-muted/50"
            onClick={() => {
              nav.onBackToCompany()
              onClose()
            }}
          >
            Volver a la empresa
          </button>
        </div>
      </aside>
    </div>
  )
}

export function DeptChatFab({
  onNewConversation,
}: {
  onNewConversation: () => void
}) {
  return (
    <button
      type="button"
      data-testid="dept-chat-fab"
      aria-label="Nueva conversación"
      onClick={onNewConversation}
      className="dept-chat-bard dept-chat-fab--composer-pro pointer-events-auto inline-flex h-12 items-center gap-2 rounded-full border border-border bg-zinc-950 px-4 text-[13px] font-semibold text-white dark:bg-white dark:text-zinc-950"
    >
      <Plus className="h-4 w-4" />
      Nueva conversación
    </button>
  )
}
