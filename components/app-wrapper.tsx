"use client"

import { usePathname } from "next/navigation"
import { ChatProvider } from "@/lib/chat-context-integrated"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppShell } from "@/components/app-shell"
import { ArtifactPanelProvider } from "@/lib/artifact-panel-context"
import { BackgroundStreamsProvider } from "@/lib/background-streams-context"
import { needsChatContext, needsSidebar } from "@/lib/app-wrapper-routes"

interface AppWrapperProps {
  children: React.ReactNode
}

export function AppWrapper({ children }: AppWrapperProps) {
  const pathname = usePathname()
  const pageNeedsChatContext = needsChatContext(pathname)
  const pageNeedsSidebar = needsSidebar(pathname)

  // For pages that don't need any special layout (home, login, register, etc.)
  if (!pageNeedsChatContext && !pageNeedsSidebar) {
    return <>{children}</>
  }

  // For pages that need chat context and sidebar
  if (pageNeedsChatContext) {
    return (
      <BackgroundStreamsProvider>
        <ChatProvider>
          <ArtifactPanelProvider>
            <SidebarProvider>
              <AppShell>
                {children}
              </AppShell>
            </SidebarProvider>
          </ArtifactPanelProvider>
        </ChatProvider>
      </BackgroundStreamsProvider>
    )
  }

  // For pages that only need sidebar (shouldn't happen with current setup, but future-proof)
  return (
    <SidebarProvider>
      <AppShell>
        {children}
      </AppShell>
    </SidebarProvider>
  )
}
