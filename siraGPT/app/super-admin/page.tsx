"use client"

import { SuperAdminDashboard } from "@/components/super-admin-dashboard"
import { AuthGuard } from "@/components/auth-guard"

export default function SuperAdminPage() {
  return (
    <AuthGuard requireSuperAdmin={true}>
      <SuperAdminDashboard />
    </AuthGuard>
  )
}