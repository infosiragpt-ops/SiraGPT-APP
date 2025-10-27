"use client"

export interface CustomGPT {
  id: string
  name: string
  description: string
  iconUrl?: string
  instructions: string
  greetingMessage?: string
  modelName: string
  temperature: number
  maxTokens?: number
  actions?: any[]
  conversationStarters?: string[]
  visibility: 'PRIVATE' | 'UNLISTED' | 'PUBLIC'
  shareId: string
  category?: string
  isFeatured?: boolean
  creator: {
    id: string
    name: string
    avatar?: string
  }
  createdAt: string
  updatedAt: string
  _count?: {
    conversations?: number
    likes?: number
  }
  isLiked?: boolean
}

export interface CreateGPTData {
  name: string
  description?: string
  iconFile?: File
  iconUrl?: string
  instructions: string
  greetingMessage?: string
  modelName?: string
  temperature?: number
  maxTokens?: number
  conversationStarters?: string[]
  visibility?: 'PRIVATE' | 'UNLISTED' | 'PUBLIC'
  category?: string
  actions?: any[]
  capabilities?: {
    webBrowsing?: boolean
    dataAnalysis?: boolean
    imageGeneration?: boolean
    codeInterpreter?: boolean
  }
}

export interface GPTFilters {
  category?: string
  search?: string
  featured?: boolean
  visibility?: 'all' | 'mine' | 'public'
}

class GPTsService {
  // Use environment variable or fallback to localhost:5000
  private baseUrl = `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'}/gpts`

  async getGPTs(filters: GPTFilters = {}): Promise<CustomGPT[]> {
    try {
      const params = new URLSearchParams()

      if (filters.category) params.append('category', filters.category)
      if (filters.search) params.append('search', filters.search)
      if (filters.featured) params.append('featured', 'true')
      if (filters.visibility && filters.visibility !== 'all') {
        params.append('visibility', filters.visibility)
      }

      const response = await fetch(`${this.baseUrl}?${params.toString()}`, {
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
        },
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch GPTs: ${response.statusText}`)
      }

      const data = await response.json()
      return data.gpts || []
    } catch (error) {
      console.error('Error fetching GPTs:', error)
      throw error
    }
  }

  async getGPT(id: string): Promise<CustomGPT> {
    try {
      const response = await fetch(`${this.baseUrl}/${id}`, {
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
        },
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch GPT: ${response.statusText}`)
      }

      const data = await response.json()
      return data.gpt
    } catch (error) {
      console.error('Error fetching GPT:', error)
      throw error
    }
  }

  async getGPTByShareId(shareId: string): Promise<CustomGPT> {
    try {
      const response = await fetch(`${this.baseUrl}/share/${shareId}`, {
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
        },
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch shared GPT: ${response.statusText}`)
      }

      const data = await response.json()
      return data.gpt
    } catch (error) {
      console.error('Error fetching shared GPT:', error)
      throw error
    }
  }

  async createGPT(gptData: CreateGPTData): Promise<CustomGPT> {
    try {
      const { iconFile, ...jsonData } = gptData
      const formData = new FormData()

      // Append JSON data as a string
      formData.append('gpts', JSON.stringify(jsonData))

      // Append file if it exists
      if (iconFile) {
        formData.append('icon', iconFile)
      }

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
        },
        credentials: 'include',
        body: formData,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || `Failed to create GPT: ${response.statusText}`)
      }

      const data = await response.json()
      return data.gpt
    } catch (error) {
      console.error('Error creating GPT:', error)
      throw error
    }
  }

  async updateGPT(id: string, gptData: Partial<CreateGPTData>): Promise<CustomGPT> {
    try {
      const { iconFile, ...jsonData } = gptData
      const formData = new FormData()

      // Append JSON data as a string
      formData.append('gpts', JSON.stringify(jsonData))

      // Append file if it exists
      if (iconFile) {
        formData.append('icon', iconFile)
      }

      const response = await fetch(`${this.baseUrl}/${id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
        },
        credentials: 'include',
        body: formData,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || `Failed to update GPT: ${response.statusText}`)
      }

      const data = await response.json()
      return data.gpt
    } catch (error) {
      console.error('Error updating GPT:', error)
      throw error
    }
  }

  async deleteGPT(id: string): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/${id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`

        },
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || `Failed to delete GPT: ${response.statusText}`)
      }
    } catch (error) {
      console.error('Error deleting GPT:', error)
      throw error
    }
  }

  async getCategories(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/categories`, {
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
        },
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch categories: ${response.statusText}`)
      }

      const data = await response.json()
      return data.categories || []
    } catch (error) {
      console.error('Error fetching categories:', error)
      return []
    }
  }

  async startChatWithGPT(gptId: string): Promise<any> {
    try {
      const response = await fetch(`${this.baseUrl}/${gptId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`

        },
        credentials: 'include',
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || `Failed to start chat: ${response.statusText}`)
      }

      const data = await response.json()
      return data.chat
    } catch (error) {
      console.error('Error starting chat with GPT:', error)
      throw error
    }
  }

  // Utility methods
  getShareUrl(shareId: string): string {
    if (typeof window !== 'undefined') {
      return `${window.location.origin}/gpts/share/${shareId}`
    }
    return `/gpts/share/${shareId}`
  }

  validateGPTName(name: string): string | null {
    if (!name.trim()) return 'Name is required'
    if (name.length > 100) return 'Name must be 100 characters or less'
    return null
  }

  validateInstructions(instructions: string): string | null {
    if (!instructions.trim()) return 'Instructions are required'
    if (instructions.length > 8000) return 'Instructions must be 8000 characters or less'
    return null
  }

  formatCreatedDate(dateString: string): string {
    const date = new Date(dateString)
    const now = new Date()
    const diffInDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))

    if (diffInDays === 0) return 'Today'
    if (diffInDays === 1) return 'Yesterday'
    if (diffInDays < 7) return `${diffInDays} days ago`
    if (diffInDays < 30) return `${Math.floor(diffInDays / 7)} weeks ago`
    if (diffInDays < 365) return `${Math.floor(diffInDays / 30)} months ago`
    return `${Math.floor(diffInDays / 365)} years ago`
  }
}

export const gptsService = new GPTsService()
