"use client"

import { AlertTriangle, ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth-context-integrated"

export function ImpersonationBanner() {
  // Super admin should have complete user experience when accessing other accounts
  // No banner needed - return option is in user menu
  return null
}