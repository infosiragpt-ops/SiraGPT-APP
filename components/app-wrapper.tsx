"use client"

import { usePathname } from "next/navigation"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppShell } from "@/components/app-shell"
import { ArtifactPanelProvider } from "@/lib/artifact-panel-context"
import { needsChatContext, needsSidebar } from "@/lib/app-wrapper-routes"
import { isAgentsHomePath } from "@/lib/agents-home-path"
import { useAuth } from "@/lib/auth-context-integrated"
import { ErrorBoundary } from "@/components/error-boundary"

interface AppWrapperProps {
  children: React.ReactNode
}

/**
 * ProviderGuard — wraps a children block in an ErrorBoundary that
 * isolates provider crashes so the entire app doesn't white-screen.
 * The label helps identify which provider failed in production logs.
 */
function ProviderGuard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <ErrorBoundary
      label={`provider:${label}`}
      fallback={(error, reset) => (
        <div className="flex flex-col items-center justify-center min-h-[200px] p-6 text-center">
          <div className="text-sm font-medium text-destructive mb-2">
            Error en {label}
          </div>
          <div className="text-xs text-muted-foreground mb-4 max-w-md">
            {error.message || "El servicio no está disponible"}
          </div>
          <button
            onClick={reset}
            className="text-xs underline text-muted-foreground hover:text-foreground"
          >
            Reintentar
          </button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}

export function AppWrapper({ children }: AppWrapperProps) {
  const pathname = usePathname()
  const { user, isLoading } = useAuth()
  const agentsHome = isAgentsHomePath(pathname) && Boolean(user) && !isLoading
  const pageNeedsChatContext = needsChatContext(pathname) || agentsHome
  const pageNeedsSidebar = needsSidebar(pathname) || agentsHome

  // ChatProvider + BackgroundStreams live in RootProviders so a Word/doc
  // job survives leaving /chat. This wrapper only toggles chrome.
  if (!pageNeedsChatContext && !pageNeedsSidebar) {
    return <>{children}</>
  }

  if (pageNeedsChatContext) {
    if (!pageNeedsSidebar) {
      return (
        <ProviderGuard label="ArtifactPanel">
          <ArtifactPanelProvider>
            {children}
          </ArtifactPanelProvider>
        </ProviderGuard>
      )
    }

    return (
      <ProviderGuard label="ArtifactPanel">
        <ArtifactPanelProvider>
          <SidebarProvider>
            <AppShell>
              {children}
            </AppShell>
          </SidebarProvider>
        </ArtifactPanelProvider>
      </ProviderGuard>
    )
  }

  // For pages that only need sidebar
  return (
    <SidebarProvider>
      <AppShell>
        {children}
      </AppShell>
    </SidebarProvider>
  )
}
