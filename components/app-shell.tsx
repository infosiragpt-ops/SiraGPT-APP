"use client"

import * as React from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, useSidebar } from "@/components/ui/sidebar"
import { AuthGuard } from "@/components/auth-guard"

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  return (
    <AuthGuard>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <SidebarInset className="flex-1">
          {/* Bridges tool-activation events from the inner (chat)
              SidebarProvider to this outer one that actually controls
              the visible sidebar. Must live here because useSidebar()
              at this level resolves to the visible provider. */}
          <SidebarCollapseBridge />
          {children}
        </SidebarInset>
      </div>
    </AuthGuard>
  )
}

function SidebarCollapseBridge() {
  const { setOpen, isMobile } = useSidebar()
  React.useEffect(() => {
    if (isMobile) return
    const onCollapse = () => setOpen(false)
    window.addEventListener('siragpt:collapse-sidebar', onCollapse)
    return () => window.removeEventListener('siragpt:collapse-sidebar', onCollapse)
  }, [setOpen, isMobile])
  return null
}
