import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import esMessages from '../../../messages/es.json'

function IntlWrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="es" messages={esMessages as any}>
      {children}
    </NextIntlClientProvider>
  )
}

/**
 * renderWithIntl — wraps the UI under test in the Spanish (`es`) intl provider so
 * codex components calling `useTranslations('codex')` find their context. Spanish
 * is the source language, so assertions on Spanish text keep passing unchanged.
 *
 * Uses the RTL `wrapper` option so the returned `rerender` re-applies the provider
 * automatically (needed by tests that rerender, e.g. WebTab url null → set).
 */
export function renderWithIntl(ui: React.ReactElement) {
  return render(ui, { wrapper: IntlWrapper })
}

export { screen, fireEvent }
