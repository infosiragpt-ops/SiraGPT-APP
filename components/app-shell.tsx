"use client"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset } from "@/components/ui/sidebar"
import { usePathname } from "next/navigation"
import { AuthGuard } from "@/components/auth-guard"
import WhatsAppButton from "@/components/WhatsAppButton"

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
          {pathname.startsWith('/chat') && (
            <WhatsAppButton message="Hi 👋, I'm interested in SiraGPT. Could you share more about its features and pricing?" />
          )}
        </SidebarInset>
      </div>
    </AuthGuard>
  )
}