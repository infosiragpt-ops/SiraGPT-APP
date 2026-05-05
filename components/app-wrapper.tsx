"use client"

import { usePathname } from "next/navigation"
import { ChatProvider } from "@/lib/chat-context-integrated"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppShell } from "@/components/app-shell"
import { ArtifactPanelProvider } from "@/lib/artifact-panel-context"
import { BackgroundStreamsProvider } from "@/lib/background-streams-context"
import { needsChatContext, needsSidebar } from "@/lib/app-wrapper-routes"
import { ErrorBoundary } from "@/components/error-boundary"
import { ConnectionStatus } from "@/components/connection-status"

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
  const pageNeedsChatContext = needsChatContext(pathname)
  const pageNeedsSidebar = needsSidebar(pathname)

  // For pages that don't need any special layout
  if (!pageNeedsChatContext && !pageNeedsSidebar) {
    return <>{children}<ConnectionStatus /></>
  }

  // For pages that need chat context and sidebar
  if (pageNeedsChatContext) {
    if (!pageNeedsSidebar) {
      return (
        <ProviderGuard label="BackgroundStreams">
          <BackgroundStreamsProvider>
            <ProviderGuard label="ChatProvider">
              <ChatProvider>
                <ProviderGuard label="ArtifactPanel">
                  <ArtifactPanelProvider>
                    {children}
                    <ConnectionStatus />
                  </ArtifactPanelProvider>
                </ProviderGuard>
              </ChatProvider>
            </ProviderGuard>
          </BackgroundStreamsProvider>
        </ProviderGuard>
      )
    }

    return (
      <ProviderGuard label="BackgroundStreams">
        <BackgroundStreamsProvider>
          <ProviderGuard label="ChatProvider">
            <ChatProvider>
              <ProviderGuard label="ArtifactPanel">
                <ArtifactPanelProvider>
                  <SidebarProvider>
                    <AppShell>
                      {children}
                      <ConnectionStatus />
                    </AppShell>
                  </SidebarProvider>
                </ArtifactPanelProvider>
              </ProviderGuard>
            </ChatProvider>
          </ProviderGuard>
        </BackgroundStreamsProvider>
      </ProviderGuard>
    )
  }

  // For pages that only need sidebar
  return (
    <SidebarProvider>
      <AppShell>
        {children}
        <ConnectionStatus />
      </AppShell>
    </SidebarProvider>
  )
}
