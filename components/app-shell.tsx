"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, useSidebar } from "@/components/ui/sidebar"
import { AuthGuard } from "@/components/auth-guard"

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  // usePathname is retained even when unused in the JSX — it's the only
  // hook in this component and Fast Refresh tracks render stability by
  // hook count. Removing it once caused "Rendered fewer hooks than
  // expected" during HMR until a full page reload.
  usePathname()
  return (
    <AuthGuard>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <SidebarInset className="min-w-0 flex-1">
          {/* Bridges window-level tool-activation events into
              setOpen(false) on the VISIBLE sidebar's provider. Must
              live here because this level's useSidebar() resolves to
              the outer provider that actually drives the sidebar DOM. */}
          <SidebarCollapseBridge />
          {children}
        </SidebarInset>
      </div>
    </AuthGuard>
  )
}

function SidebarCollapseBridge() {
  const { setOpen, isMobile } = useSidebar()
  // Keep the latest values in refs so the event listener closure
  // stays stable — no need to unmount/remount on every re-render.
  const setOpenRef = React.useRef(setOpen)
  const isMobileRef = React.useRef(isMobile)
  React.useEffect(() => { setOpenRef.current = setOpen }, [setOpen])
  React.useEffect(() => { isMobileRef.current = isMobile }, [isMobile])

  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const onCollapse = () => {
      if (isMobileRef.current) return
      try { setOpenRef.current(false) } catch { /* provider unmounted */ }
    }
    window.addEventListener('siragpt:collapse-sidebar', onCollapse)
    return () => window.removeEventListener('siragpt:collapse-sidebar', onCollapse)
  }, [])
  return null
}
