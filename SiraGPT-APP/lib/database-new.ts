"use client"

import { authenticatedFetch } from "./authenticated-fetch"

// Updated database service to work with the new backend
export class DatabaseService {
    // User operations
    async createUser(userData: {
        name: string
        email: string
        password: string
        plan: string
        isAdmin: boolean
        apiUsage: number
        monthlyLimit: number
    }) {
        const response = await authenticatedFetch('/api/auth/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(userData),
        }, {
            bearerToken: null,
        })

        if (!response.ok) {
            throw new Error('Failed to create user')
        }

        return response.json()
    }

    async getUserByEmail(email: string) {
        const response = await authenticatedFetch(`/api/users/by-email?email=${encodeURIComponent(email)}`)

        if (!response.ok) {
            return null
        }

        const data = await response.json()
        return data.user
    }

    async getUserById(id: string) {
        const response = await authenticatedFetch(`/api/users/${id}`)

        if (!response.ok) {
            return null
        }

        const data = await response.json()
        return data.user
    }

    async getAllUsers() {
        const response = await authenticatedFetch('/api/admin/users')

        if (!response.ok) {
            throw new Error('Failed to fetch users')
        }

        const data = await response.json()
        return data.users
    }

    // Chat operations
    async createChat(chatData: {
        title: string
        model: string
    }) {
        const response = await authenticatedFetch('/api/chats', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(chatData),
        })

        if (!response.ok) {
            throw new Error('Failed to create chat')
        }

        const data = await response.json()
        return data.chat
    }

    async getChatsByUserId(userId: string) {
        const response = await authenticatedFetch('/api/chats')

        if (!response.ok) {
            throw new Error('Failed to fetch chats')
        }

        const data = await response.json()
        return data.chats
    }

    async updateChat(id: string, updates: any) {
        const response = await authenticatedFetch(`/api/chats/${id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(updates),
        })

        if (!response.ok) {
            throw new Error('Failed to update chat')
        }

        const data = await response.json()
        return data.chat
    }

    async deleteChat(id: string) {
        const response = await authenticatedFetch(`/api/chats/${id}`, {
            method: 'DELETE',
        })

        return response.ok
    }

    // Payment operations
    async createPayment(paymentData: any) {
        const response = await authenticatedFetch('/api/payments/stripe', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(paymentData),
        })

        if (!response.ok) {
            throw new Error('Failed to create payment')
        }

        return response.json()
    }

    async getAllPayments() {
        const response = await authenticatedFetch('/api/admin/payments')

        if (!response.ok) {
            throw new Error('Failed to fetch payments')
        }

        const data = await response.json()
        return data.payments
    }

    // API Usage operations
    async createApiUsage(usageData: any) {
        // This is handled automatically by the AI generation endpoint
        return usageData
    }

    // Analytics
    async getAnalytics() {
        const response = await authenticatedFetch('/api/admin/analytics')

        if (!response.ok) {
            throw new Error('Failed to fetch analytics')
        }

        return response.json()
    }

    private getToken(): string {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('auth-token') || ''
        }
        return ''
    }
}

export const db = new DatabaseService()