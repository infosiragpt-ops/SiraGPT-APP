/* eslint-disable */
// AUTO-GENERATED — DO NOT EDIT BY HAND.
// Regenerate with: `node backend/scripts/generate-api-types.js`
// Source schemas live in `backend/src/schemas/`.
export type AuthResponse = {
  user: {
    id: string | number;
    email: string;
    name?: string | null;
    plan?: string;
    isAdmin?: boolean;
    isSuperAdmin?: boolean;
    apiUsage?: number;
    monthlyCallLimit?: number | null;
    monthlyLimit?: number | null;
    createdAt?: string | string;
    updatedAt?: string | string;
    [key: string]: unknown;
  };
  token: string;
  [key: string]: unknown;
};

export type AuthUser = {
  id: string | number;
  email: string;
  name?: string | null;
  plan?: string;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  apiUsage?: number;
  monthlyCallLimit?: number | null;
  monthlyLimit?: number | null;
  createdAt?: string | string;
  updatedAt?: string | string;
  [key: string]: unknown;
};

export type ChatResponse = {
  id: string | number;
  title: string;
  model?: string | null;
  userId?: string | number;
  projectId?: string | null;
  isWordConnectorChat?: boolean;
  isExcelConnectorChat?: boolean;
  createdAt?: string | string;
  updatedAt?: string | string;
  messages?: Array<{
      id: string | number;
      chatId: string | number;
      role: "USER" | "ASSISTANT";
      content: string;
      tokens?: number | null;
      timestamp?: string | string;
      files?: Array<unknown> | string | null;
      metadata?: {
            [key: string]: unknown;
          } | string | null;
      feedback?: string | null;
      [key: string]: unknown;
    }>;
  [key: string]: unknown;
};

export type CreateChatRequest = {
  title: string;
  model: string;
  isWordConnectorChat?: boolean;
  isExcelConnectorChat?: boolean;
  projectId?: string;
  idempotencyKey?: string;
};

export type CreatePaymentRequest = {
  plan: "FREE" | "STARTER" | "PRO" | "BUSINESS" | "ENTERPRISE";
  provider: "stripe" | "paypal" | "mercadopago";
  amount?: number;
  currency?: string;
  interval?: "month" | "year";
  couponCode?: string;
  successUrl?: string;
  cancelUrl?: string;
};

export type Currency = string;

export type Email = string;

export type FileMetadata = {
  id: string | number;
  name: string;
  originalName?: string;
  mimeType?: string;
  size?: number;
  extension?: string | null;
  status?: string;
  userId?: string | number;
  chatId?: string | number | null;
  storageKey?: string | null;
  url?: string | null;
  error?: string | null;
  metadata?: {
      [key: string]: unknown;
    } | null;
  createdAt?: string | string;
  updatedAt?: string | string;
  [key: string]: unknown;
};

export type FileUploadResponse = {
  files: Array<{
      id: string | number;
      name: string;
      originalName?: string;
      mimeType?: string;
      size?: number;
      extension?: string | null;
      status?: string;
      userId?: string | number;
      chatId?: string | number | null;
      storageKey?: string | null;
      url?: string | null;
      error?: string | null;
      metadata?: {
          [key: string]: unknown;
        } | null;
      createdAt?: string | string;
      updatedAt?: string | string;
      [key: string]: unknown;
    }>;
  failed?: Array<{
      name: string;
      reason: string;
    }>;
  batchId?: string;
  intent?: {
      [key: string]: unknown;
    } | null;
  [key: string]: unknown;
};

export type ForgotPasswordRequest = {
  email: string;
};

export type IdempotencyKey = string;

export type LoginRequest = {
  email: string;
  password: string;
};

export type LoosePassword = string;

export type MessageResponse = {
  id: string | number;
  chatId: string | number;
  role: "USER" | "ASSISTANT";
  content: string;
  tokens?: number | null;
  timestamp?: string | string;
  files?: Array<unknown> | string | null;
  metadata?: {
        [key: string]: unknown;
      } | string | null;
  feedback?: string | null;
  [key: string]: unknown;
};

export type MessageRole = "USER" | "ASSISTANT";

export type ModelId = string;

export type PaymentResponse = {
  id?: string | number;
  sessionId?: string;
  checkoutUrl?: string;
  redirectUrl?: string;
  status?: "pending" | "succeeded" | "failed" | "requires_action" | "canceled" | "refunded";
  provider?: "stripe" | "paypal" | "mercadopago";
  amount?: number;
  currency?: string;
  plan?: "FREE" | "STARTER" | "PRO" | "BUSINESS" | "ENTERPRISE";
  createdAt?: string | string;
  [key: string]: unknown;
};

export type Plan = "FREE" | "STARTER" | "PRO" | "BUSINESS" | "ENTERPRISE";

export type Provider = "stripe" | "paypal" | "mercadopago";

export type RegisterRequest = {
  name: string;
  email: string;
  password: unknown & unknown;
};

export type ResetPasswordRequest = {
  token: string;
  password: unknown & unknown;
};

export type SendMessageRequest = {
  content: string;
  role: "USER" | "ASSISTANT";
  tokens?: number;
  files?: Array<unknown>;
  metadata?: {
      [key: string]: unknown;
    } | string;
  idempotencyKey?: string;
};

export type StrongPassword = unknown & unknown;

export type aiGenerateRequest = {
  messages: Array<{
      role: "system" | "user" | "assistant" | "tool";
      content: string;
      name?: string;
      tool_calls?: Array<unknown>;
      tool_call_id?: string;
    }>;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  model?: string;
  taskType?: "deep_reasoning" | "speed" | "multimodal" | "code" | "embeddings" | "default";
  files?: Array<{
      id?: string;
      name: string;
      mimeType?: string;
      content?: string;
      url?: string;
    }>;
  cacheBypass?: boolean;
  sessionId?: string;
  projectId?: string;
};

export type chatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: Array<unknown>;
  tool_call_id?: string;
};

export type fileUpload = {
  files: Array<{
      fieldname: string;
      originalname: string;
      encoding: string;
      mimetype: string;
      size: number;
      buffer?: unknown;
    }>;
  projectId?: string;
  metadata?: {
    [key: string]: unknown;
  };
};

export type inlineFile = {
  id?: string;
  name: string;
  mimeType?: string;
  content?: string;
  url?: string;
};
