"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

type NavigationTransitionValue = {
  pendingHref: string | null
  pendingLabel: string | null
  isTransitioning: boolean
  markNavigationIntent: (href: string, label?: string) => void
  clearNavigationIntent: () => void
}

const NavigationTransitionContext =
  React.createContext<NavigationTransitionValue | null>(null)

export function normalizeNavigationHref(value?: string | null) {
  if (!value) return "/"

  let path = value

  try {
    if (/^https?:\/\//i.test(value)) {
      path = new URL(value).pathname
    }
  } catch {
    path = value
  }

  path = (path.split("#")[0] || "").split("?")[0] || "/"

  if (!path.startsWith("/")) {
    path = `/${path}`
  }

  return path.replace(/\/+$/, "") || "/"
}

function isSameRouteOrChild(currentPath: string, targetPath: string) {
  return (
    currentPath === targetPath ||
    (targetPath !== "/" && currentPath.startsWith(`${targetPath}/`))
  )
}

export function NavigationTransitionProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const currentPath = normalizeNavigationHref(pathname)
  const [pendingHref, setPendingHref] = React.useState<string | null>(null)
  const [pendingLabel, setPendingLabel] = React.useState<string | null>(null)
  const hasReachedPendingRoute = Boolean(
    pendingHref && isSameRouteOrChild(currentPath, pendingHref),
  )

  const clearNavigationIntent = React.useCallback(() => {
    setPendingHref(null)
    setPendingLabel(null)
  }, [])

  const markNavigationIntent = React.useCallback(
    (href: string, label?: string) => {
      const nextHref = normalizeNavigationHref(href)

      if (isSameRouteOrChild(currentPath, nextHref)) {
        clearNavigationIntent()
        return
      }

      setPendingHref(nextHref)
      setPendingLabel(label?.trim() || null)
    },
    [clearNavigationIntent, currentPath],
  )

  React.useEffect(() => {
    if (pendingHref && hasReachedPendingRoute) {
      clearNavigationIntent()
    }
  }, [clearNavigationIntent, hasReachedPendingRoute, pendingHref])

  React.useEffect(() => {
    if (!pendingHref) return

    const timeout = window.setTimeout(clearNavigationIntent, 3000)
    return () => window.clearTimeout(timeout)
  }, [clearNavigationIntent, pendingHref])

  const value = React.useMemo(
    () => ({
      pendingHref,
      pendingLabel,
      isTransitioning: Boolean(pendingHref && !hasReachedPendingRoute),
      markNavigationIntent,
      clearNavigationIntent,
    }),
    [
      clearNavigationIntent,
      hasReachedPendingRoute,
      markNavigationIntent,
      pendingHref,
      pendingLabel,
    ],
  )

  return (
    <NavigationTransitionContext.Provider value={value}>
      {children}
    </NavigationTransitionContext.Provider>
  )
}

export function useNavigationTransition() {
  const context = React.useContext(NavigationTransitionContext)

  if (!context) {
    throw new Error(
      "useNavigationTransition must be used inside NavigationTransitionProvider",
    )
  }

  return context
}
