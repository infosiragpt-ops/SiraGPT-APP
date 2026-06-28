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
  projectId?: string | number | null;
  isWordConnectorChat?: boolean;
  isExcelConnectorChat?: boolean;
  createdAt?: string | string;
  updatedAt?: string | string;
  messages?: Array<{
      id: string | number;
      chatId: string | number;
      role: "user" | "assistant" | "system" | "tool";
      content: string;
      model?: string | null;
      createdAt?: string | string;
      updatedAt?: string | string;
      metadata?: {
          [key: string]: unknown;
        } | null;
      attachments?: Array<unknown>;
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
  projectId?: string | number;
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

export type LoginRequest = {
  email: string;
  password: string;
};

export type LoosePassword = string;

export type MessageResponse = {
  id: string | number;
  chatId: string | number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  model?: string | null;
  createdAt?: string | string;
  updatedAt?: string | string;
  metadata?: {
      [key: string]: unknown;
    } | null;
  attachments?: Array<unknown>;
  feedback?: string | null;
  [key: string]: unknown;
};

export type MessageRole = "user" | "assistant" | "system" | "tool";

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

export type SendMessageRequest = {
  content: string;
  role?: "user" | "assistant" | "system" | "tool";
  model?: string;
  attachments?: Array<unknown>;
};

export type StrongPassword = unknown & unknown;
