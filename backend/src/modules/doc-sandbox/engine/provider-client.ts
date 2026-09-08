import Anthropic, { toFile } from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

export interface ProviderFile {
  id: string;
  filename: string;
  size_bytes: number;
  mime_type: string;
  downloadable?: boolean;
}

export interface ProviderCallOptions {
  signal: AbortSignal;
  timeoutMs: number;
}

/** Narrow boundary for SDK-only unit mocks; production always uses the real SDK. */
export interface DocumentProviderClient {
  upload(bytes: Uint8Array, filename: string, mime: string, options: ProviderCallOptions): Promise<ProviderFile>;
  message(request: MessageCreateParamsNonStreaming, options: ProviderCallOptions): Promise<BetaMessage>;
  metadata(id: string, options: ProviderCallOptions): Promise<ProviderFile>;
  download(id: string, options: ProviderCallOptions): Promise<Response>;
  delete(id: string, options: ProviderCallOptions): Promise<void>;
}

/**
 * SDK 0.92.0 exposes Files only under beta; it supplies multipart/form-data itself.
 * No broad SDK upgrade or casts to unimplemented GA namespaces are necessary.
 * Verified against official Files/Skills/Code execution docs on 2026-09-04.
 */
export class AnthropicDocumentProviderClient implements DocumentProviderClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey.trim()) throw new Error('DOC_ENGINE_CREDENTIAL_REQUIRED');
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  async upload(bytes: Uint8Array, filename: string, mime: string, options: ProviderCallOptions): Promise<ProviderFile> {
    return this.client.beta.files.upload(
      { file: await toFile(bytes, filename, { type: mime }) },
      this.options(options),
    );
  }

  async message(request: MessageCreateParamsNonStreaming, options: ProviderCallOptions): Promise<BetaMessage> {
    return this.client.beta.messages.create(request, this.options(options));
  }

  async metadata(id: string, options: ProviderCallOptions): Promise<ProviderFile> {
    return this.client.beta.files.retrieveMetadata(id, {}, this.options(options));
  }

  async download(id: string, options: ProviderCallOptions): Promise<Response> {
    return this.client.beta.files.download(id, {}, this.options(options));
  }

  async delete(id: string, options: ProviderCallOptions): Promise<void> {
    try {
      await this.client.beta.files.delete(id, {}, this.options(options));
    } catch (error: unknown) {
      // A persisted retry may observe a file already deleted by a previous worker.
      if (error instanceof Anthropic.APIError && error.status === 404) return;
      throw error;
    }
  }

  private options(options: ProviderCallOptions) {
    return { signal: options.signal, timeout: options.timeoutMs, maxRetries: 0 };
  }
}
