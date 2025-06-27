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
        <div className="flex h-screen w-full">
          <AdminSidebar />
          <SidebarInset className="flex-1">{children}</SidebarInset>
        </div>
      </SidebarProvider>
    </AuthGuard>
  )
}
