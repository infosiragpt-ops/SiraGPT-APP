import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { documentFormatSchema, fileNameSchema, identifierSchema, type DocumentFormat } from '../types/contracts';
import { DocSandboxError, publicError } from '../types/errors';
import { DocumentRepositoryError, type StoredArtifact } from '../queue/repository';
import multer from 'multer';

// HTTP data decisions are independent of transport and durable IO. The router
// remains responsible for authentication, admission slots and all effects.
const MIME: Readonly<Record<DocumentFormat, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html',
};
const admissionSchema = z.object({ instructions: z.string().trim().min(1).max(50_000),
  mode: z.literal('preserve').default('preserve'), modelTier: z.enum(['mechanical', 'academic']).default('mechanical'),
  requestedModel: z.string().trim().min(1).max(200).optional(),
  permission: z.enum(['default', 'read', 'protected', 'workspace', 'full']).default('default') }).strict();
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** UTF-8 multipart filenames are decoded without replacing invalid bytes or losing accents. */
export function originalFilename(name: string): string {
  if ([...name].some((char) => char.codePointAt(0)! > 255)) return fileNameSchema.parse(name);
  const latin = Buffer.from(name, 'latin1');
  const decoded = latin.toString('utf8');
  const resolved = !decoded.includes('\uFFFD') && Buffer.from(decoded).equals(latin) ? decoded : name;
  return fileNameSchema.parse(resolved);
}
export function classifyInput(name: string, bytes: Buffer): { format: DocumentFormat; mime: string } {
  const format = documentFormatSchema.parse(name.split('.').pop()?.toLowerCase());
  // Cheap admission checks only. Full MIME/ZIP/XML checks run independently before any paid call.
  if (['docx', 'xlsx', 'pptx'].includes(format) && !bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new DocSandboxError('E_PARAMS', 415);
  if (format === 'pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new DocSandboxError('E_PARAMS', 415);
  return { format, mime: MIME[format] };
}

export type DocumentAdmission = z.infer<typeof admissionSchema>;
export interface UploadedDocumentFile { originalname: string; buffer: Buffer; }
export interface AdmittedDocumentInput {
  id: string; name: string; format: DocumentFormat; mime: string; data: Buffer; sha256: string;
}
export function parseDocumentAdmission(body: unknown): DocumentAdmission {
  const params = admissionSchema.parse(body);
  if (params.permission === 'read' || params.permission === 'protected') throw new DocSandboxError('E_PLAN_GATE', 403);
  return params;
}
export function prepareDocumentInputs(files: UploadedDocumentFile[] | Record<string, UploadedDocumentFile[]> | undefined): AdmittedDocumentInput[] {
  if (!Array.isArray(files) || !files.length) throw new DocSandboxError('E_PARAMS');
  const inputs = files.map((file) => {
    const name = originalFilename(file.originalname); const type = classifyInput(name, file.buffer);
    return { id: randomUUID(), name, ...type, data: file.buffer, sha256: sha256(file.buffer) };
  });
  if (inputs.length > 1 && inputs.some((input) => input.format !== 'pdf')) throw new DocSandboxError('E_PARAMS', 400);
  return inputs;
}
export function documentPayloadHash(params: DocumentAdmission, inputs: readonly AdmittedDocumentInput[]): string {
  return sha256(JSON.stringify({ ...params, inputs: inputs.map(({ name, format, sha256: hash }) => ({ name, format, sha256: hash })) }));
}
export function documentRequestOwner(request: unknown): string {
  const parsed = z.object({ user: z.object({ id: identifierSchema }) }).safeParse(request);
  if (!parsed.success) throw new DocSandboxError('E_FORBIDDEN', 401);
  return parsed.data.user.id;
}
export function documentRequestPlan(request: unknown): string {
  const parsed = z.object({ user: z.object({ plan: z.string().optional() }) }).safeParse(request);
  return parsed.success ? parsed.data.user.plan || 'FREE' : 'FREE';
}
export function parseDocumentIdempotencyKey(value: unknown): string {
  return z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/).parse(value);
}
export function documentArtifactForDownload(artifacts: readonly StoredArtifact[], artifactId: string): StoredArtifact {
  // Only consume repository.artifactsOwned results; this lookup cannot establish ownership.
  const artifact = artifacts.find((entry) => entry.id === artifactId);
  if (!artifact) throw new DocSandboxError('E_NOT_FOUND', 404);
  return artifact;
}
export function documentDownloadHeaders(filename: string, byteLength: number): Record<string, string> {
  const encodedFilename = encodeURIComponent(fileNameSchema.parse(filename)).replace(/['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="document"; filename*=UTF-8''${encodedFilename}`, 'Content-Length': String(byteLength), 'Content-Security-Policy': "sandbox; default-src 'none'" };
}
export function parseDocumentEventCursor(lastEventId: string | undefined, after: unknown): number {
  const cursor = Number(lastEventId ?? after ?? '0');
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DocSandboxError('E_PARAMS');
  return cursor;
}
export function documentApiError(error: unknown): ReturnType<typeof publicError> {
  if (error instanceof z.ZodError || error instanceof multer.MulterError) return publicError(new DocSandboxError('E_PARAMS', 400));
  if (error instanceof DocumentRepositoryError) {
    const status = error.code === 'DOC_BUDGET_EXCEEDED' ? 429 : error.code === 'DOC_FORBIDDEN' ? 403 : ['DOC_NOT_FOUND', 'DOC_DELETED', 'DOC_EXPIRED'].includes(error.code) ? 404 : 409;
    return publicError(new DocSandboxError(status === 429 ? 'E_QUOTA' : status === 403 ? 'E_FORBIDDEN' : status === 404 ? 'E_NOT_FOUND' : 'E_CONFLICT', status));
  }
  return publicError(error);
}
