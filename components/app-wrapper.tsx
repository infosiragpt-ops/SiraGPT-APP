"use client"

import { usePathname } from "next/navigation"
import { ChatProvider } from "@/lib/chat-context-integrated"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppShell } from "@/components/app-shell"

interface AppWrapperProps {
  children: React.ReactNode
}

// Pages that need chat context and sidebar
const chatPages = ['/chat', '/gpts', '/profile', '/library']
// Pages that only need sidebar (no chat context)
const sidebarOnlyPages = ['/profile', '/admin']

export function AppWrapper({ children }: AppWrapperProps) {
  const pathname = usePathname()
  
  // Check if current page needs chat context
  const needsChatContext = chatPages.some(page => 
    pathname === page || pathname.startsWith(`${page}/`)
  )
  
  // Check if current page needs sidebar
  const needsSidebar = chatPages.some(page => 
    pathname === page || pathname.startsWith(`${page}/`)
  )

  // For pages that don't need any special layout (home, login, register, etc.)
  if (!needsChatContext && !needsSidebar) {
    return <>{children}</>
  }

  // For pages that need chat context and sidebar
  if (needsChatContext) {
    return (
      <ChatProvider>
        <SidebarProvider defaultOpen={true}>
          <AppShell>
            {children}
          </AppShell>
        </SidebarProvider>
      </ChatProvider>
    )
  }

  // For pages that only need sidebar (shouldn't happen with current setup, but future-proof)
  return (
    <SidebarProvider defaultOpen={true}>
      <AppShell>
        {children}
      </AppShell>
    </SidebarProvider>
  )
}