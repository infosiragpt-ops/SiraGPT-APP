import type React from "react"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AdminSidebar } from "@/components/admin-sidebar"
import { SidebarInset } from "@/components/ui/sidebar"
import { AuthGuard } from "@/components/auth-guard"

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <AuthGuard requireAdmin={true}>
      <SidebarProvider defaultOpen={true}>
        <div className="admin-shell admin-shell-v20260815 flex h-[100dvh] min-h-0 w-full max-w-full overflow-hidden bg-zinc-50/80">
          <AdminSidebar />
          <SidebarInset className="admin-shell-inset h-full !min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-zinc-50/80">
            <div className="admin-shell-content min-w-0 shrink-0">{children}</div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </AuthGuard>
  )
}
