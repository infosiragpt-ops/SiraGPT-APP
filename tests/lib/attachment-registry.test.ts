import { describe, it, expect } from 'vitest'
import {
  ATTACHMENT_KINDS,
  AttachmentChipModelSchema,
  AttachmentDescriptorSchema,
  AttachmentLimitsSchema,
  AttachmentRegistry,
  defaultAttachmentRegistry,
  formatBytes,
} from '@/lib/attachments/registry'

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

describe('AttachmentRegistry — kind resolution', () => {
  it('resolves by exact MIME (video/quicktime → video)', () => {
    const { kind } = defaultAttachmentRegistry.resolve('video/quicktime', 'clip.mov')
    expect(kind).toBe('video')
  })

  it('resolves by MIME prefix (image/x-unknown → image)', () => {
    const { kind, descriptor } = defaultAttachmentRegistry.resolve('image/x-unknown')
    expect(kind).toBe('image')
    expect(descriptor.label).toBe('Imagen')
  })

  it('resolves by extension when MIME is missing (song.m4a → audio)', () => {
    const { kind } = defaultAttachmentRegistry.resolve(undefined, 'song.m4a')
    expect(kind).toBe('audio')
  })

  it('falls back to document for unknown MIME and extension', () => {
    const { kind, descriptor } = defaultAttachmentRegistry.resolve(
      'application/x-mystery',
      'payload.weird',
    )
    expect(kind).toBe('document')
    expect(descriptor.kind).toBe('document')
  })

  it('strips MIME parameters and ignores case (TEXT/PLAIN; charset=utf-8)', () => {
    const { kind } = defaultAttachmentRegistry.resolve('TEXT/PLAIN; charset=utf-8')
    expect(kind).toBe('document')
  })

  it('resolves docx/xlsx/pptx by their full vnd.openxmlformats MIMEs', () => {
    expect(defaultAttachmentRegistry.resolve(DOCX_MIME).kind).toBe('document')
    expect(defaultAttachmentRegistry.resolve(XLSX_MIME).kind).toBe('document')
    expect(defaultAttachmentRegistry.resolve(PPTX_MIME).kind).toBe('document')
    const docx = defaultAttachmentRegistry.resolve(DOCX_MIME).descriptor
    expect(docx.exactMimes).toContain(DOCX_MIME)
    expect(docx.exactMimes).toContain(XLSX_MIME)
    expect(docx.exactMimes).toContain(PPTX_MIME)
  })

  it('exact MIME wins over a competing prefix from another descriptor', () => {
    const registry = new AttachmentRegistry()
    registry.register({
      kind: 'text-snippet',
      label: 'Fragmento de texto',
      mimePrefixes: ['audio/'],
      exactMimes: [],
      extensions: [],
    })
    registry.register({
      kind: 'audio',
      label: 'Audio',
      mimePrefixes: [],
      exactMimes: ['audio/mpeg'],
      extensions: ['mp3'],
    })
    expect(registry.resolve('audio/mpeg').kind).toBe('audio')
    expect(registry.resolve('audio/ogg').kind).toBe('text-snippet')
  })
})

describe('AttachmentRegistry — isAllowed', () => {
  it('rejects files above maxBytesPerFile with a Spanish reason', () => {
    const result = defaultAttachmentRegistry.isAllowed(
      { type: 'application/pdf', name: 'grande.pdf', size: 200 * 1024 * 1024 },
      {},
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('supera el tamaño máximo')
      expect(result.reason).toContain('100 MB')
    }
  })

  it('accepts whitelisted files within the size cap', () => {
    const result = defaultAttachmentRegistry.isAllowed({
      type: 'application/pdf',
      name: 'informe.pdf',
      size: 1024,
    })
    expect(result).toEqual({ ok: true })
  })

  it('rejects non-whitelisted types when allowedMimes is null (registry whitelist)', () => {
    const result = defaultAttachmentRegistry.isAllowed({
      type: 'application/x-msdownload',
      name: 'setup.exe',
      size: 10,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('no está permitido')
  })

  it('honours the allowedMimes override (exact and prefix entries)', () => {
    const limits = { allowedMimes: ['image/png', 'video/'] }
    expect(
      defaultAttachmentRegistry.isAllowed(
        { type: 'image/png', name: 'a.png', size: 10 },
        limits,
      ).ok,
    ).toBe(true)
    expect(
      defaultAttachmentRegistry.isAllowed(
        { type: 'video/webm', name: 'b.webm', size: 10 },
        limits,
      ).ok,
    ).toBe(true)
    const rejected = defaultAttachmentRegistry.isAllowed(
      { type: 'application/pdf', name: 'c.pdf', size: 10 },
      limits,
    )
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toContain('application/pdf')
  })

  it('enforces a per-descriptor maxBytes cap', () => {
    const registry = new AttachmentRegistry()
    registry.register({
      kind: 'image',
      label: 'Imagen',
      mimePrefixes: ['image/'],
      exactMimes: [],
      extensions: ['png'],
      maxBytes: 1024,
    })
    const result = registry.isAllowed({
      type: 'image/png',
      name: 'foto.png',
      size: 2048,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('Imagen')
  })
})

describe('Zod schemas', () => {
  it('rejects descriptors with an unknown kind', () => {
    expect(() =>
      new AttachmentRegistry().register({
        // @ts-expect-error — intentionally invalid kind
        kind: 'banana',
        label: 'Banana',
        mimePrefixes: [],
        exactMimes: [],
        extensions: [],
      }),
    ).toThrow()
  })

  it('rejects extensions with dots or uppercase characters', () => {
    const base = {
      kind: 'document' as const,
      label: 'Documento',
      mimePrefixes: [],
      exactMimes: [],
    }
    expect(
      AttachmentDescriptorSchema.safeParse({ ...base, extensions: ['.pdf'] }).success,
    ).toBe(false)
    expect(
      AttachmentDescriptorSchema.safeParse({ ...base, extensions: ['PDF'] }).success,
    ).toBe(false)
    expect(
      AttachmentDescriptorSchema.safeParse({ ...base, extensions: ['pdf'] }).success,
    ).toBe(true)
  })

  it('applies limit defaults (maxFiles 20, 100 MB, allowedMimes null)', () => {
    const limits = AttachmentLimitsSchema.parse({})
    expect(limits.maxFiles).toBe(20)
    expect(limits.maxBytesPerFile).toBe(100 * 1024 * 1024)
    expect(limits.allowedMimes).toBeNull()
  })

  it('parses a valid chip model and rejects invalid status/progress', () => {
    const chip = AttachmentChipModelSchema.parse({
      id: 'att-1',
      kind: 'audio',
      name: 'nota-de-voz.m4a',
      size: 4096,
      mime: 'audio/mp4',
      status: 'uploading',
      progress: 42,
      durationSeconds: 12.5,
      waveformPeaks: [0.1, 0.8, 0.4],
    })
    expect(chip.kind).toBe('audio')
    expect(chip.og).toBeUndefined()

    expect(
      AttachmentChipModelSchema.safeParse({
        id: 'att-2',
        kind: 'image',
        name: 'a.png',
        size: 1,
        mime: 'image/png',
        status: 'exploded',
        progress: 0,
      }).success,
    ).toBe(false)

    expect(
      AttachmentChipModelSchema.safeParse({
        id: 'att-3',
        kind: 'image',
        name: 'a.png',
        size: 1,
        mime: 'image/png',
        status: 'ready',
        progress: 150,
      }).success,
    ).toBe(false)
  })

  it('parses a link chip with og metadata', () => {
    const chip = AttachmentChipModelSchema.parse({
      id: 'att-4',
      kind: 'link',
      name: 'https://example.com',
      size: 0,
      mime: 'text/html',
      status: 'ready',
      progress: 100,
      og: { title: 'Ejemplo', faviconUrl: 'https://example.com/favicon.ico' },
    })
    expect(chip.og?.title).toBe('Ejemplo')
  })
})

describe('registry surface', () => {
  it('exposes the closed kind enum', () => {
    expect(ATTACHMENT_KINDS).toEqual([
      'image',
      'video',
      'audio',
      'document',
      'link',
      'text-snippet',
    ])
  })

  it('list() returns copies of every registered descriptor', () => {
    const all = defaultAttachmentRegistry.list()
    expect(all.length).toBeGreaterThanOrEqual(4)
    const kinds = all.map((d) => d.kind)
    expect(kinds).toEqual(expect.arrayContaining(['image', 'video', 'audio', 'document']))
    // Mutating the copy must not affect the registry.
    all[0].label = 'mutado'
    expect(defaultAttachmentRegistry.list()[0].label).not.toBe('mutado')
  })

  it('accepts additional descriptors for an existing kind', () => {
    const registry = new AttachmentRegistry()
    registry.register({
      kind: 'document',
      label: 'Documento',
      mimePrefixes: [],
      exactMimes: ['application/pdf'],
      extensions: ['pdf'],
    })
    registry.register({
      kind: 'document',
      label: 'Libro electrónico',
      mimePrefixes: [],
      exactMimes: ['application/epub+zip'],
      extensions: ['epub'],
    })
    const { descriptor } = registry.resolve('application/epub+zip', 'libro.epub')
    expect(descriptor.label).toBe('Libro electrónico')
    expect(registry.list()).toHaveLength(2)
  })
})

describe('formatBytes', () => {
  it('formats with Spanish comma decimals', () => {
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1,5 MB')
    expect(formatBytes(2.5 * 1024)).toBe('2,5 KB')
  })

  it('trims trailing zero decimals and handles edge values', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 MB')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})
