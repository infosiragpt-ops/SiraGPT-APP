"use client"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset } from "@/components/ui/sidebar"
import { usePathname } from "next/navigation"
import { AuthGuard } from "@/components/auth-guard"

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname()

  return (
    <AuthGuard>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <SidebarInset className="flex-1">
          {children}
        </SidebarInset>
      </div>
    </AuthGuard>
  )
}
