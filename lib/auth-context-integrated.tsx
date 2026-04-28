"use client"

import type React from "react"
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { apiClient } from "./api"

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

interface AuthContextType {
  user: User | null
  login: (email: string, password: string) => Promise<boolean>
  register: (name: string, email: string, password: string) => Promise<boolean>
  logout: () => void
  isLoading: boolean
  token: string | null
  loginWithToken: (token: string) => Promise<boolean>
  /**
   * Patch the current user locally. Useful for UI-only updates (e.g. a local fallback when
   * backend subscription endpoint is not yet implemented).
   */
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)
const AUTH_CHECK_TIMEOUT_MS = 12000

function withAuthTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeoutId: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), AUTH_CHECK_TIMEOUT_MS)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId)
  })
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const authEpochRef = useRef(0)

  useEffect(() => {
    let cancelled = false

    const checkAuth = async () => {
      const checkEpoch = authEpochRef.current
      const isCurrentCheck = () => !cancelled && authEpochRef.current === checkEpoch
      const savedToken = localStorage.getItem('auth-token')
      if (!savedToken) {
        if (!cancelled) setIsLoading(false)
        return
      }

      try {
        if (!isCurrentCheck()) return
        setToken(savedToken)
        apiClient.setToken(savedToken)

        const response = await withAuthTimeout(
          apiClient.getCurrentUser(),
          'Auth check timed out'
        )
        if (isCurrentCheck()) setUser(response.user)
      } catch (error) {
        console.error('Auth check failed:', error)
        if (!isCurrentCheck()) return
        localStorage.removeItem('auth-token')
        apiClient.setToken(null)
        setToken(null)
        setUser(null)
      } finally {
        if (isCurrentCheck()) setIsLoading(false)
      }
    }

    checkAuth()

    return () => {
      cancelled = true
    }
  }, [])

  const login = async (email: string, password: string): Promise<boolean> => {
    const loginEpoch = ++authEpochRef.current
    setIsLoading(true)
    try {
      const response = await apiClient.login({ email: email.trim(), password })
      if (!response?.user || !response?.token) {
        throw new Error('Invalid login response')
      }
      if (authEpochRef.current !== loginEpoch) return false
      apiClient.setToken(response.token)
      setUser(response.user)
      setToken(response.token)
      return true
    } catch (error) {
      console.error('Login failed:', error)
      return false
    } finally {
      if (authEpochRef.current === loginEpoch) setIsLoading(false)
    }
  }

  const register = async (name: string, email: string, password: string): Promise<boolean> => {
    const registerEpoch = ++authEpochRef.current
    setIsLoading(true)
    try {
      const response = await apiClient.register({ name, email, password })
      if (authEpochRef.current !== registerEpoch) return false
      setUser(response.user)
      setToken(response.token)
      return true
    } catch (error) {
      console.error('Registration failed:', error)
      return false
    } finally {
      if (authEpochRef.current === registerEpoch) setIsLoading(false)
    }
  }

  const loginWithToken = async (token: string): Promise<boolean> => {
    if (!token) return false;

    const tokenLoginEpoch = ++authEpochRef.current
    setIsLoading(true);
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
      console.log("Auth context updated with token for user:", response.user.name);
      return true;

    } catch (error) {
      console.error('Login with token failed:', error);
      // Agar fail ho jaye to har jagah se token hata dein
      localStorage.removeItem('auth-token');
      apiClient.setToken(null);
      setToken(null);
      setUser(null);
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
      apiClient.setToken(null)
    }
  }

  const refreshUser = useCallback(async () => {
    if (!token) return

    try {
      const latestUser = await apiClient.getCurrentUser()
      console.log("Refreshing user in AuthContext:", latestUser)
      setUser(latestUser.user)
    } catch (error) {
      console.error("Failed to refresh user:", error)
      if ((error as any)?.status === 401 || (error as any)?.statusCode === 401) {
        localStorage.removeItem('auth-token')
        apiClient.setToken(null)
        setToken(null)
        setUser(null)
      }
    }
  }, [token])

  return (
    <AuthContext.Provider value={{ user, login, register, logout, isLoading, token, loginWithToken, refreshUser }}>
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
