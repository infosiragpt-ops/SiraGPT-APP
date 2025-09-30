"use client"

import { useAuth } from "@/lib/auth-context-integrated"
import { AuthGuard } from "@/components/auth-guard"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Settings as SettingsIcon } from "lucide-react"
import Link from "next/link"
import UserSettings from "@/components/user-settings"

export default function SettingsPage() {
  return (
    <AuthGuard>
      <SettingsContent />
    </AuthGuard>
  )
}

function SettingsContent() {
  const { user } = useAuth()

  if (!user) return null

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Link href="/chat">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Chat
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Account Settings</h1>
            <p className="text-muted-foreground">Manage your preferences, security, and account options</p>
          </div>
        </div>

        <UserSettings />
      </div>
    </div>
  )
}