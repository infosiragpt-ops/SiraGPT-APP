import { describe, it, expect, vi } from 'vitest'
import { renderWithIntl as render, screen, fireEvent } from '../lib/codex/intl-test-utils'
import { Composer } from '@/components/codex/composer'

function type(text: string) {
  fireEvent.change(screen.getByPlaceholderText('Make, test, iterate...'), { target: { value: text } })
}

describe('Composer', () => {
  it('sends the prompt with default tier (eco) and planOnly false', () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    type('haz una landing')
    fireEvent.click(screen.getByLabelText('Enviar'))
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toMatchObject({ prompt: 'haz una landing', planOnly: false, tier: 'eco' })
  })

  it('the Plan toggle forces planOnly on the sent payload', () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    type('x')
    fireEvent.click(screen.getByText('Plan'))
    fireEvent.click(screen.getByLabelText('Enviar'))
    expect(onSend.mock.calls[0][0].planOnly).toBe(true)
  })

  it('the selected Power tier travels in the payload', () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    type('x')
    // Open the Power dropdown (button shows the current tier label "Eco") and pick "Power".
    fireEvent.click(screen.getByText('Eco'))
    fireEvent.click(screen.getByText('Power'))
    fireEvent.click(screen.getByLabelText('Enviar'))
    expect(onSend.mock.calls[0][0].tier).toBe('power')
  })

  it('shows Stop and calls onStop while a run is active (not onSend)', () => {
    const onSend = vi.fn()
    const onStop = vi.fn()
    render(<Composer onSend={onSend} onStop={onStop} active />)
    const btn = screen.getByLabelText('Detener')
    fireEvent.click(btn)
    expect(onStop).toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('Enter submits, Shift+Enter does not', () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    const ta = screen.getByPlaceholderText('Make, test, iterate...')
    fireEvent.change(ta, { target: { value: 'go' } })
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('does not send an empty prompt with no attachments', () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    fireEvent.click(screen.getByLabelText('Enviar'))
    expect(onSend).not.toHaveBeenCalled()
  })
})
