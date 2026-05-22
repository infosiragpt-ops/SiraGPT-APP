"use client"

// All the client-side providers consolidated into a single chunk
// boundary. app/layout.tsx imports this via next/dynamic so the giant
// bundle of ThemeProvider + AuthProvider + SettingsProvider + AppWrapper
// (which itself pulls in ChatProvider, SidebarProvider, AppShell, the
// artifact panel context, background-streams context, katex, sonner,
// and the entire UI shell) lives in its own chunk rather than inside
// app/layout.js. Keeping app/layout.js small is what lets the Replit
// dev preview proxy deliver it intact (it caps responses around 1 MB
// and silently truncates anything larger, breaking hydration).

import * as React from "react"
import { ThemeProvider } from "@/components/theme-provider"
import { AuthProvider } from "@/lib/auth-context-integrated"
import { SettingsProvider } from "@/lib/settings-context"
import { AppWrapper } from "@/components/app-wrapper"
import { ErrorBoundary } from "@/components/error-boundary"
import { GlobalDropRedirector } from "@/components/GlobalDropRedirector"
import { Toaster } from "@/components/ui/sonner"
import { KeyboardShortcutsProvider } from "@/components/keyboard-shortcuts"
import { OfflineBanner } from "@/components/offline-banner"

export function RootProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <AuthProvider>
        <SettingsProvider>
          <AppWrapper>
            <ErrorBoundary label="root:app">
              {children}
            </ErrorBoundary>
          </AppWrapper>
          <GlobalDropRedirector />
          <KeyboardShortcutsProvider />
          <OfflineBanner />
          <Toaster />
        </SettingsProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}
