// Frontend API client for backend integration
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';

class ApiClient {
  private baseURL: string;
  private token: string | null = null;

  constructor(baseURL: string) {
    this.baseURL = baseURL;

    // Get token from localStorage on client side
    if (typeof window !== 'undefined') {
      this.token = localStorage.getItem('auth-token');
    }
  }

  private async request(endpoint: string, options: RequestInit = {}) {
    const url = `${this.baseURL}${endpoint}`;

    const config: RequestInit = {
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
        ...options.headers,
      },
      credentials: 'include',
      ...options,
    };

    try {
      const response = await fetch(url, config);

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Network error' }));
        throw new Error(error.error || `HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  }

  setToken(token: string | null) {
    this.token = token;
    if (typeof window !== 'undefined') {
      if (token) {
        localStorage.setItem('auth-token', token);
      } else {
        localStorage.removeItem('auth-token');
      }
    }
  }

  // Auth endpoints
  async register(data: { name: string; email: string; password: string }) {
    const result = await this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });

    if (result.token) {
      this.setToken(result.token);
    }

    return result;
  }

  async login(data: { email: string; password: string }) {
    const result = await this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    });

    if (result.token) {
      this.setToken(result.token);
    }

    return result;
  }

  async logout() {
    await this.request('/auth/logout', { method: 'POST' });
    this.setToken(null);
  }

  async getCurrentUser() {
    return this.request('/auth/me');
  }

  // Chat endpoints
  async getChats(params?: { page?: number; limit?: number }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/chats${query ? `?${query}` : ''}`);
  }

  async createChat(data: { title: string; model: string }) {
    return this.request('/chats', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getChat(id: string) {
    console.log("Get Chat Working");

    return this.request(`/chats/${id}`);
  }

  async updateChat(id: string, data: { title?: string; model?: string }) {
    return this.request(`/chats/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteChat(id: string) {
    return this.request(`/chats/${id}`, { method: 'DELETE' });
  }

  async addMessage(chatId: string, data: { role: string; content: string; files?: string[] }) {
    return this.request(`/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async clearChat(chatId: string) {
    return this.request(`/chats/${chatId}/messages`, { method: 'DELETE' });
  }



  async clearMessageById(messageId: string) {
    return this.request(`/chats/messages/${messageId}/deleteMessage`, { method: 'DELETE' });
  }

  async handleFeedbackLikeDislike(messageId: string, feedbackType: 'liked' | 'disliked') {
    return this.request(`/chats/messages/${messageId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ feedback: feedbackType }),
    });
  }

  async handleShare(chatId: String) {
    return this.request(`/chats/${chatId}/share`, {
      method: 'POST',
      // body: JSON.stringify({}),
    });
  }

  async shareChatIdLink(shareId: String) {
    return this.request(`/public/share/${shareId}`, {
      method: 'GET',
      // body: JSON.stringify({}),
    });
  }


  async editUserMessage(messageId: String, data: any) {
    return this.request(`/chats/messages/${messageId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }


  // File endpoints
  async uploadFiles(files: FileList) {
    const formData = new FormData();
    Array.from(files).forEach(file => {
      formData.append('files', file);
    });

    return this.request('/files/upload', {
      method: 'POST',
      headers: {
        // Remove Content-Type to let browser set it with boundary
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: formData,
    });
  }

  async getFiles(params?: { page?: number; limit?: number; type?: string }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/files${query ? `?${query}` : ''}`);
  }

  async getFile(id: string) {
    return this.request(`/files/${id}`);
  }

  async deleteFile(id: string) {
    return this.request(`/files/${id}`, { method: 'DELETE' });
  }

  // AI endpoints
  // async generateAI(data: { model: string; prompt: string; chatId?: string; files?: string[] }) {
  //   return this.request('/ai/generate', {
  //     method: 'POST',
  //     body: JSON.stringify(data),
  //   });
  // }

  // ✅ YEH NAYA METHOD STREAMING KE LIYE HAI
  async generateAIStream(
    data: { model: string; prompt: string; chatId?: string; files?: string[] },
    // Yeh callback functions component se aayenge
    onData: (chunk: string) => void, // Jab data ka naya tukra aaye
    onClose: () => void, // Jab stream band ho jaye
    onError: (error: Error) => void // Jab koi error aaye
  ) {
    const url = `${this.baseURL}/ai/generate`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify(data),
    };

    try {
      const response = await fetch(url, config);

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Network error' }));
        throw new Error(error.error || `HTTP ${response.status}`);
      }

      // response.body ek ReadableStream hai, hum isko padhenge
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const decoder = new TextDecoder('utf-8');

      // Musalsal data padhne ke liye loop
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          onClose(); // Stream khatam ho gayi
          break;
        }

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n\n');

        for (const line of lines) {


          if (line.startsWith('data: ')) {
            try {
              const jsonData = JSON.parse(line.substring(6));
              if (jsonData.content) {

                onData(jsonData.content); // Data ko component mein bhejein
              }
            } catch (e) {
              // JSON parse error ko ignore karein
            }
          }
        }
      }
    } catch (error: any) {
      console.error('API stream failed:', error);
      onError(error);
    }
  }
  async generateImage(data: { prompt: string; chatId?: string }) {
    const response = await this.request('/ai/generate-image', {
      method: 'POST',
      body: JSON.stringify(data),
    })

    return response
  }

  /*async generateAI(data: { model: string; messages: any[]; chatId?: string; files?: string[] }) {
    return this.request('/ai/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }*/

  async getAIModels() {
    return this.request('/ai/models');
  }

  // Payment endpoints
  async createStripePayment(data: { plan: string; priceId: string }) {
    return this.request('/payments/stripe', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async createPayPalPayment(data: { plan: string }) {
    return this.request('/payments/paypal', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async createMercadoPagoPayment(data: { plan: string }) {
    return this.request('/payments/mercadopago', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getPayments(params?: { page?: number; limit?: number }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/payments${query ? `?${query}` : ''}`);
  }

  // User endpoints
  async getUserProfile() {
    return this.request('/users/profile');
  }

  async updateUserProfile(data: { name?: string; email?: string }) {
    return this.request('/users/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async changePassword(data: { currentPassword: string; newPassword: string }) {
    return this.request('/users/password', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async getUserUsage(period?: string) {
    return this.request(`/users/usage${period ? `?period=${period}` : ''}`);
  }

  async deleteAccount() {
    return this.request('/users/account', { method: 'DELETE' });
  }

  // Admin endpoints
  async getUsers(params?: { page?: number; limit?: number; search?: string; plan?: string }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/admin/users${query ? `?${query}` : ''}`);
  }

  async updateUser(id: string, data: { plan?: string; isAdmin?: boolean; monthlyLimit?: number }) {
    return this.request(`/admin/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteUser(id: string) {
    return this.request(`/admin/users/${id}`, { method: 'DELETE' });
  }

  async getAnalytics() {
    return this.request('/admin/analytics');
  }

  async getAllPayments(params?: { page?: number; limit?: number; status?: string }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/admin/payments${query ? `?${query}` : ''}`);
  }

  async getSystemStats() {
    return this.request('/admin/stats');
  }
}

export const apiClient = new ApiClient(API_BASE_URL);
export default apiClient;