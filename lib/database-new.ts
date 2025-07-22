// "use client"

// import { prisma } from './prisma'

// // Updated database service to work with the new backend
// export class DatabaseService {
//   // User operations
//   async createUser(userData: {
//     name: string
//     email: string
//     password: string
//     plan: string
//     isAdmin: boolean
//     apiUsage: number
//     monthlyLimit: number
//   }) {
//     const response = await fetch('/api/auth/register', {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//       },
//       body: JSON.stringify(userData),
//     })

//     if (!response.ok) {
//       throw new Error('Failed to create user')
//     }

//     return response.json()
//   }

//   async getUserByEmail(email: string) {
//     const response = await fetch(`/api/users/by-email?email=${encodeURIComponent(email)}`)
    
//     if (!response.ok) {
//       return null
//     }

//     const data = await response.json()
//     return data.user
//   }

//   async getUserById(id: string) {
//     const response = await fetch(`/api/users/${id}`)
    
//     if (!response.ok) {
//       return null
//     }

//     const data = await response.json()
//     return data.user
//   }

//   async getAllUsers() {
//     const response = await fetch('/api/admin/users', {
//       headers: {
//         'Authorization': `Bearer ${this.getToken()}`,
//       },
//     })

//     if (!response.ok) {
//       throw new Error('Failed to fetch users')
//     }

//     const data = await response.json()
//     return data.users
//   }

//   // Chat operations
//   async createChat(chatData: {
//     title: string
//     model: string
//   }) {
//     const response = await fetch('/api/chats', {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//         'Authorization': `Bearer ${this.getToken()}`,
//       },
//       body: JSON.stringify(chatData),
//     })

//     if (!response.ok) {
//       throw new Error('Failed to create chat')
//     }

//     const data = await response.json()
//     return data.chat
//   }

//   async getChatsByUserId(userId: string) {
//     const response = await fetch('/api/chats', {
//       headers: {
//         'Authorization': `Bearer ${this.getToken()}`,
//       },
//     })

//     if (!response.ok) {
//       throw new Error('Failed to fetch chats')
//     }

//     const data = await response.json()
//     return data.chats
//   }

//   async updateChat(id: string, updates: any) {
//     const response = await fetch(`/api/chats/${id}`, {
//       method: 'PUT',
//       headers: {
//         'Content-Type': 'application/json',
//         'Authorization': `Bearer ${this.getToken()}`,
//       },
//       body: JSON.stringify(updates),
//     })

//     if (!response.ok) {
//       throw new Error('Failed to update chat')
//     }

//     const data = await response.json()
//     return data.chat
//   }

//   async deleteChat(id: string) {
//     const response = await fetch(`/api/chats/${id}`, {
//       method: 'DELETE',
//       headers: {
//         'Authorization': `Bearer ${this.getToken()}`,
//       },
//     })

//     return response.ok
//   }

//   // Payment operations
//   async createPayment(paymentData: any) {
//     const response = await fetch('/api/payments/stripe', {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//         'Authorization': `Bearer ${this.getToken()}`,
//       },
//       body: JSON.stringify(paymentData),
//     })

//     if (!response.ok) {
//       throw new Error('Failed to create payment')
//     }

//     return response.json()
//   }

//   async getAllPayments() {
//     const response = await fetch('/api/admin/payments', {
//       headers: {
//         'Authorization': `Bearer ${this.getToken()}`,
//       },
//     })

//     if (!response.ok) {
//       throw new Error('Failed to fetch payments')
//     }

//     const data = await response.json()
//     return data.payments
//   }

//   // API Usage operations
//   async createApiUsage(usageData: any) {
//     // This is handled automatically by the AI generation endpoint
//     return usageData
//   }

//   // Analytics
//   async getAnalytics() {
//     const response = await fetch('/api/admin/analytics', {
//       headers: {
//         'Authorization': `Bearer ${this.getToken()}`,
//       },
//     })

//     if (!response.ok) {
//       throw new Error('Failed to fetch analytics')
//     }

//     return response.json()
//   }

//   private getToken(): string {
//     if (typeof window !== 'undefined') {
//       return localStorage.getItem('auth-token') || ''
//     }
//     return ''
//   }
// }

// export const db = new DatabaseService()