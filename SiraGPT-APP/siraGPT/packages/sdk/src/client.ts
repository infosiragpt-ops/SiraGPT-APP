/**
 * SiraGPTClient — public TypeScript SDK wrapping the SiraGPT HTTP API.
 *
 * The method signatures below mirror the typed payloads declared in
 * `lib/api-types.ts` (auto-generated from Zod schemas in
 * `backend/src/schemas/`). When the schemas change, re-run
 * `node backend/scripts/generate-api-types.js` and update the imports here.
 */

import {
  SiraGPTError,
  AuthError,
  errorFromResponse,
} from './errors.js';

// ---------------------------------------------------------------------------
// Inline type subset (mirrors lib/api-types.ts — keep in sync)
// ---------------------------------------------------------------------------
export interface AuthUser {
  id: string | number;
  email: string;
  name?: string | null;
  plan?: string;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
}
export interface AuthResponse {
  user: AuthUser;
  token: string;
}
export interface CreateChatRequest {
  title: string;
  model: string;
  isWordConnectorChat?: boolean;
  isExcelConnectorChat?: boolean;
  projectId?: string | number;
}
export interface ChatMessage {
  id: string | number;
  chatId: string | number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  model?: string | null;
  createdAt?: string;
}
export interface ChatResponse {
  id: string | number;
  title: string;
  model?: string | null;
  userId?: string | number;
  messages?: ChatMessage[];
}
export interface AICompletionRequest {
  chatId?: string | number;
  model: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
}
export interface AICompletionResponse {
  id: string;
  model: string;
  content: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}
export interface FileMetadata {
  id: string | number;
  name: string;
  mimeType?: string;
  size?: number;
  status?: string;
}
export interface AgentTaskRequest {
  goal: string;
  context?: unknown;
  skills?: string[];
}
export interface AgentTaskResponse {
  taskId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------
export type RefreshCallback = () => Promise<string | null> | string | null;

export interface SiraGPTClientOptions {
  /** Base URL of the SiraGPT API (e.g. `https://siragpt.io`). */
  baseUrl: string;
  /** Bearer token for the current session. */
  token?: string;
  /**
   * Optional callback invoked on 401 responses. Should return a fresh token
   * or `null` when the user must re-authenticate.
   */
  onRefreshToken?: RefreshCallback;
  /** Override `fetch` (Node < 18, test mocks, etc.). */
  fetch?: typeof fetch;
  /** Default timeout per request, in milliseconds. */
  timeoutMs?: number;
  /** Optional default headers (e.g. `X-Client-Name`). */
  defaultHeaders?: Record<string, string>;
  /** Optional user-agent override. */
  userAgent?: string;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Set false to skip auth header (e.g. login/register). */
  auth?: boolean;
}

// ---------------------------------------------------------------------------
// SiraGPTClient
// ---------------------------------------------------------------------------
export class SiraGPTClient {
  private readonly baseUrl: string;
  private token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly onRefreshToken?: RefreshCallback;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: SiraGPTClientOptions) {
    if (!opts.baseUrl) throw new SiraGPTError('baseUrl is required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.onRefreshToken = opts.onRefreshToken;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    const resolvedFetch = opts.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!resolvedFetch) {
      throw new SiraGPTError('No global fetch available; pass options.fetch.');
    }
    this.fetchImpl = resolvedFetch.bind(globalThis);
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}),
      ...(opts.defaultHeaders ?? {}),
    };
  }

  /** Replace the bearer token used for subsequent requests. */
  setToken(token: string | undefined): void {
    this.token = token;
  }

  getToken(): string | undefined {
    return this.token;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  async register(input: { email: string; password: string; name?: string }): Promise<AuthResponse> {
    const res = await this.request<AuthResponse>({
      method: 'POST',
      path: '/api/auth/register',
      body: input,
      auth: false,
    });
    if (res.token) this.token = res.token;
    return res;
  }

  async login(input: { email: string; password: string }): Promise<AuthResponse> {
    const res = await this.request<AuthResponse>({
      method: 'POST',
      path: '/api/auth/login',
      body: input,
      auth: false,
    });
    if (res.token) this.token = res.token;
    return res;
  }

  async me(): Promise<AuthUser> {
    return this.request<AuthUser>({ method: 'GET', path: '/api/auth/me' });
  }

  async logout(): Promise<void> {
    await this.request<void>({ method: 'POST', path: '/api/auth/logout' });
    this.token = undefined;
  }

  // -------------------------------------------------------------------------
  // Chats
  // -------------------------------------------------------------------------
  listChats(query?: { limit?: number; cursor?: string }): Promise<{ items: ChatResponse[]; nextCursor?: string }> {
    return this.request({ method: 'GET', path: '/api/chats', query });
  }
  createChat(body: CreateChatRequest): Promise<ChatResponse> {
    return this.request({ method: 'POST', path: '/api/chats', body });
  }
  getChat(id: string | number): Promise<ChatResponse> {
    return this.request({ method: 'GET', path: `/api/chats/${encodeURIComponent(String(id))}` });
  }
  deleteChat(id: string | number): Promise<{ ok: true }> {
    return this.request({ method: 'DELETE', path: `/api/chats/${encodeURIComponent(String(id))}` });
  }

  // -------------------------------------------------------------------------
  // AI completion
  // -------------------------------------------------------------------------
  complete(body: AICompletionRequest): Promise<AICompletionResponse> {
    return this.request({ method: 'POST', path: '/api/ai/chat', body });
  }

  /**
   * Streams completion deltas via Server-Sent Events. Yields raw text chunks
   * suitable for `for await (const chunk of client.streamComplete(...))`.
   */
  async *streamComplete(body: AICompletionRequest, signal?: AbortSignal): AsyncGenerator<string> {
    const res = await this.rawRequest({
      method: 'POST',
      path: '/api/ai/chat',
      body: { ...body, stream: true },
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          yield payload;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------
  listFiles(): Promise<{ items: FileMetadata[] }> {
    return this.request({ method: 'GET', path: '/api/files' });
  }
  getFile(id: string | number): Promise<FileMetadata> {
    return this.request({ method: 'GET', path: `/api/files/${encodeURIComponent(String(id))}` });
  }

  // -------------------------------------------------------------------------
  // Agent
  // -------------------------------------------------------------------------
  runAgentTask(body: AgentTaskRequest): Promise<AgentTaskResponse> {
    return this.request({ method: 'POST', path: '/api/agent/task', body });
  }
  getAgentTask(taskId: string): Promise<AgentTaskResponse & { result?: unknown }> {
    return this.request({ method: 'GET', path: `/api/agent/task/${encodeURIComponent(taskId)}` });
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------
  health(): Promise<{ status: string; services?: Record<string, unknown> }> {
    return this.request({ method: 'GET', path: '/api/admin/health/services', auth: false });
  }

  // -------------------------------------------------------------------------
  // Low-level helpers
  // -------------------------------------------------------------------------
  async request<T>(opts: RequestOptions): Promise<T> {
    const res = await this.rawRequest(opts);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const body = text ? safeJsonParse(text) : undefined;
    return body as T;
  }

  private async rawRequest(opts: RequestOptions): Promise<Response> {
    const url = this.buildUrl(opts.path, opts.query);
    const headers: Record<string, string> = { ...this.defaultHeaders, ...(opts.headers ?? {}) };
    const auth = opts.auth !== false;
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;

    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    };

    const controller = new AbortController();
    const onSignalAbort = () => controller.abort();
    if (opts.signal) opts.signal.addEventListener('abort', onSignalAbort);
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);
    init.signal = controller.signal;

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      throw new SiraGPTError('Network error', {
        code: (err as Error)?.name === 'AbortError' ? 'timeout' : 'network',
        cause: err,
      });
    } finally {
      clearTimeout(timeout);
      if (opts.signal) opts.signal.removeEventListener('abort', onSignalAbort);
    }

    if (res.status === 401 && auth && this.onRefreshToken) {
      const fresh = await this.onRefreshToken();
      if (fresh) {
        this.token = fresh;
        headers.Authorization = `Bearer ${fresh}`;
        // Single retry with refreshed token.
        return this.fetchImpl(url, { ...init, headers });
      }
      throw new AuthError('Session expired', { status: 401 });
    }

    if (!res.ok) {
      const requestId = res.headers.get('x-request-id') ?? undefined;
      let body: unknown;
      try {
        body = await res.clone().json();
      } catch {
        try {
          body = await res.clone().text();
        } catch {
          body = undefined;
        }
      }
      throw errorFromResponse(res.status, body, requestId);
    }
    return res;
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(path.startsWith('/') ? path : `/${path}`, this.baseUrl + '/');
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
