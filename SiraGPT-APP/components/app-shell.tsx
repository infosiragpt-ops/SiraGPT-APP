"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { AppSidebar } from "@/components/app-sidebar"
import { NavigationTransitionProvider } from "@/components/navigation-transition-context"
import { RouteTransitionShell } from "@/components/route-transition-shell"
import { SidebarInset, useSidebar } from "@/components/ui/sidebar"
import { AuthGuard } from "@/components/auth-guard"
import { useVisualViewportCssVars } from "@/hooks/use-visual-viewport-css-vars"

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname()
  useVisualViewportCssVars({ prefix: "app" })

  return (
    <AuthGuard>
      <NavigationTransitionProvider>
        <div className="app-shell-viewport flex w-full">
          <AppSidebar />
          <SidebarInset className="w-0 min-w-0 flex-1">
            {/* Bridges window-level tool-activation events into
                setOpen(false) on the VISIBLE sidebar's provider. Must
                live here because this level's useSidebar() resolves to
                the outer provider that actually drives the sidebar DOM. */}
            <SidebarCollapseBridge pathname={pathname} />
            <RouteTransitionShell>{children}</RouteTransitionShell>
          </SidebarInset>
        </div>
      </NavigationTransitionProvider>
    </AuthGuard>
  )
}

function SidebarCollapseBridge({ pathname }: { pathname: string | null }) {
  const { setOpen, open, isMobile } = useSidebar()
  // Keep the latest values in refs so the event listener closure
  // stays stable — no need to unmount/remount on every re-render.
  const setOpenRef = React.useRef(setOpen)
  const isMobileRef = React.useRef(isMobile)
  const pathnameRef = React.useRef(pathname)
  React.useEffect(() => { setOpenRef.current = setOpen }, [setOpen])
  React.useEffect(() => { isMobileRef.current = isMobile }, [isMobile])
  React.useEffect(() => { pathnameRef.current = pathname }, [pathname])

  // On /code the agent-company navigator lives in the APPS rail.
  React.useEffect(() => {
    if (!pathname?.startsWith("/code") || isMobile) return
    if (open) return
    try { setOpen(true) } catch { /* provider unmounted */ }
  }, [pathname, isMobile, open, setOpen])

  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const onCollapse = () => {
      if (isMobileRef.current) return
      // Collapsing /code would hide the company navigator.
      if (pathnameRef.current?.startsWith("/code")) return
      try { setOpenRef.current(false) } catch { /* provider unmounted */ }
    }
    window.addEventListener('siragpt:collapse-sidebar', onCollapse)
    return () => window.removeEventListener('siragpt:collapse-sidebar', onCollapse)
  }, [])
  return null
}
