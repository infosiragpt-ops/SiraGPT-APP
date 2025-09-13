"use client"

import type React from "react"
import { createContext, useContext, useEffect, useState } from "react"
import { apiClient } from "./api"

interface User {
  id: string
  name: string
  email: string
  avatar?: string
  plan: string
  isAdmin: boolean
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
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const savedToken = localStorage.getItem('auth-token')
        if (savedToken) {
          setToken(savedToken)
          apiClient.setToken(savedToken)

          const response = await apiClient.getCurrentUser()
          setUser(response.user)
        }
      } catch (error) {
        console.error('Auth check failed:', error)
        localStorage.removeItem('auth-token')
        apiClient.setToken(null)
        setToken(null)
      } finally {
        setIsLoading(false)
      }
    }

    checkAuth()
  }, [])

  const login = async (email: string, password: string): Promise<boolean> => {
    setIsLoading(true)
    try {
      const response = await apiClient.login({ email, password })
      setUser(response.user)
      setToken(response.token)
      return true
    } catch (error) {
      console.error('Login failed:', error)
      return false
    } finally {
      setIsLoading(false)
    }
  }

  const register = async (name: string, email: string, password: string): Promise<boolean> => {
    setIsLoading(true)
    try {
      const response = await apiClient.register({ name, email, password })
      setUser(response.user)
      setToken(response.token)
      return true
    } catch (error) {
      console.error('Registration failed:', error)
      return false
    } finally {
      setIsLoading(false)
    }
  }

  const loginWithToken = async (token: string): Promise<boolean> => {
    if (!token) return false;

    setIsLoading(true);
    try {
      // Step 1: Token ko localStorage aur apiClient mein set karein
      localStorage.setItem('auth-token', token);
      apiClient.setToken(token);
      setToken(token); // Context ki state ko update karein

      // Step 2: User ka data hasil karein
      const response = await apiClient.getCurrentUser();

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
      setIsLoading(false);
    }
  };

  const logout = async () => {
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

  return (
    <AuthContext.Provider value={{ user, login, register, logout, isLoading, token, loginWithToken }}>
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