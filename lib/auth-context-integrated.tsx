"use client"

import type React from "react"
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { apiClient } from "./api"
import { devLog } from "./dev-log"
import { clearAllChatDrafts } from "@/hooks/use-chat-draft"

interface User {
  id: string
  name: string
  email: string
  avatar?: string
  plan: string
  isAdmin: boolean
  isSuperAdmin?: boolean
  apiUsage: number
  monthlyLimit: number
  createdAt: string
  updatedAt: string
}

export type AuthSessionStatus = "loading" | "authenticated" | "unauthenticated" | "error"

export type SessionHydrationResult =
  | { status: "authenticated"; user: User }
  | { status: "unauthenticated" }
  | { status: "error"; error: unknown }
  | { status: "cancelled" }

interface AuthContextType {
  user: User | null
  login: (email: string, password: string) => Promise<boolean>
  register: (name: string, email: string, password: string) => Promise<boolean>
  logout: () => void
  isLoading: boolean
  isAuthenticated: boolean
  sessionStatus: AuthSessionStatus
  token: string | null
  loginWithToken: (token: string) => Promise<boolean>
  hydrateSession: () => Promise<SessionHydrationResult>
  /**
   * Patch the current user locally. Useful for UI-only updates (e.g. a local fallback when
   * backend subscription endpoint is not yet implemented).
   */
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)
const AUTH_CHECK_TIMEOUT_MS = 12000

function normalizeLoginPassword(password: string): string {
  return String(password || "")
    .replace(/[\u200B-\u200D\uFEFF\u2028\u2029\r\n\t]/g, "")
    .trim()
}

function withAuthTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeoutId: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), AUTH_CHECK_TIMEOUT_MS)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId)
  })
}

function isUnauthorizedAuthError(error: unknown): boolean {
  const status = Number((error as { status?: unknown; statusCode?: unknown } | null)?.status
    ?? (error as { statusCode?: unknown } | null)?.statusCode)
  return status === 401
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [sessionStatus, setSessionStatus] = useState<AuthSessionStatus>("loading")
  const authEpochRef = useRef(0)
  const mountedRef = useRef(false)
  const sessionHydrationRef = useRef<Promise<SessionHydrationResult> | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const hydrateSession = useCallback(async (): Promise<SessionHydrationResult> => {
    if (sessionHydrationRef.current) return sessionHydrationRef.current

    const hydrationEpoch = ++authEpochRef.current
    const isCurrentHydration = () => (
      mountedRef.current && authEpochRef.current === hydrationEpoch
    )

    // SAML establishes an httpOnly cookie session. Explicitly clear any stale
    // bearer snapshot so /auth/me is authenticated only by that cookie.
    apiClient.setToken(null)
    setToken(null)
    setIsLoading(true)
    setSessionStatus("loading")

    const hydration = (async (): Promise<SessionHydrationResult> => {
      try {
        const response = await withAuthTimeout(
          apiClient.getCurrentUser(),
          "Cookie session check timed out",
        )
        if (!response?.user) {
          throw new Error("Invalid cookie session response")
        }
        if (!isCurrentHydration()) return { status: "cancelled" }

        setUser(response.user)
        setSessionStatus("authenticated")
        return { status: "authenticated", user: response.user }
      } catch (error) {
        if (!isCurrentHydration()) return { status: "cancelled" }

        setUser(null)
        if (isUnauthorizedAuthError(error)) {
          setSessionStatus("unauthenticated")
          return { status: "unauthenticated" }
        }

        console.error("Cookie session hydration failed:", error)
        setSessionStatus("error")
        return { status: "error", error }
      } finally {
        if (isCurrentHydration()) setIsLoading(false)
      }
    })()

    sessionHydrationRef.current = hydration
    void hydration.finally(() => {
      if (sessionHydrationRef.current === hydration) {
        sessionHydrationRef.current = null
      }
    })
    return hydration
  }, [])

  useEffect(() => {
    let cancelled = false

    const checkAuth = async () => {
      const savedToken = localStorage.getItem('auth-token')
      if (!savedToken) {
        await hydrateSession()
        return
      }

      const checkEpoch = authEpochRef.current
      const isCurrentCheck = () => !cancelled && authEpochRef.current === checkEpoch
      try {
        if (!isCurrentCheck()) return
        setToken(savedToken)
        apiClient.setToken(savedToken)

        const response = await withAuthTimeout(
          apiClient.getCurrentUser(),
          'Auth check timed out'
        )
        if (isCurrentCheck()) {
          setUser(response.user)
          setSessionStatus("authenticated")
        }
      } catch (error) {
        if (!isCurrentCheck()) return
        localStorage.removeItem('auth-token')
        apiClient.setToken(null)
        setToken(null)
        setUser(null)
        if (isUnauthorizedAuthError(error)) {
          setSessionStatus("unauthenticated")
        } else {
          console.error('Auth check failed:', error)
          setSessionStatus("error")
        }
      } finally {
        if (isCurrentCheck()) setIsLoading(false)
      }
    }

    checkAuth()

    return () => {
      cancelled = true
    }
  }, [hydrateSession])

  const login = async (email: string, password: string): Promise<boolean> => {
    const loginEpoch = ++authEpochRef.current
    setIsLoading(true)
    setSessionStatus("loading")
    try {
      const response = await apiClient.login({
        email: email.trim(),
        password: normalizeLoginPassword(password),
      })
      if (!response?.user || !response?.token) {
        throw new Error('Invalid login response')
      }
      if (authEpochRef.current !== loginEpoch) return false
      apiClient.setToken(response.token)
      setUser(response.user)
      setToken(response.token)
      setSessionStatus("authenticated")
      return true
    } catch (error) {
      console.error('Login failed:', error)
      if (authEpochRef.current === loginEpoch) {
        setSessionStatus(isUnauthorizedAuthError(error) ? "unauthenticated" : "error")
      }
      return false
    } finally {
      if (authEpochRef.current === loginEpoch) setIsLoading(false)
    }
  }

  const register = async (name: string, email: string, password: string): Promise<boolean> => {
    const registerEpoch = ++authEpochRef.current
    setIsLoading(true)
    setSessionStatus("loading")
    try {
      const response = await apiClient.register({ name, email, password })
      if (authEpochRef.current !== registerEpoch) return false
      setUser(response.user)
      setToken(response.token)
      setSessionStatus("authenticated")
      return true
    } catch (error) {
      console.error('Registration failed:', error)
      if (authEpochRef.current === registerEpoch) setSessionStatus("error")
      return false
    } finally {
      if (authEpochRef.current === registerEpoch) setIsLoading(false)
    }
  }

  const loginWithToken = async (token: string): Promise<boolean> => {
    if (!token) return false;

    const tokenLoginEpoch = ++authEpochRef.current
    setIsLoading(true);
    setSessionStatus("loading");
    try {
      // Step 1: Token ko localStorage aur apiClient mein set karein
      localStorage.setItem('auth-token', token);
      apiClient.setToken(token);
      setToken(token); // Context ki state ko update karein

      // Step 2: User ka data hasil karein
      const response = await apiClient.getCurrentUser();

      if (authEpochRef.current !== tokenLoginEpoch) return false;

      // Step 3: User ki state ko update karein
      setUser(response.user);
      setSessionStatus("authenticated");
      devLog("Auth context updated with token for user:", response.user.name);
      return true;

    } catch (error) {
      console.error('Login with token failed:', error);
      // Agar fail ho jaye to har jagah se token hata dein
      localStorage.removeItem('auth-token');
      apiClient.setToken(null);
      setToken(null);
      setUser(null);
      setSessionStatus(isUnauthorizedAuthError(error) ? "unauthenticated" : "error");
      return false;
    } finally {
      if (authEpochRef.current === tokenLoginEpoch) setIsLoading(false);
    }
  };

  const logout = async () => {
    authEpochRef.current += 1
    try {
      await apiClient.logout()
    } catch (error) {
      console.error('Logout error:', error)
    } finally {
      setUser(null)
      setToken(null)
      setSessionStatus("unauthenticated")
      apiClient.setToken(null)
      // Wipe any saved composer drafts so a different account on the
      // same device cannot see the previous user's unsent chat text.
      clearAllChatDrafts()
    }
  }

  const refreshUser = useCallback(async () => {
    if (!user) return

    try {
      const latestUser = await apiClient.getCurrentUser()
      devLog("Refreshing user in AuthContext:", latestUser)
      setUser(latestUser.user)
    } catch (error) {
      console.error("Failed to refresh user:", error)
      if ((error as any)?.status === 401 || (error as any)?.statusCode === 401) {
        localStorage.removeItem('auth-token')
        apiClient.setToken(null)
        setToken(null)
        setUser(null)
        setSessionStatus("unauthenticated")
      }
    }
  }, [user])

  return (
    <AuthContext.Provider value={{
      user,
      login,
      register,
      logout,
      isLoading,
      isAuthenticated: sessionStatus === "authenticated" && user !== null,
      sessionStatus,
      token,
      loginWithToken,
      hydrateSession,
      refreshUser,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}
