export { SiraGPTClient } from './client.js';
export type {
  SiraGPTClientOptions,
  RefreshCallback,
  AuthResponse,
  AuthUser,
  CreateChatRequest,
  ChatResponse,
  ChatMessage,
  AICompletionRequest,
  AICompletionResponse,
  FileMetadata,
  AgentTaskRequest,
  AgentTaskResponse,
} from './client.js';
export {
  SiraGPTError,
  AuthError,
  ValidationError,
  RateLimitError,
  errorFromResponse,
} from './errors.js';
export type { SiraGPTErrorCode, SiraGPTErrorOptions } from './errors.js';
