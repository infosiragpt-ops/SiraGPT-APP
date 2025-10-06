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

    const headers = new Headers(options.headers);

    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }

    // Only set Content-Type for non-FormData requests
    if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const config: RequestInit = {
      headers,
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

  // Public getter for baseURL
  get apiBaseURL() {
    return this.baseURL;
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

  async getFileContent(id: string): Promise<string> {
    const url = `${this.baseURL}/files/${id}/content`;
    const headers = new Headers();
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.text();
  }

  // AI endpoints
  // async generateAI(data: { model: string; prompt: string; chatId?: string; files?: string[] }) {
  //   return this.request('/ai/generate', {
  //     method: 'POST',
  //     body: JSON.stringify(data),
  //   });
  // }

  async stopAIStream(streamId: string) {
    return this.request('/ai/stop-stream', {
      method: 'POST',
      body: JSON.stringify({ streamId }),
    });
  }


  // ✅ YEH NAYA METHOD STREAMING KE LIYE HAI
  async generateAIStream(
    data: { provider: string; model: string; prompt: string; chatId?: string; files?: string[], streamId: string },
    onData: (chunk: string) => void, // Jab data ka naya tukra aaye
    onClose: () => void, // Jab stream band ho jaye
    onError: (error: Error) => void, // Jab koi error aaye

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
        let details: any = {};
        try { details = await response.json(); } catch { }
        const message = details.error || `HTTP ${response.status}`;

        // Notify UI to open upgrade modal if the message indicates exhaustion
        try {
          if (typeof window !== 'undefined' && message && message.toLowerCase().includes('free monthly')) {
            window.dispatchEvent(new CustomEvent('open-upgrade-modal', { detail: { message } }));
          }
        } catch (e) {
          console.warn('Failed to dispatch open-upgrade-modal event', e);
        }

        const error: any = new Error(message);
        if (details.code) error.code = details.code;
        throw error;
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
              } else if (jsonData.error) {
                onError(new Error(jsonData.error));
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
  async generateImage(data: { prompt: string; chatId?: string; provider: string; model: string; fileId?: string }) {
    const response = await this.request('/ai/generate-image', {
      method: 'POST',
      body: JSON.stringify(data),
    });

    return response;
  }
  async generateImageByImage(data: { fileId: string, prompt: string; chatId?: string, provider: string; model: string; }) {
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

  // async getAIModels() {
  //   return this.request('/ai/models');
  // }
  async getAIModels(type?: 'TEXT' | 'IMAGE') { // type ko optional parameter banayein
    const endpoint = type ? `/ai/models?type=${type}` : '/ai/models';
    return this.request(endpoint);
  }

  // Payment endpoints
  async createStripePayment(data: { plan: string }) {
    return this.request('/payments/stripe', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async verifyPaymentSession(sessionId: string) {
    return this.request(`/payments/verify-session?session_id=${sessionId}`);
  }

  async getSubscriptionInfo() {
    return this.request('/payments/subscription');
  }

  async cancelSubscription() {
    return this.request('/payments/subscription/cancel', {
      method: 'POST',
    });
  }

  async reactivateSubscription() {
    return this.request('/payments/subscription/reactivate', {
      method: 'POST',
    });
  }

  async previewPlanChange(data: { newPlan: string }) {
    return this.request('/payments/plan-change/preview', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async executePlanChange(data: { newPlan: string; immediate: boolean }) {
    return this.request('/payments/plan-change/execute', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async cancelScheduledPlanChange() {
    return this.request('/payments/plan-change/cancel', {
      method: 'POST',
    });
  }



  async getSubscriptionAnalytics(period = '30d') {
    return this.request(`/payments/analytics?period=${period}`);
  }

  async getNotifications(limit = 50) {
    return this.request(`/payments/notifications?limit=${limit}`);
  }

  async markNotificationRead(notificationId: string) {
    return this.request(`/payments/notifications/${notificationId}/read`, {
      method: 'PUT',
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

  // User preferences endpoints
  async getUserPreferences() {
    return this.request('/users/preferences');
  }

  async updateUserPreferences(data: any) {
    return this.request('/users/preferences', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // Payment method endpoints
  async getPaymentMethods() {
    return this.request('/payments/methods');
  }

  async addPaymentMethod(data: any) {
    return this.request('/payments/methods', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async removePaymentMethod(id: string) {
    return this.request(`/payments/methods/${id}`, {
      method: 'DELETE',
    });
  }

  async setDefaultPaymentMethod(id: string) {
    return this.request(`/payments/methods/${id}/default`, {
      method: 'PUT',
    });
  }

  // Billing address endpoints
  async getBillingAddress() {
    return this.request('/payments/billing-address');
  }

  async updateBillingAddress(data: any) {
    return this.request('/payments/billing-address', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // Invoice endpoints
  async downloadInvoice(paymentId: string) {
    const response = await fetch(`${this.baseURL}/payments/invoice/${paymentId}`, {
      headers: {
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
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

  async createUserAdmin(data: { name: string; email: string; password: string; plan?: string; isAdmin?: boolean; monthlyLimit?: number }) {
    // Calls admin POST /admin/users - requires admin session token
    return this.request('/admin/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
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

  // Download endpoints
  async downloadExcel(messageId: string, filename?: string) {
    const url = `${this.baseURL}/download/excel`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify({ messageId, filename }),
    };

    const response = await fetch(url, config);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
  }

  async downloadCSV(messageId: string, filename?: string) {
    const url = `${this.baseURL}/download/csv`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify({ messageId, filename }),
    };

    const response = await fetch(url, config);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
  }

  async downloadText(messageId: string, filename?: string) {
    const url = `${this.baseURL}/download/text`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify({ messageId, filename }),
    };

    const response = await fetch(url, config);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
  }

  async downloadWord(messageId: string, filename?: string) {
    const url = `${this.baseURL}/download/word`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify({ messageId, filename }),
    };

    const response = await fetch(url, config);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
  }

  async downloadPowerPoint(messageId: string, filename?: string) {
    const url = `${this.baseURL}/download/powerpoint`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify({ messageId, filename }),
    };

    const response = await fetch(url, config);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Network error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.blob();
  }

  // ElevenLabs endpoints
  async getVoices() {
    return this.request('/elevenlabs/voices');
  }

  async getModels() {
    return this.request('/elevenlabs/models');
  }
  async textToSpeech(data: {
    text: string;
    voice_id?: string;
    model_id?: string;
    voice_settings?: {
      stability?: number;
      similarity_boost?: number;
      style?: number;
      use_speaker_boost?: boolean;
    };
  }) {
    return this.request('/elevenlabs/text-to-speech', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async speechToText(audioFile: File, model_id?: string) {
    const formData = new FormData();
    formData.append('audio', audioFile);
    if (model_id) {
      formData.append('model_id', model_id);
    }

    return this.request('/elevenlabs/speech-to-text', {
      method: 'POST',
      body: formData,
    });
  }



  async getVoiceSettings(voiceId: string) {
    return this.request(`/elevenlabs/voices/${voiceId}/settings`);
  }

  async getElevenLabsSubscription() {
    return this.request('/elevenlabs/user/subscription');
  }

  async getAudioFile(filename: string) {
    const response = await this.request(`/elevenlabs/audio/${filename}`);
    return response.blob();
  }
  // ...existing code...

  // ElevenLabs Music Generation
  async generateMusic(data: {
    text: string;
    duration?: number;
    prompt_influence?: number;
    normalize_output?: boolean;
  }) {
    return this.request('/elevenlabs/generate-music', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getMusicStyles() {
    return this.request('/elevenlabs/music-styles');
  }


  // // Web Search endpoints
  // async webSearch(data: { query: string; chatId?: string }) {
  //   return this.request('/search/web', {
  //     method: 'POST',
  //     body: JSON.stringify(data),
  //   });
  // }
  // Replace the webSearch method with this streaming version:

  // Web Search endpoints
  async webSearchStream(
    data: { query: string; chatId?: string; model?: string; provider?: string },
    onData: (chunk: any) => void,
    onComplete: () => void,
    onError: (error: Error) => void
  ) {
    const url = `${this.baseURL}/search/web`;
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
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder('utf-8');

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          onComplete();
          break;
        }

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const jsonData = JSON.parse(line.slice(6));
              onData(jsonData);
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (error: any) {
      console.error('Web search stream failed:', error);
      onError(error);
    }
  }
  // Update the video generation method
  // Update the generateVideo method:

  async generateVideo(data: {
    prompt: string;
    aspect_ratio?: '16:9' | '9:16' | '1:1';
    negative_prompt?: string;
    chatId?: string;
    files?: string[];
    image_url?: string;
    model?: string;
  }) {
    return this.request('/ai/generate-video', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }
  // async getVideoStatus(operationId: string) {
  //   return this.request(`/video/status/${operationId}`);
  // }

  // ...existing code...
  async getVideoStatus(operationId: string) {
    // Was: return this.request(`/video/status/${operationId}`);
    return this.request(`/ai/video-status/${operationId}`);
  }
  async getVideoHistory(params?: {
    page?: number;
    limit?: number;
  }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/video/history${query ? `?${query}` : ''}`);
  }

  getVideoFile(filename: string) {
    return `${this.apiBaseURL}/video/watch/${filename}`;
  }

  async downloadVideo(filename: string) {
    const url = `${this.apiBaseURL}/video/download/${filename}`;
    const response = await fetch(url, {
      headers: {
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    });
    if (!response.ok) {
      throw new Error('Failed to download video');
    }
    return response.blob();
  }
  async getAnonQuota() {
    localStorage.setItem('currentChatId', "")

    const res = await fetch(`${this.apiBaseURL}/ai/anon-quota`, {
      method: 'GET',
      credentials: 'include'
    });
    if (!res.ok) {
      throw new Error('Failed to fetch anonymous quota');
    }
    return res.json();
  }

  async getMediaLibrary(params?: { page?: number; limit?: number; type?: 'image' | 'video' }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/library/media-library${query ? `?${query}` : ''}`);
  }

  async generateChart(data: { prompt: string; chatId?: string, fileId?: string }) {
    return this.request('/ai/generate-chart', {
        method: 'POST',
        body: JSON.stringify(data),
    });
  }
}

export const apiClient = new ApiClient(API_BASE_URL);
export default apiClient;
