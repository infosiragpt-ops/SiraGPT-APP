import { describe, it, expect, afterEach, vi } from 'vitest'
import { writeWordClipboardPayload } from '../../lib/rich-clipboard'

// Safari does NOT accept `text/rtf` in a ClipboardItem, and lacks the
// `ClipboardItem.supports()` static. Before the fix, the code optimistically
// added text/rtf, which made Safari reject the whole rich write and silently
// drop to plain text. These tests pin the progressive-fallback behaviour:
// the user must still get the formatted `text/html` on Safari.

const payload = {
  text: 'hola\tmundo',
  html: '<p><strong>hola</strong></p>',
  rtf: '{\\rtf1 hola}',
}

function install({ supports, write }: { supports?: boolean; write: (items: Record<string, Blob>) => Promise<void> }) {
  const writes: string[][] = []
  class FakeClipboardItem {
    items: Record<string, Blob>
    constructor(items: Record<string, Blob>) { this.items = items }
    static supports?: (t: string) => boolean
  }
  if (supports !== undefined) FakeClipboardItem.supports = () => supports
  ;(window as unknown as { ClipboardItem: unknown }).ClipboardItem = FakeClipboardItem
  ;(window as unknown as { isSecureContext: boolean }).isSecureContext = true
  const writeText = vi.fn(async () => {})
  ;(navigator as unknown as { clipboard: unknown }).clipboard = {
    write: vi.fn(async (arr: FakeClipboardItem[]) => {
      writes.push(Object.keys(arr[0].items))
      return write(arr[0].items)
    }),
    writeText,
  }
  return { writes, writeText }
}

afterEach(() => {
  delete (window as unknown as { ClipboardItem?: unknown }).ClipboardItem
  delete (navigator as unknown as { clipboard?: unknown }).clipboard
})

describe('rich-clipboard · Safari-robust write', () => {
  it('Safari (no ClipboardItem.supports) copies text/plain + text/html, never text/rtf', async () => {
    const { writes, writeText } = install({ write: async () => {} }) // no supports → Safari-like
    await writeWordClipboardPayload(payload)
    expect(writeText).not.toHaveBeenCalled()
    expect(writes).toHaveLength(1)
    expect([...writes[0]].sort()).toEqual(['text/html', 'text/plain'])
  })

  it('progressive fallback: a browser that claims rtf support but rejects it still gets text/html', async () => {
    const { writes, writeText } = install({
      supports: true,
      write: async (items) => { if ('text/rtf' in items) throw new Error('rejected: text/rtf') },
    })
    await writeWordClipboardPayload(payload)
    expect(writeText).not.toHaveBeenCalled()
    expect(writes[0]).toContain('text/rtf')                       // first attempt had rtf
    expect([...writes[writes.length - 1]].sort()).toEqual(['text/html', 'text/plain']) // retried without it
  })

  it('falls back to writeText only when every rich write fails', async () => {
    const { writeText } = install({ write: async () => { throw new Error('blocked') } })
    await writeWordClipboardPayload(payload)
    expect(writeText).toHaveBeenCalledWith(payload.text)
  })
})
