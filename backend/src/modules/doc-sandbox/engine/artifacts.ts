import { createHash } from 'node:crypto';
import { z } from 'zod';

const safeName = z.string().min(1).max(180).refine(isSafeFilename, 'Unsafe export filename');
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const engineManifestSchema = z.object({
  schemaVersion: z.literal(1),
  stage: z.enum(['plan', 'edit']),
  files: z.array(z.object({
    filename: safeName,
    kind: z.enum(['edit_plan', 'agent_result', 'recipe', 'output']),
    inputId: z.string().max(128).optional(),
    sha256: digest,
  }).strict()).min(1).max(32),
}).strict();
export type EngineManifest = z.infer<typeof engineManifestSchema>;

export function isSafeFilename(name: string): boolean {
  return name.length > 0 && name.length <= 180 && name !== '.' && name !== '..'
    && !/[\\/\x00-\x1f\x7f<>:"|?*]/.test(name)
    && !/[. ]$/.test(name) && !/^\s/.test(name)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseJsonArtifact(bytes: Uint8Array, maximumBytes = 2 * 1024 * 1024): unknown {
  if (bytes.byteLength > maximumBytes) throw new Error('DOC_ENGINE_MANIFEST_TOO_LARGE');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('DOC_ENGINE_INVALID_JSON');
  }
}

/** Read with a streaming limit; Content-Length alone is not trusted. */
export async function readBoundedResponse(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  // Request cancellation of rejected bodies too, without awaiting a transport
  // cleanup that can hang or reject. The primary failure must still settle;
  // this is not confirmation of remote file deletion (tracked separately).
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('DOC_ENGINE_DOWNLOAD_FAILED');
  }
  if (signal.aborted) {
    void response.body.cancel().catch(() => undefined);
    signal.throwIfAborted();
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) {
    void response.body.cancel().catch(() => undefined);
    throw new Error('DOC_ENGINE_OUTPUT_TOO_LARGE');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        void reader.cancel().catch(() => undefined);
        throw new Error('DOC_ENGINE_OUTPUT_TOO_LARGE');
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/** Only provider-generated tool output references are accepted, never prose file IDs. */
export function extractGeneratedFileIds(content: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const block of content) {
    if (!isRecord(block) || !['bash_code_execution_tool_result', 'code_execution_tool_result'].includes(String(block.type))) continue;
    const result = block.content;
    if (!isRecord(result) || !['bash_code_execution_result', 'code_execution_result'].includes(String(result.type))) continue;
    if (!Array.isArray(result.content)) continue;
    for (const entry of result.content) {
      if (isRecord(entry) && ['bash_code_execution_output', 'code_execution_output'].includes(String(entry.type))) {
        if (typeof entry.file_id !== 'string' || !/^file_[a-zA-Z0-9_-]{1,180}$/.test(entry.file_id)) {
          throw new Error('DOC_ENGINE_INVALID_FILE_REFERENCE');
        }
        ids.add(entry.file_id);
      }
    }
  }
  return [...ids];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
