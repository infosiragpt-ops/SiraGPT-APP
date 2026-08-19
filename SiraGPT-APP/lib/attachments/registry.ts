import { z } from 'zod'

/**
 * Attachment registry — typed, Zod-validated catalogue of attachment kinds.
 *
 * Pure TypeScript: no DOM APIs, safe to import from both server and client code.
 *
 * Extensibility note (registerKind): the set of kinds is intentionally CLOSED
 * to the `ATTACHMENT_KINDS` enum. The registry accepts any number of new
 * descriptors for *existing* kinds via `register()` (e.g. a second `document`
 * descriptor covering `.epub`). To introduce a brand-new kind in the future,
 * extend `ATTACHMENT_KINDS` here (a hypothetical `registerKind()` API was
 * deliberately not added so the discriminated unions downstream stay sound).
 */

export const ATTACHMENT_KINDS = [
  'image',
  'video',
  'audio',
  'document',
  'link',
  'text-snippet',
] as const

export const AttachmentKindSchema = z.enum(ATTACHMENT_KINDS)

export type AttachmentKind = z.infer<typeof AttachmentKindSchema>

/** Descriptor describing how files map onto an attachment kind. */
export const AttachmentDescriptorSchema = z.object({
  kind: AttachmentKindSchema,
  /** Human label in Spanish, e.g. 'Imagen'. */
  label: z.string().min(1),
  /** MIME prefixes such as 'image/'. Matched with startsWith. */
  mimePrefixes: z.array(z.string().min(1)),
  /** Full MIME strings matched exactly (case-insensitive). */
  exactMimes: z.array(z.string().min(1)),
  /** File extensions, lowercase, without the leading dot. */
  extensions: z.array(
    z
      .string()
      .min(1)
      .regex(/^[a-z0-9]+$/, 'extensions must be lowercase, without dot'),
  ),
  /** Optional per-kind size cap in bytes. */
  maxBytes: z.number().int().positive().optional(),
})

export type AttachmentDescriptor = z.infer<typeof AttachmentDescriptorSchema>
export type AttachmentDescriptorInput = z.input<typeof AttachmentDescriptorSchema>

/** Upload limits. `allowedMimes: null` means "use the registry whitelist". */
export const AttachmentLimitsSchema = z.object({
  maxFiles: z.number().int().positive().default(400),
  maxBytesPerFile: z
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
  allowedMimes: z.array(z.string().min(1)).nullable().default(null),
})

export type AttachmentLimits = z.infer<typeof AttachmentLimitsSchema>
export type AttachmentLimitsInput = z.input<typeof AttachmentLimitsSchema>

export interface AttachmentResolution {
  kind: AttachmentKind
  descriptor: AttachmentDescriptor
}

export type AttachmentAllowedResult =
  | { ok: true }
  | { ok: false; reason: string }

export interface AttachmentFileLike {
  /** MIME type as reported by the browser/file system. */
  type: string
  /** File name (used for extension fallback). */
  name: string
  /** Size in bytes. */
  size: number
}

/** Synthetic fallback used when no 'document' descriptor is registered. */
const FALLBACK_DOCUMENT_DESCRIPTOR: AttachmentDescriptor = Object.freeze({
  kind: 'document',
  label: 'Documento',
  mimePrefixes: [],
  exactMimes: [],
  extensions: [],
}) as AttachmentDescriptor

function normalizeMime(mime?: string): string {
  if (!mime) return ''
  // Strip parameters such as '; charset=utf-8' and lowercase.
  return mime.split(';')[0].trim().toLowerCase()
}

function extensionFromFilename(filename?: string): string {
  if (!filename) return ''
  const idx = filename.lastIndexOf('.')
  if (idx <= 0 || idx === filename.length - 1) return ''
  return filename.slice(idx + 1).toLowerCase()
}

/**
 * Formats a byte count as a human-readable Spanish string ('1,5 MB').
 * Decimal separator is a comma; trailing ',0' is trimmed ('1 KB', not '1,0 KB').
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let value = n
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const text =
    unitIndex === 0
      ? String(Math.round(value))
      : value.toFixed(1).replace(/\.0$/, '').replace('.', ',')
  return `${text} ${units[unitIndex]}`
}

/**
 * Registry of attachment descriptors with resolution + validation helpers.
 * Resolution priority: exact MIME match > MIME prefix > file extension >
 * fallback to the 'document' kind.
 */
export class AttachmentRegistry {
  private descriptors: AttachmentDescriptor[] = []

  /** Validates with Zod and registers a descriptor. Throws on invalid input. */
  register(descriptor: AttachmentDescriptorInput): AttachmentDescriptor {
    const parsed = AttachmentDescriptorSchema.parse(descriptor)
    this.descriptors.push(parsed)
    return parsed
  }

  /** Returns a copy of every registered descriptor, in registration order. */
  list(): AttachmentDescriptor[] {
    return this.descriptors.map((d) => ({ ...d }))
  }

  /**
   * Resolves a MIME type and/or filename to a kind + descriptor.
   * Falls back to the 'document' kind when nothing matches.
   */
  resolve(mime?: string, filename?: string): AttachmentResolution {
    const match = this.match(mime, filename)
    if (match) return { kind: match.kind, descriptor: match }
    const documentDescriptor =
      this.descriptors.find((d) => d.kind === 'document') ??
      FALLBACK_DOCUMENT_DESCRIPTOR
    return { kind: 'document', descriptor: documentDescriptor }
  }

  /**
   * Checks a single file against the limits. File-count enforcement
   * (`maxFiles`) is the caller's responsibility — it owns the batch.
   */
  isAllowed(
    file: AttachmentFileLike,
    limits?: AttachmentLimitsInput,
  ): AttachmentAllowedResult {
    const parsedLimits = AttachmentLimitsSchema.parse(limits ?? {})
    const mime = normalizeMime(file.type)
    const ext = extensionFromFilename(file.name)

    if (file.size > parsedLimits.maxBytesPerFile) {
      return {
        ok: false,
        reason: `El archivo "${file.name}" supera el tamaño máximo permitido (${formatBytes(
          parsedLimits.maxBytesPerFile,
        )}).`,
      }
    }

    if (parsedLimits.allowedMimes !== null) {
      const allowed = parsedLimits.allowedMimes.some((entry) => {
        const normalized = entry.trim().toLowerCase()
        if (normalized.endsWith('/')) return mime.startsWith(normalized)
        return mime === normalized
      })
      if (!allowed) {
        return {
          ok: false,
          reason: `El tipo de archivo "${mime || ext || file.name}" no está permitido.`,
        }
      }
    } else {
      const match = this.match(file.type, file.name)
      if (!match) {
        return {
          ok: false,
          reason: `El tipo de archivo "${mime || ext || file.name}" no está permitido.`,
        }
      }
      if (match.maxBytes !== undefined && file.size > match.maxBytes) {
        return {
          ok: false,
          reason: `El archivo "${file.name}" supera el tamaño máximo para ${match.label} (${formatBytes(
            match.maxBytes,
          )}).`,
        }
      }
    }

    return { ok: true }
  }

  /** Internal matcher without the document fallback. */
  private match(mime?: string, filename?: string): AttachmentDescriptor | null {
    const normalizedMime = normalizeMime(mime)
    const ext = extensionFromFilename(filename)

    if (normalizedMime) {
      for (const d of this.descriptors) {
        if (d.exactMimes.some((m) => m.toLowerCase() === normalizedMime)) {
          return d
        }
      }
      for (const d of this.descriptors) {
        if (d.mimePrefixes.some((p) => normalizedMime.startsWith(p.toLowerCase()))) {
          return d
        }
      }
    }

    if (ext) {
      for (const d of this.descriptors) {
        if (d.extensions.includes(ext)) return d
      }
    }

    return null
  }
}

/** Default registry covering the common chat-attachment formats. */
export const defaultAttachmentRegistry = new AttachmentRegistry()

defaultAttachmentRegistry.register({
  kind: 'image',
  label: 'Imagen',
  mimePrefixes: ['image/'],
  exactMimes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'],
  extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'],
})

defaultAttachmentRegistry.register({
  kind: 'video',
  label: 'Video',
  mimePrefixes: ['video/'],
  exactMimes: ['video/mp4', 'video/quicktime', 'video/webm'],
  extensions: ['mp4', 'mov', 'webm'],
})

defaultAttachmentRegistry.register({
  kind: 'audio',
  label: 'Audio',
  mimePrefixes: ['audio/'],
  exactMimes: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a'],
  extensions: ['mp3', 'wav', 'm4a'],
})

defaultAttachmentRegistry.register({
  kind: 'document',
  label: 'Documento',
  mimePrefixes: ['text/'],
  exactMimes: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/csv',
    'text/plain',
    'text/markdown',
    'application/json',
    'application/zip',
  ],
  extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'md', 'json', 'zip'],
})

/** UI chip model for an attachment being uploaded/processed in the composer. */
export const AttachmentChipModelSchema = z.object({
  id: z.string().min(1),
  kind: AttachmentKindSchema,
  name: z.string(),
  size: z.number().nonnegative(),
  mime: z.string(),
  status: z.enum(['pending', 'uploading', 'processing', 'ready', 'failed']),
  progress: z.number().min(0).max(100),
  previewUrl: z.string().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  waveformPeaks: z.array(z.number()).optional(),
  og: z
    .object({
      title: z.string().optional(),
      faviconUrl: z.string().optional(),
      imageUrl: z.string().optional(),
    })
    .optional(),
})

export type AttachmentChipModel = z.infer<typeof AttachmentChipModelSchema>
