"use client"

// Database Schema and Operations
export interface User {
  id: string
  name: string
  email: string
  password?: string
  avatar?: string
  plan: "Free" | "Pro" | "Enterprise"
  isAdmin: boolean
  createdAt: Date
  updatedAt: Date
  apiUsage: number
  monthlyLimit: number
}

export interface Chat {
  id: string
  userId: string
  title: string
  messages: Message[]
  model: string
  createdAt: Date
  updatedAt: Date
}

export interface Message {
  id: string
  chatId: string
  role: "user" | "assistant"
  content: string
  timestamp: Date
  tokens?: number
}

export interface Payment {
  id: string
  userId: string
  amount: number
  currency: string
  status: "pending" | "completed" | "failed"
  plan: string
  provider: "paypal" | "mercadopago"
  createdAt: Date
}

export interface ApiUsage {
  id: string
  userId: string
  model: string
  tokens: number
  cost: number
  timestamp: Date
}

// Mock Database Operations (Replace with real database)
class Database {
  private users: User[] = []
  private chats: Chat[] = []
  private payments: Payment[] = []
  private apiUsage: ApiUsage[] = []

  constructor() {
    // Initialize with demo data
    this.initializeData()
  }

  private initializeData() {
    // Demo admin user
    this.users.push({
      id: "admin-1",
      name: "Admin User",
      email: "admin@example.com",
      avatar: "/placeholder.svg?height=32&width=32",
      plan: "Enterprise",
      isAdmin: true,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date(),
      apiUsage: 15420,
      monthlyLimit: 100000,
    })

    // Demo regular users
    for (let i = 1; i <= 50; i++) {
      this.users.push({
        id: `user-${i}`,
        name: `User ${i}`,
        email: `user${i}@example.com`,
        plan: i % 3 === 0 ? "Enterprise" : i % 2 === 0 ? "Pro" : "Free",
        isAdmin: false,
        createdAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
        apiUsage: Math.floor(Math.random() * 10000),
        monthlyLimit: i % 3 === 0 ? 100000 : i % 2 === 0 ? 50000 : 10000,
      })
    }

    // Demo payments
    for (let i = 1; i <= 20; i++) {
      this.payments.push({
        id: `payment-${i}`,
        userId: `user-${i}`,
        amount: i % 3 === 0 ? 99 : i % 2 === 0 ? 29 : 9,
        currency: "USD",
        status: Math.random() > 0.1 ? "completed" : "pending",
        plan: i % 3 === 0 ? "Enterprise" : i % 2 === 0 ? "Pro" : "Free",
        provider: Math.random() > 0.5 ? "paypal" : "mercadopago",
        createdAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000),
      })
    }

    // Demo API usage
    for (let i = 1; i <= 100; i++) {
      this.apiUsage.push({
        id: `usage-${i}`,
        userId: `user-${Math.floor(Math.random() * 50) + 1}`,
        model: ["ChatGPT", "Claude", "Grok", "DeepSeek", "Gemini"][Math.floor(Math.random() * 5)],
        tokens: Math.floor(Math.random() * 1000) + 100,
        cost: Math.random() * 0.1,
        timestamp: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000),
      })
    }
  }

  // User operations
  async createUser(userData: Omit<User, "id" | "createdAt" | "updatedAt">): Promise<User> {
    const user: User = {
      ...userData,
      id: `user-${Date.now()}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.users.push(user)
    return user
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return this.users.find((user) => user.email === email) || null
  }

  async getUserById(id: string): Promise<User | null> {
    return this.users.find((user) => user.id === id) || null
  }

  async getAllUsers(): Promise<User[]> {
    return this.users
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | null> {
    const userIndex = this.users.findIndex((user) => user.id === id)
    if (userIndex === -1) return null

    this.users[userIndex] = { ...this.users[userIndex], ...updates, updatedAt: new Date() }
    return this.users[userIndex]
  }

  // Chat operations
  async createChat(chatData: Omit<Chat, "id" | "createdAt" | "updatedAt">): Promise<Chat> {
    const chat: Chat = {
      ...chatData,
      id: `chat-${Date.now()}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.chats.push(chat)
    return chat
  }

  async getChatsByUserId(userId: string): Promise<Chat[]> {
    return this.chats.filter((chat) => chat.userId === userId)
  }

  async updateChat(id: string, updates: Partial<Chat>): Promise<Chat | null> {
    const chatIndex = this.chats.findIndex((chat) => chat.id === id)
    if (chatIndex === -1) return null

    this.chats[chatIndex] = { ...this.chats[chatIndex], ...updates, updatedAt: new Date() }
    return this.chats[chatIndex]
  }

  async deleteChat(id: string): Promise<boolean> {
    const chatIndex = this.chats.findIndex((chat) => chat.id === id)
    if (chatIndex === -1) return false

    this.chats.splice(chatIndex, 1)
    return true
  }

  // Payment operations
  async createPayment(paymentData: Omit<Payment, "id" | "createdAt">): Promise<Payment> {
    const payment: Payment = {
      ...paymentData,
      id: `payment-${Date.now()}`,
      createdAt: new Date(),
    }
    this.payments.push(payment)
    return payment
  }

  async getPaymentsByUserId(userId: string): Promise<Payment[]> {
    return this.payments.filter((payment) => payment.userId === userId)
  }

  async getAllPayments(): Promise<Payment[]> {
    return this.payments
  }

  // API Usage operations
  async createApiUsage(usageData: Omit<ApiUsage, "id">): Promise<ApiUsage> {
    const usage: ApiUsage = {
      ...usageData,
      id: `usage-${Date.now()}`,
    }
    this.apiUsage.push(usage)
    return usage
  }

  async getApiUsageByUserId(userId: string): Promise<ApiUsage[]> {
    return this.apiUsage.filter((usage) => usage.userId === userId)
  }

  async getAllApiUsage(): Promise<ApiUsage[]> {
    return this.apiUsage
  }

  // Analytics
  async getAnalytics() {
    const totalUsers = this.users.length
    const activeUsers = this.users.filter((user) => {
      const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      return user.updatedAt > lastWeek
    }).length

    const totalRevenue = this.payments
      .filter((payment) => payment.status === "completed")
      .reduce((sum, payment) => sum + payment.amount, 0)

    const totalApiCalls = this.apiUsage.length

    const usersByPlan = {
      Free: this.users.filter((user) => user.plan === "Free").length,
      Pro: this.users.filter((user) => user.plan === "Pro").length,
      Enterprise: this.users.filter((user) => user.plan === "Enterprise").length,
    }

    const revenueByMonth = this.payments
      .filter((payment) => payment.status === "completed")
      .reduce(
        (acc, payment) => {
          const month = payment.createdAt.toISOString().slice(0, 7)
          acc[month] = (acc[month] || 0) + payment.amount
          return acc
        },
        {} as Record<string, number>,
      )

    return {
      totalUsers,
      activeUsers,
      totalRevenue,
      totalApiCalls,
      usersByPlan,
      revenueByMonth,
    }
  }
}

export const db = new Database()
