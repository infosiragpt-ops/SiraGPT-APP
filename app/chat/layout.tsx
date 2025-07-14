import type React from "react"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset } from "@/components/ui/sidebar"
import { AuthGuard } from "@/components/auth-guard"
import { ChatProvider } from "@/lib/chat-context-integrated"

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <AuthGuard>
      <ChatProvider>
        <SidebarProvider defaultOpen={true}>
          <div className="flex h-screen w-full">
            <AppSidebar />
            <SidebarInset className="flex-1">{children}</SidebarInset>
          </div>
        </SidebarProvider>
      </ChatProvider>
    </AuthGuard>
  )
}
