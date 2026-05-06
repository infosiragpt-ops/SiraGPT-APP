// Frontend API client for backend integration
import { streamSseJson } from "./sse-client"

/** Backend mounts routes under `/api` (e.g. `/api/auth/login`). Accept env with or without `/api`. */
export function getNormalizedApiBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"
  const trimmed = raw.replace(/\/$/, "")
  if (trimmed.endsWith("/api")) return trimmed
  return `${trimmed}/api`
}

const API_BASE_URL = getNormalizedApiBaseUrl()

type AIStreamOptions = {
  onReplace?: (content: string) => void
}

class ApiClient {
  private baseURL: string;
  private token: string | null = null;

  // Retry config — transient network blips shouldn't fail the UI.
  // Only retries on network errors / 5xx; 4xx passes through immediately
  // EXCEPT for 429 / 503 which are retryable (Retry-After honored).
  private readonly MAX_RETRIES = 2;
  private readonly BASE_RETRY_DELAY_MS = 500;
  private readonly DEFAULT_TIMEOUT_MS = 30000; // 30s
  // Hard ceiling on any single Retry-After wait. Without this, a
  // server returning Retry-After: 3600 would lock the UI for an hour.
  private readonly RETRY_AFTER_MAX_MS = 30000; // 30s

  // Refresh-token state — when a 401 fires, we attempt /auth/refresh once
  // and queue concurrent requests until it resolves.
  private _refreshing: Promise<boolean> | null = null;
  private _pendingQueue: Array<{
    resolve: (value: any) => void;
    reject: (err: any) => void;
  }> = [];

  constructor(baseURL: string) {
    this.baseURL = baseURL;

    // Get token from localStorage on client side
    if (typeof window !== 'undefined') {
      this.token = localStorage.getItem('auth-token');
    }
  }

  /**
   * Core request method with timeout + retry.
   * Throws on final failure with status, statusCode, and errorData attached.
   *
   * Reliability primitives wired here (phase 8u):
   *
   *   - Auto Idempotency-Key on POST/PUT/PATCH. A v4 UUID is minted
   *     ONCE per logical call and stays stable across retries, so the
   *     backend's idempotency middleware (phase 8n) sees the same key
   *     on the original + every retry and replays the cached 2xx
   *     response instead of re-executing the operation. The key is
   *     skipped on GET/HEAD/OPTIONS (idempotent by HTTP semantics) and
   *     never overwritten if the caller passed one explicitly.
   *
   *   - Retry-After honor on 429 / 503. Previously the 4xx-immediate-
   *     fail block treated 429 as a hard failure; now the wrapper
   *     reads the Retry-After header (delta-seconds OR HTTP-date),
   *     waits, and retries up to MAX_RETRIES. The cap is bounded by
   *     RETRY_AFTER_MAX_MS so a misbehaving server with a 1-hour
   *     Retry-After can't pin the UI for an hour.
   */
  private async request(endpoint: string, options: RequestInit & { timeoutMs?: number } = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const timeoutMs = options.timeoutMs ?? this.DEFAULT_TIMEOUT_MS;

    // Build headers once (they don't change between retries — and
    // Idempotency-Key MUST stay stable across retries for the
    // backend dedup to work).
    const headers = new Headers(options.headers);

    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }

    // Only set Content-Type for non-FormData requests
    if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    // Idempotency-Key auto-injection. Only for mutating verbs and
    // only when the caller didn't supply one. crypto.randomUUID is
    // baseline in Node 18+ / Chrome 92+ / Safari 15.4+; the
    // existence check covers older environments without crashing.
    const method = String((options.method || 'GET')).toUpperCase();
    const isMutating = method === 'POST' || method === 'PUT' || method === 'PATCH';
    if (isMutating && !headers.has('Idempotency-Key') && !headers.has('idempotency-key')) {
      const cryptoObj = (typeof globalThis !== 'undefined' ? (globalThis as any).crypto : null);
      if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
        headers.set('Idempotency-Key', cryptoObj.randomUUID());
      }
    }

    // Track last error for re-throw on final failure
    let lastError: Error & { status?: number; statusCode?: number; errorData?: any } | null = null;

    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      // AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const config: RequestInit = {
          ...options,
          headers,
          credentials: 'include',
          signal: controller.signal as AbortSignal,
        };

        const response = await fetch(url, config);

        // HTTP-level success (2xx)
        if (response.ok) {
          clearTimeout(timeoutId);
          // Handle 204 No Content
          if (response.status === 204) return null;
          return await response.json();
        }

        // 429 — rate limited / quota exceeded. Honor Retry-After
        // header per RFC 9110 and retry up to MAX_RETRIES. We
        // intentionally branch on 429 BEFORE the generic 4xx block
        // because 429 IS retryable (unlike 400, 403, 404, 409).
        if (response.status === 429 || response.status === 503) {
          clearTimeout(timeoutId);
          if (attempt < this.MAX_RETRIES) {
            const retryAfterMs = this._parseRetryAfter(response.headers.get('retry-after'));
            const waitMs = retryAfterMs !== null
              ? Math.min(retryAfterMs, this.RETRY_AFTER_MAX_MS)
              // No header → fall back to exponential backoff so the
              // server still gets relief if its rate limiter forgot
              // to send Retry-After.
              : this.BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          // Out of retries — fall through to the 4xx error path so
          // the caller sees the structured response body.
          const errorData = await response.json().catch(() => ({ error: 'Rate limited' }));
          const error = new Error(errorData.error || `HTTP ${response.status}`);
          (error as any).status = response.status;
          (error as any).statusCode = response.status;
          (error as any).errorData = errorData;
          throw error;
        }

        // 4xx — client error, don't retry (except 401 with refresh)
        if (response.status >= 400 && response.status < 500) {
          // 401 — attempt token refresh once before failing
          if (response.status === 401 && this.token) {
            const refreshed = await this._tryRefresh();
            if (refreshed) {
              // Update Authorization header with new token
              headers.set('Authorization', `Bearer ${this.token}`);
              clearTimeout(timeoutId);
              // Reset attempt counter so this doesn't consume a retry slot
              attempt = -1;
              continue;
            }
          }

          clearTimeout(timeoutId);
          const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
          const error = new Error(errorData.error || `HTTP ${response.status}`);
          (error as any).status = response.status;
          (error as any).statusCode = response.status;
          (error as any).errorData = errorData;
          throw error;
        }

        // 5xx — server error, retry with backoff
        clearTimeout(timeoutId);
        lastError = new Error(`HTTP ${response.status}`);
        (lastError as any).status = response.status;
        (lastError as any).statusCode = response.status;

        // If it's the last attempt, try to parse the body for better error
        if (attempt === this.MAX_RETRIES) {
          const errorData = await response.json().catch(() => ({ error: 'Server error' }));
          lastError!.message = errorData.error || lastError!.message;
          (lastError as any).errorData = errorData;
        }
      } catch (error: any) {
        clearTimeout(timeoutId);

        // AbortError (timeout) — retry
        if (error.name === 'AbortError') {
          lastError = new Error(`Request timed out after ${timeoutMs}ms`);
          (lastError as any).status = 408;
          (lastError as any).statusCode = 408;
          continue;
        }

        // TypeError (network error, CORS, etc.) — retry
        if (error instanceof TypeError || error.message === 'Failed to fetch' || error.message?.includes('NetworkError')) {
          lastError = error;
          (lastError as any).status = 0;
          (lastError as any).statusCode = 0;
          // Not the last attempt — retry
          if (attempt < this.MAX_RETRIES) {
            const delay = this.BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
        }

        // For errors thrown inside our block (4xx, already handled), re-throw
        throw error;
      }

      // Exponential backoff before retry
      if (attempt < this.MAX_RETRIES) {
        const delay = this.BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    // All retries exhausted
    const finalError = lastError || new Error('Request failed after retries');
    console.error(`[ApiClient] Request failed after ${this.MAX_RETRIES + 1} attempts:`, endpoint, finalError.message);
    throw finalError;
  }

  // Public getter for baseURL
  get apiBaseURL() {
    return this.baseURL;
  }

  /**
   * _parseRetryAfter — turn an RFC 9110 Retry-After header value into
   * a millisecond delay relative to "now". Returns null when the
   * header is missing or unparseable so the caller falls back to
   * exponential backoff.
   *
   * Two valid formats per spec:
   *   - delta-seconds: `Retry-After: 30`
   *   - HTTP-date:     `Retry-After: Fri, 31 Dec 2030 23:59:59 GMT`
   *
   * Negative deltas (server clock skew) are clamped to 0; the caller
   * separately enforces the upper bound via RETRY_AFTER_MAX_MS.
   */
  private _parseRetryAfter(headerValue: string | null): number | null {
    if (!headerValue) return null;
    const trimmed = headerValue.trim();
    if (/^\d+$/.test(trimmed)) {
      const seconds = Number.parseInt(trimmed, 10);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
      }
    }
    const epoch = Date.parse(trimmed);
    if (!Number.isNaN(epoch)) {
      return Math.max(0, epoch - Date.now());
    }
    return null;
  }

  /**
   * Try to refresh the JWT token by calling /auth/refresh.
   * Ensures only one refresh is in-flight at a time.
   * Returns true if successful, false otherwise.
   */
  async _tryRefresh(): Promise<boolean> {
    // If a refresh is already in progress, wait for it
    if (this._refreshing) {
      return this._refreshing;
    }

    this._refreshing = (async () => {
      try {
        const res = await fetch(`${this.baseURL}/auth/refresh`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          credentials: 'include',
        });

        if (!res.ok) {
          // Refresh failed — clear token to force re-login
          this.setToken(null);
          return false;
        }

        const data = await res.json();
        this.setToken(data.token);
        return true;
      } catch {
        this.setToken(null);
        return false;
      }
    })();

    const result = await this._refreshing;
    this._refreshing = null;
    return result;
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

  // Super Admin Impersonation
  async impersonateUser(userId: string) {
    return this.request(`/auth/impersonate/${userId}`, { method: 'POST' });
  }

  async endImpersonation() {
    return this.request('/auth/end-impersonation', { method: 'POST' });
  }

  async getCurrentUser() {
    return this.request('/auth/me');
  }

  // Chat endpoints
  async getChats(params?: { page?: number; limit?: number; projectId?: string; includeProjects?: boolean; search?: string }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/chats${query ? `?${query}` : ''}`);
  }

  async createChat(data: { title: string; model: string; isWordConnectorChat?: boolean; isExcelConnectorChat?: boolean; projectId?: string }) {
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

  async addMessage(chatId: string, data: { role: string; content: string; files?: string[]; metadata?: string }) {
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

  // Share complete chat
  async handleShare(chatId: String) {
    return this.request(`/chats/${chatId}/share`, {
      method: 'POST',
      // body: JSON.stringify({}),
    });
  }

  // Share individual message with its context
  async shareMessage(messageId: String, chatId: String) {
    return this.request(`/chats/${chatId}/messages/${messageId}/share`, {
      method: 'POST',
      // body: JSON.stringify({}),
    });
  }

  // Get shared chat content
  async shareChatIdLink(shareId: String) {
    return this.request(`/public/share/${shareId}`, {
      method: 'GET',
      // body: JSON.stringify({}),
    });
  }

  // Get shared message content
  async shareMessageIdLink(shareId: String) {
    return this.request(`/public/share/message/${shareId}`, {
      method: 'GET',
      // body: JSON.stringify({}),
    });
  }

  // Save shared content to user's account
  async saveSharedContent(shareType: 'message' | 'complete', shareData: any, title?: string) {
    return this.request('/chats/save-shared', {
      method: 'POST',
      body: JSON.stringify({
        shareType,
        shareData,
        title
      }),
    });
  }

  async editUserMessage(messageId: String, data: any) {
    return this.request(`/chats/messages/${messageId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }


  // File endpoints
  /**
   * Upload files to the backend with REAL progress (XHR-based — `fetch`
   * has no upload progress events as of late-2025 Safari/Firefox).
   *
   * @param files          FileList from picker / drop / paste
   * @param opts.sourceChannel  Telemetry tag: where the file came from
   *                            ('picker' | 'drop' | 'paste-files' | …)
   * @param opts.idempotencyKey  Stable per-batch key — server can dedupe
   *                            retries against the SAME upload attempt
   * @param opts.onProgress  Called with (percent 0-100, loadedBytes,
   *                         totalBytes) — wire to the chip's progress bar
   * @param opts.signal      AbortSignal — cancel mid-upload
   */
  async uploadFiles(
    files: FileList,
    opts: {
      sourceChannel?: string
      idempotencyKey?: string
      onProgress?: (percent: number, loadedBytes: number, totalBytes: number) => void
      signal?: AbortSignal
    } = {}
  ): Promise<any> {
    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append('files', file));
    if (opts.sourceChannel) formData.append('sourceChannel', opts.sourceChannel);

    const url = `${this.baseURL}/files/upload`;

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      if (this.token) xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
      if (opts.idempotencyKey) xhr.setRequestHeader('Idempotency-Key', opts.idempotencyKey);
      xhr.withCredentials = true;
      // Don't set Content-Type — XHR sets it with boundary for FormData.

      if (opts.onProgress && xhr.upload) {
        xhr.upload.onprogress = (ev) => {
          if (!ev.lengthComputable) return;
          const pct = Math.round((ev.loaded / ev.total) * 100);
          opts.onProgress!(pct, ev.loaded, ev.total);
        };
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { resolve(xhr.responseText); }
        } else {
          let msg = `HTTP ${xhr.status}`;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.ontimeout = () => reject(new Error('Upload timed out'));
      xhr.onabort = () => reject(Object.assign(new Error('Upload aborted'), { name: 'AbortError' }));

      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(Object.assign(new Error('Upload aborted'), { name: 'AbortError' }));
          return;
        }
        opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }

      xhr.send(formData);
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


  // Stream chat completions from /ai/generate. Resilient by design:
  // automatically reconnects at the transport layer BEFORE the user sees
  // any tokens (HTTP 429, 5xx, network errors), while never duplicating
  // content that has already been rendered. Mid-stream interruptions
  // surface to the caller so the UI can show the per-message error +
  // retry affordance without losing the user's message.
  async generateAIStream(
    data: { provider: string; model: string; prompt: string; chatId?: string; files?: string[], streamId: string, regenerate?: boolean },
    onData: (chunk: string) => void,
    onClose: () => void,
    onError: (error: Error) => void,
    signal?: AbortSignal,
    options: AIStreamOptions = {}
  ) {
    const url = `${this.baseURL}/ai/generate`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify(data),
      ...(signal && { signal }),
    };

    const MAX_CONNECT_ATTEMPTS = 2;
    const RECONNECT_DELAY_MS = 1000;
    let hasDeliveredAnyContent = false;
    let lastError: any = null;

    for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
      if (signal?.aborted) { onError(new Error('Request aborted')); return; }
      if (hasDeliveredAnyContent) break;

      try {
        const response = await fetch(url, config);

        if (!response.ok) {
          let details: any = {};
          try { details = await response.json(); } catch { }
          const message = details.error || `HTTP ${response.status}`;

          try {
            if (typeof window !== 'undefined' && message && message.toLowerCase().includes('free monthly')) {
              window.dispatchEvent(new CustomEvent('open-upgrade-modal', { detail: { message } }));
            }
          } catch (e) {
            console.warn('Failed to dispatch open-upgrade-modal event', e);
          }

          const err: any = new Error(message);
          err.status = response.status;
          if (details.code) err.code = details.code;

          // Retriable transport failures: 429 (rate-limit) and 5xx
          // (server error) — only BEFORE any content has reached the
          // user, and only once per turn. Anything else bubbles up
          // (auth/validation/quota-exhaustion are terminal).
          const retriable = !hasDeliveredAnyContent
            && (response.status === 429 || response.status >= 500)
            && attempt < MAX_CONNECT_ATTEMPTS;
          if (retriable) {
            console.warn(`[ai-stream] HTTP ${response.status} on attempt ${attempt} — auto-reconnecting in ${RECONNECT_DELAY_MS}ms`);
            await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));
            lastError = err;
            continue;
          }
          throw err;
        }

        if (signal?.aborted) throw new Error('Request aborted');

        const reader = response.body?.getReader();
        if (!reader) throw new Error('Response body is not readable');

        const decoder = new TextDecoder('utf-8');
        let batchBuffer = '';
        let processedChunks = 0;
        const batchProcessingDelay = 20;
        let lastProcessTime = Date.now();

        const flushBatch = () => {
          if (batchBuffer.trim()) {
            onData(batchBuffer);
            hasDeliveredAnyContent = true;
            batchBuffer = '';
            lastProcessTime = Date.now();
          }
        };

        while (true) {
          if (signal?.aborted) { reader.cancel(); throw new Error('Request aborted'); }

          const { done, value } = await reader.read();
          if (done) {
            flushBatch();
            if (!hasDeliveredAnyContent) {
              onError(new Error('No se recibió respuesta del modelo. Intenta regenerar la respuesta.'));
              return;
            }
            onClose();
            return;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n\n');

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.substring(6);
            // Sentinel the backend emits at the very end of every stream,
            // including error / recovered cases. Flush pending buffer,
            // close, and return — anything after is a leftover from a
            // broken proxy or a retransmit.
            if (payload === '[DONE]') {
              flushBatch();
              if (!hasDeliveredAnyContent) {
                onError(new Error('No se recibió respuesta del modelo. Intenta regenerar la respuesta.'));
                return;
              }
              onClose();
              return;
            }
            try {
              const jsonData = JSON.parse(payload);
              if (jsonData.replace && typeof jsonData.content === 'string') {
                flushBatch();
                if (options.onReplace) {
                  options.onReplace(jsonData.content);
                } else {
                  onData(jsonData.content);
                }
                hasDeliveredAnyContent = true;
                lastProcessTime = Date.now();
              } else if (jsonData.content) {
                batchBuffer += jsonData.content;
                processedChunks++;

                const timeSinceLastProcess = Date.now() - lastProcessTime;
                const shouldProcess =
                  batchBuffer.length >= 150 ||
                  timeSinceLastProcess >= batchProcessingDelay ||
                  jsonData.content.includes('\n');

                if (shouldProcess) flushBatch();
              } else if (jsonData.error) {
                // When the backend recovered the turn with a localized
                // fallback message, we've already delivered a useful
                // reply to the user — don't surface a red toast on top.
                if (jsonData.recovered) {
                  console.warn('[ai-stream] recovered from provider error:', jsonData.error);
                } else {
                  onError(new Error(jsonData.error));
                }
              }
            } catch (e) {
              console.warn('Failed to parse streaming data:', e);
            }
          }
        }
      } catch (error: any) {
        lastError = error;
        if (error?.name === 'AbortError' || signal?.aborted) {
          onError(error);
          return;
        }

        // Transport-layer network failure BEFORE any content reached
        // the user? Reconnect once. The backend already retried + fell
        // back at the provider level, so this reconnect layer only
        // matters for things like dropped sockets between client and
        // our own edge.
        const isNetworkError = error?.name === 'TypeError'
          || /fetch failed|network|socket|ECONN|ETIMEDOUT|ENOTFOUND/i.test(error?.message || '');
        if (!hasDeliveredAnyContent && isNetworkError && attempt < MAX_CONNECT_ATTEMPTS) {
          console.warn(`[ai-stream] network error on attempt ${attempt}: "${error.message}" — auto-reconnecting in ${RECONNECT_DELAY_MS}ms`);
          await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));
          continue;
        }

        console.error('API stream failed:', error);
        onError(error);
        return;
      }
    }

    // Fallthrough: loop exited without a successful return.
    if (lastError) onError(lastError);
  }
  async generateImage(
    data: { prompt: string; chatId?: string; provider: string; model: string; fileId?: string; aspectRatio?: string; imageCount?: number },
    options: { signal?: AbortSignal } = {},
  ) {
    const response = await this.request('/ai/generate-image', {
      method: 'POST',
      body: JSON.stringify(data),
      signal: options.signal,
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

  async generateGmailResponse(data: { prompt: string; chatId?: string; model: string; type: string }) {
    const response = await this.request('/ai/generate-gmail', {
      method: 'POST',
      body: JSON.stringify(data),
    });

    return response;
  }

  // ✅ Word Document Generation Stream - Specialized for Word Connector
  async generateWordStream(
    data: { provider: string; model: string; prompt: string; chatId?: string; files?: string[], streamId: string, mode?: 'create' | 'rewrite', selectedText?: string },
    onData: (chunk: string) => void,
    onClose: () => void,
    onError: (error: Error) => void,
    signal?: AbortSignal
  ) {
    const url = `${this.baseURL}/document-ai/generate-word`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify(data),
      ...(signal && { signal })
    };

    try {
      const response = await fetch(url, config);

      if (!response.ok) {
        let details: any = {};
        try { details = await response.json(); } catch { }
        const message = details.error || `HTTP ${response.status}`;

        if (typeof window !== 'undefined' && message && message.toLowerCase().includes('free monthly')) {
          window.dispatchEvent(new CustomEvent('open-upgrade-modal', { detail: { message } }));
        }

        const error: any = new Error(message);
        if (details.code) error.code = details.code;
        throw error;
      }

      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const decoder = new TextDecoder('utf-8');
      let batchBuffer = '';
      let lastProcessTime = Date.now();
      const batchProcessingDelay = 20;

      while (true) {
        if (signal?.aborted) {
          reader.cancel();
          throw new Error('Request aborted');
        }

        const { done, value } = await reader.read();

        if (done) {
          if (batchBuffer.trim()) {
            onData(batchBuffer);
          }
          onClose();
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const jsonData = JSON.parse(line.substring(6));
              if (jsonData.content) {
                batchBuffer += jsonData.content;
                const timeSinceLastProcess = Date.now() - lastProcessTime;
                const shouldProcess =
                  batchBuffer.length >= 150 ||
                  timeSinceLastProcess >= batchProcessingDelay ||
                  jsonData.content.includes('\n');

                if (shouldProcess && batchBuffer.trim()) {
                  onData(batchBuffer);
                  batchBuffer = '';
                  lastProcessTime = Date.now();
                }
              } else if (jsonData.error) {
                onError(new Error(jsonData.error));
              } else if (jsonData.done) {
                if (batchBuffer.trim()) {
                  onData(batchBuffer);
                }
                onClose();
                return;
              }
            } catch (e) {
              console.warn('Failed to parse streaming data:', e);
            }
          }
        }
      }
    } catch (error: any) {
      console.error('Word Document API stream failed:', error);
      onError(error);
    }
  }

  // ✅ Excel Workbook Generation - Simple POST request (no streaming)
  async generateExcel(
    data: { provider: string; model: string; prompt: string; chatId?: string; files?: string[] },
    signal?: AbortSignal
  ): Promise<{ success: boolean; data: any }> {
    const url = `${this.baseURL}/ai/generate-excel`;
    const config: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
      body: JSON.stringify(data),
      ...(signal && { signal })
    };

    try {
      const response = await fetch(url, config);

      if (!response.ok) {
        let details: any = {};
        try { details = await response.json(); } catch { }
        const message = details.error || `HTTP ${response.status}`;

        if (typeof window !== 'undefined' && message && message.toLowerCase().includes('free monthly')) {
          window.dispatchEvent(new CustomEvent('open-upgrade-modal', { detail: { message } }));
        }

        const error: any = new Error(message);
        if (details.code) error.code = details.code;
        throw error;
      }

      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      const result = await response.json();
      return result;
    } catch (error: any) {
      console.error('Excel generation API failed:', error);
      throw error;
    }
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

  async updateUserProfile(data: { name?: string; email?: string; avatar?: string }) {
    return this.request('/users/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async getUserSettings() {
    return this.request('/users/settings');
  }

  async updateUserSettings(patch: Record<string, any>) {
    return this.request('/users/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  }

  async getUserSessions() {
    return this.request('/users/sessions');
  }

  async revokeOtherSessions() {
    return this.request('/users/sessions/revoke-others', { method: 'POST' });
  }

  async getChatStats() {
    return this.request('/users/chat-stats');
  }

  async archiveAllChats() {
    return this.request('/users/chats/archive-all', { method: 'POST' });
  }

  async clearChatHistory() {
    return this.request('/users/chats/clear-history', { method: 'POST' });
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
  async listStripeInvoices() {
    return this.request('/payments/stripe/invoices');
  }

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

  async downloadStripeInvoice(invoiceId: string) {
    const response = await fetch(`${this.baseURL}/payments/stripe/invoice/${invoiceId}`, {
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

  // Admin invoices
  async getAdminStripeInvoices(params?: { limit?: number; starting_after?: string }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/admin/stripe/invoices${query ? `?${query}` : ''}`);
  }

  async downloadAdminStripeInvoice(invoiceId: string) {
    const response = await fetch(`${this.baseURL}/admin/stripe/invoice/${invoiceId}`, {
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

  async exportUsersCsv() {
    const response = await fetch(`${this.baseURL}/admin/users/export/csv`, {
      headers: {
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    });

    if (!response.ok) {
      const error = await response.text().catch(() => 'Failed to export users');
      throw new Error(error || `HTTP ${response.status}`);
    }

    return response.text();
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
    onComplete: (data: any) => void,
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

      if (!response.body) {
        throw new Error('No response body');
      }

      for await (const jsonData of streamSseJson<any>(response.body)) {
        onData(jsonData);
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

  async generateChart(data: { prompt: string; displayPrompt?: string; chatId?: string, fileId?: string }) {
    return this.request('/ai/generate-chart', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async generateFigmaFlowchart(data: { prompt: string; displayPrompt?: string; chatId?: string; conversationHistory?: any[] }) {
    return this.request('/figma/generate_flowchart', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async generatePlan(data: { prompt: string; chatId?: string; model?: string }) {
    return this.request('/plan/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // SSE streamer for the plan generator. The server emits progress events
  // so the chat can render live feedback instead of a silent spinner.
  // Events: { type: 'stage'|'tokens'|'final'|'error', ... }
  async solveMathStream(
    data: { prompt: string; displayPrompt?: string; chatId?: string; model?: string },
    onEvent: (ev: any) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this._sseStream('/math/solve', data, onEvent, opts);
  }

  async generateVizStream(
    data: { prompt: string; displayPrompt?: string; chatId?: string; model?: string },
    onEvent: (ev: any) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this._sseStream('/viz/generate', data, onEvent, opts);
  }

  async generateDocStream(
    data: {
      prompt: string;
      displayPrompt?: string;
      chatId?: string;
      model?: string;
      format?: 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'csv' | 'html' | 'md' | 'markdown';
      template?: string;
      complexity?: 'simple' | 'standard' | 'high' | 'stress';
      files?: string[];
    },
    onEvent: (ev: any) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this._sseStream('/doc/generate', data, onEvent, opts);
  }

  async generateArtifactStream(
    data: { prompt: string; displayPrompt?: string; chatId?: string; model?: string },
    onEvent: (ev: any) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this._sseStream('/artifact/generate', data, onEvent, opts);
  }

  async generatePlanStream(
    data: { prompt: string; displayPrompt?: string; chatId?: string; model?: string },
    onEvent: (ev: any) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this._sseStream('/plan/generate', data, onEvent, opts);
  }

  // Shared SSE reader for POST-body → event-stream endpoints. Extracted
  // so the plan + math streamers share one implementation and any new
  // streaming route (compute, agent-step, etc.) can reuse it.
  async _sseStream(
    path: string,
    data: any,
    onEvent: (ev: any) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth-token') : null;
    const res = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
      signal: opts.signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch {}
      throw new Error(msg);
    }
    if (!res.body) throw new Error('Stream body missing');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const payload = raw
          .split('\n')
          .filter(l => l.startsWith('data: '))
          .map(l => l.slice(6))
          .join('\n');
        if (!payload) continue;
        try { onEvent(JSON.parse(payload)); } catch {}
      }
    }
  }

  // Web Development Streaming endpoint
  async generateWebDevStream(
    data: {
      prompt: string;
      displayPrompt?: string;
      chatId: string;
      provider?: string;
      model?: string;
      files?: string[];
      streamId: string;
    },
    onData: (chunk: string) => void,
    onClose: () => void,
    onError: (error: Error) => void,
  ) {
    const url = `${this.baseURL}/ai/generate-webdev`;
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
        const errorData = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      for await (const event of streamSseJson<any>(response.body, {
        stopOnDoneMessage: true,
        onMalformedMessage: (_raw, parseError) => {
          console.warn('Failed to parse SSE data:', parseError);
        },
      })) {
        if (event.content) {
          onData(event.content);
        }
        if (event.error) {
          onError(new Error(event.error));
          return;
        }
      }

      onClose();
    } catch (error) {
      console.error('WebDev streaming error:', error);
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // Vector PPT Generation endpoint (Gamma-style, pure vector graphics)
  async generateVectorPPT(data: {
    prompt: string;
    displayPrompt?: string;
    chatId: string;
    provider?: string;
    model?: string;
    files?: string[];
  }) {
    return this.request('/ai/generate-vector-ppt', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // PPT Generation endpoint (WITH IMAGES - OLD VERSION)
  async generatePPT(data: {
    prompt: string;
    displayPrompt?: string;
    chatId: string;
    provider?: string;
    model?: string;
  }) {
    return this.request('/ai/generate-ppt', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Download PPT file
  async downloadPPT(filename: string) {
    const url = `${this.apiBaseURL}/uploads/presentations/${filename}`;
    const response = await fetch(url, {
      headers: {
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
      },
    });

    if (!response.ok) {
      throw new Error('Failed to download presentation');
    }

    return response.blob();
  }

  // Gmail endpoints
  async getGmailStatus() {
    return this.request('/gmail/status');
  }

  async connectGmail() {
    return this.request('/gmail/connect');
  }

  async sendGmailEmail(data: {
    to: string;
    subject: string;
    message: string;
    cc?: string;
    bcc?: string;
  }) {
    return this.request('/gmail/send', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getGmailEmails(params?: {
    maxResults?: number;
    query?: string;
    labelIds?: string[];
  }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/gmail/emails${query ? `?${query}` : ''}`);
  }

  async deleteGmailEmail(emailId: string) {
    return this.request(`/gmail/email/${emailId}`, {
      method: 'DELETE',
    });
  }

  // Prefer using replyGmail below which matches backend contract

  async searchGmailEmails(query: string, limit: number = 10) {
    const q = encodeURIComponent(query);
    return this.request(`/gmail/search?q=${q}&limit=${limit}`, {
      method: 'GET'
    });
  }

  // Mark email read/unread
  async markGmailEmail(messageId: string, read: boolean) {
    return this.request(`/gmail/email/${messageId}/mark`, {
      method: 'PATCH',
      body: JSON.stringify({ read })
    });
  }

  // Reply to an email (threaded)
  async replyGmail(data: { threadId: string; messageId: string; body: string }) {
    return this.request('/gmail/reply', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // Star/unstar email
  async starGmailEmail(messageId: string, starred: boolean) {
    return this.request(`/gmail/email/${messageId}/star`, {
      method: 'PATCH',
      body: JSON.stringify({ starred })
    });
  }

  // Archive/unarchive email
  async archiveGmailEmail(messageId: string, archive: boolean) {
    return this.request(`/gmail/email/${messageId}/archive`, {
      method: 'PATCH',
      body: JSON.stringify({ archive })
    });
  }

  // Gmail chat command endpoint
  async processGmailCommand(data: { command: string; chatId: string }) {
    return this.request('/gmail/chat-command', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Google Services (Calendar & Drive) endpoints
  async getGoogleServicesStatus() {
    return this.request('/auth/google-services/status');
  }

  async connectGoogleServices() {
    return this.request('/auth/google-services');
  }

  async disconnectGoogleServices() {
    return this.request('/auth/google-services/disconnect', {
      method: 'POST',
    });
  }

  async generateGoogleServicesResponse(data: { prompt: string; chatId?: string; model: string }) {
    const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const payload = {
      ...data,
      timeZone: userTimeZone // <-- Har request ke sath timezone bhejein
    };

    console.log(userTimeZone);

    return this.request('/ai/generate-google-services', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  // Spotify endpoints
  async getSpotifyAuthUrl() {
    return this.request('/spotify/connect');
  }

  async processSpotifyCommand(data: { prompt: string; chatId?: string }) {
    return this.request('/spotify/command', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getSpotifyStatus() {
    return this.request('/spotify/status');
  }

  async startComputerUseChatIntegration(data: { message: string; chatId: string; sessionId?: string }) {
    return this.request('/computer-use/chat-integration', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Thesis Generation endpoints
  async generateThesis(data: { topics: string[]; chatId?: string }) {
    return this.request('/thesis/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getThesisStatus(sessionId: string) {
    return this.request(`/thesis/status/${sessionId}`);
  }

  async updateWordContent(chatId: string, content: string) {
    return this.request(`/chats/${chatId}/word-content`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  }

  async downloadThesis(sessionId: string) {
    const url = `${this.baseURL}/thesis/download/${sessionId}`;
    const headers = new Headers();
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to download thesis');
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `thesis-${sessionId}.docx`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(downloadUrl);
    document.body.removeChild(a);
  }
}

export const apiClient = new ApiClient(API_BASE_URL);
export default apiClient;
