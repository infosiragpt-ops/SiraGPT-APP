import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { LoginButton } from '@/components/AuthNavButtons'

describe('LoginButton', () => {
  it('keeps a native href so the login route works before hydration', () => {
    render(<LoginButton href="/auth/login" />)

    const login = screen.getByRole('link', { name: /login/i })
    expect(login).toHaveAttribute('href', '/auth/login')
  })

  it('starts navigation from the first touch/pointer activation instead of waiting for a later click', () => {
    const navigate = vi.fn()
    render(<LoginButton href="/auth/login" navigate={navigate} />)

    const login = screen.getByRole('link', { name: /login/i })
    fireEvent.pointerDown(login, {
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
    })

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/auth/login')
  })

  it('ignores repeated taps once navigation is already in flight', () => {
    const navigate = vi.fn()
    render(<LoginButton href="/auth/login" navigate={navigate} />)

    const login = screen.getByRole('link', { name: /login/i })
    fireEvent.pointerDown(login, { pointerType: 'touch', isPrimary: true, button: 0 })
    fireEvent.pointerDown(login, { pointerType: 'touch', isPrimary: true, button: 0 })
    fireEvent.click(login)

    expect(navigate).toHaveBeenCalledTimes(1)
  })
})
