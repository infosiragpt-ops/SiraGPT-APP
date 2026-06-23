import { describe, expect, it } from 'vitest'

import { buildPublishingConsoleState, derivePublishingConfig } from '@/lib/publishing-console'

describe('publishing console state', () => {
  it('derives Replit and custom domains from deployment env', () => {
    const config = derivePublishingConfig({
      NEXT_PUBLIC_APP_NAME: 'SiraGPT',
      NEXT_PUBLIC_URL: 'https://siragpt.com',
      REPLIT_APP_URL: 'https://siragpt.replit.app',
      REPL_OWNER: 'kk',
      PRISMA_DATABASE_URL: 'postgresql://user@localhost:5432/siragpt',
      NEXT_PUBLIC_API_URL: '/api',
    })

    const state = buildPublishingConsoleState(
      config,
      { status: 'healthy', backendStatus: 'healthy', backendHost: 'localhost:5050' },
      new Date('2026-06-22T22:41:00.000Z'),
    )

    expect(state.appName).toBe('siragpt')
    expect(state.ownerName).toBe('kk')
    expect(state.productionUrl).toBe('https://siragpt.com')
    expect(state.domains.map((domain) => domain.host)).toEqual(['siragpt.replit.app', 'siragpt.com'])
    expect(state.seoRating).toBe('HEALTHY')
    expect(state.logs.some((entry) => entry.severity === 'error')).toBe(false)
  })

  it('surfaces unhealthy backend state in the Replit-style logs', () => {
    const config = derivePublishingConfig({
      NEXT_PUBLIC_URL: 'https://siragpt.com',
      REPLIT_APP_URL: 'https://siragpt.replit.app',
    })

    const state = buildPublishingConsoleState(
      config,
      { status: 'unhealthy', backendHost: 'localhost:5050' },
      new Date('2026-06-22T22:41:00.000Z'),
    )

    expect(state.seoRating).toBe('NEEDS REVIEW')
    expect(state.logs.filter((entry) => entry.severity === 'error').length).toBeGreaterThan(0)
  })
})
