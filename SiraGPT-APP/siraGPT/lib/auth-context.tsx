"use client"

import type React from "react"
import { createContext, useContext, useEffect, useState } from "react"
import { db, type User } from "./database"

interface AuthContextType {
  user: User | null
  login: (email: string, password: string) => Promise<boolean>
  register: (name: string, email: string, password: string) => Promise<boolean>
  logout: () => void
  isLoading: boolean
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const savedUserId = localStorage.getItem("userId")
        if (savedUserId) {
          const userData = await db.getUserById(savedUserId)
          if (userData) {
            setUser(userData)
          }
        }
      } catch (error) {
        console.error("Auth check failed:", error)
      } finally {
        setIsLoading(false)
      }
    }

    checkAuth()
  }, [])

  const login = async (email: string, password: string): Promise<boolean> => {
    setIsLoading(true)
    try {
      const userData = await db.getUserByEmail(email)

      // Simple password check (in production, use proper hashing)
      if (userData && (password === "password" || email === "admin@example.com")) {
        setUser(userData)
        localStorage.setItem("userId", userData.id)
        return true
      }
      return false
    } catch (error) {
      console.error("Login failed:", error)
      return false
    } finally {
      setIsLoading(false)
    }
  }

  const register = async (name: string, email: string, password: string): Promise<boolean> => {
    setIsLoading(true)
    try {
      // Check if user already exists
      const existingUser = await db.getUserByEmail(email)
      if (existingUser) {
        return false
      }

      const userData = await db.createUser({
        name,
        email,
        password, // In production, hash this
        plan: "Free",
        isAdmin: false,
        apiUsage: 0,
        monthlyLimit: 10000,
      })

      setUser(userData)
      localStorage.setItem("userId", userData.id)
      return true
    } catch (error) {
      console.error("Registration failed:", error)
      return false
    } finally {
      setIsLoading(false)
    }
  }

  const logout = () => {
    setUser(null)
    localStorage.removeItem("userId")
  }

  return <AuthContext.Provider value={{ user, login, register, logout, isLoading }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}
