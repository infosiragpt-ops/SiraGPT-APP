"use client"

// codex/bottom-tab-bar — the mobile bottom navigation for Codex V2 (feature 13):
// Preview · Agent · Web · Conexiones · Checklist · Archivos. Only rendered under
// the md breakpoint (the desktop keeps the resizable-panel layout). Safe-area
// inset, ≥44px targets, an unseen-events badge on Agent, an error dot on Preview.

import React from "react"
import clsx from "clsx"
import { useTranslations } from "next-intl"
import { Eye, Bot, Globe, Plug, ListChecks, Folder } from "lucide-react"
import type { CodexTabId, TabsState } from "@/lib/codex/workspace-tabs"

const TABS: { id: CodexTabId; labelKey: string; icon: any }[] = [
  { id: "preview", labelKey: "tabs.preview", icon: Eye },
  { id: "agent", labelKey: "tabs.agent", icon: Bot },
  { id: "web", labelKey: "tabs.web", icon: Globe },
  { id: "connections", labelKey: "tabs.connections", icon: Plug },
  { id: "checklist", labelKey: "tabs.checklist", icon: ListChecks },
  { id: "files", labelKey: "tabs.files", icon: Folder },
]

export function BottomTabBar({ state, onSelect }: { state: TabsState; onSelect: (tab: CodexTabId) => void }) {
  const t = useTranslations("codex")
  return (
    <nav className="grid grid-cols-6 border-t border-white/10 bg-zinc-950 pb-[env(safe-area-inset-bottom)] md:hidden">
      {TABS.map(({ id, labelKey, icon: Icon }) => {
        const activeTab = state.active === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            aria-current={activeTab ? "page" : undefined}
            className={clsx("relative flex min-h-[44px] flex-col items-center justify-center gap-0.5 py-1.5 text-[10px]", activeTab ? "text-violet-300" : "text-zinc-500")}
          >
            <span className="relative">
              <Icon className="h-5 w-5" />
              {id === "agent" && state.agentUnseen > 0 && (
                <span className="absolute -right-1.5 -top-1 min-w-[14px] rounded-full bg-violet-500 px-1 text-[8px] font-bold leading-[14px] text-white">{state.agentUnseen > 9 ? "9+" : state.agentUnseen}</span>
              )}
              {id === "preview" && state.previewError && <span className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-red-500" />}
            </span>
            <span>{t(labelKey)}</span>
          </button>
        )
      })}
    </nav>
  )
}
