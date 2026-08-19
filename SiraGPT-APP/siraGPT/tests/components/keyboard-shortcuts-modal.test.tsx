import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import KeyboardShortcutsModal from '@/components/KeyboardShortcutsModal'

// Stub the shadcn Dialog primitives — Radix renders to a portal which is
// awkward to snapshot, and we only care about the descriptive content the
// component itself emits. When `open` is false we render nothing; when
// `open` is true we render the body inline.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children, className }: any) => (
    <div data-testid="dialog-content" className={className}>{children}</div>
  ),
  DialogHeader: ({ children }: any) => <div data-testid="dialog-header">{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
}))

describe('KeyboardShortcutsModal (snapshot)', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <KeyboardShortcutsModal open={false} onOpenChange={() => {}} />,
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders the shortcut list when open', () => {
    const { container } = render(
      <KeyboardShortcutsModal open={true} onOpenChange={() => {}} />,
    )
    expect(container.firstChild).toMatchSnapshot()
  })
})
