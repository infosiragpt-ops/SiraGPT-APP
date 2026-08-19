"use client"

import { authenticatedFetch } from "./authenticated-fetch"

// Simple Gmail service - only handles OAuth connection
class GmailService {
  private baseURL: string

  constructor() {
    this.baseURL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'
  }

  // Get Gmail auth URL for connection
  async connectGmail(): Promise<{ authUrl: string }> {
    try {
      // Get auth token from localStorage
      const token = typeof window !== 'undefined' ? localStorage.getItem('auth-token') : null;
      
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };
      
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await authenticatedFetch(`${this.baseURL}/auth/gmail`, {
        method: 'GET',
        credentials: 'include',
        headers,
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      return await response.json()
    } catch (error) {
      console.error('Error getting Gmail auth URL:', error)
      throw error
    }
  }
}

// Simple Gmail service instance - only handles OAuth connection
export const gmailService = new GmailService()