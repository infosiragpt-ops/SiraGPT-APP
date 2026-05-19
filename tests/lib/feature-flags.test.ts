import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { flags } from '../../lib/feature-flags'

const ORIGINAL_FLAGS = process.env.NEXT_PUBLIC_FEATURE_FLAGS
const ORIGINAL_GATES = process.env.NEXT_PUBLIC_ROLE_GATED_FLAGS

describe('feature-flags.isEnabledForUser', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_FEATURE_FLAGS
    delete process.env.NEXT_PUBLIC_ROLE_GATED_FLAGS
    try {
      window.localStorage.removeItem('siragpt.featureFlags')
    } catch {
      /* jsdom fallback */
    }
  })

  afterEach(() => {
    if (ORIGINAL_FLAGS == null) delete process.env.NEXT_PUBLIC_FEATURE_FLAGS
    else process.env.NEXT_PUBLIC_FEATURE_FLAGS = ORIGINAL_FLAGS
    if (ORIGINAL_GATES == null) delete process.env.NEXT_PUBLIC_ROLE_GATED_FLAGS
    else process.env.NEXT_PUBLIC_ROLE_GATED_FLAGS = ORIGINAL_GATES
  })

  it('returns false when the flag is not enabled at all', () => {
    expect(flags.isEnabledForUser('experimental-ui', { role: 'admin' })).toBe(false)
  })

  it('returns true when flag is enabled and no role gate is declared', () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAGS = 'experimental-ui'
    expect(flags.isEnabledForUser('experimental-ui', { role: 'viewer' })).toBe(true)
    expect(flags.isEnabledForUser('experimental-ui', null)).toBe(true)
  })

  it('returns true when user role matches the gate (single role)', () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAGS = 'experimental-ui'
    process.env.NEXT_PUBLIC_ROLE_GATED_FLAGS = 'experimental-ui:admin'
    expect(flags.isEnabledForUser('experimental-ui', { role: 'admin' })).toBe(true)
  })

  it('returns false when user role does not match the gate', () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAGS = 'experimental-ui'
    process.env.NEXT_PUBLIC_ROLE_GATED_FLAGS = 'experimental-ui:admin'
    expect(flags.isEnabledForUser('experimental-ui', { role: 'viewer' })).toBe(false)
  })

  it('returns false when user is null and the flag is gated', () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAGS = 'experimental-ui'
    process.env.NEXT_PUBLIC_ROLE_GATED_FLAGS = 'experimental-ui:admin'
    expect(flags.isEnabledForUser('experimental-ui', null)).toBe(false)
    expect(flags.isEnabledForUser('experimental-ui', undefined)).toBe(false)
  })

  it('supports multiple gates and matches on roles[] arrays', () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAGS = 'experimental-ui,beta-export'
    process.env.NEXT_PUBLIC_ROLE_GATED_FLAGS =
      'experimental-ui:admin,beta-export:editor'
    expect(
      flags.isEnabledForUser('beta-export', { roles: ['viewer', 'editor'] }),
    ).toBe(true)
    expect(
      flags.isEnabledForUser('beta-export', { roles: ['viewer'] }),
    ).toBe(false)
    // experimental-ui still admin-only.
    expect(
      flags.isEnabledForUser('experimental-ui', { roles: ['editor'] }),
    ).toBe(false)
  })

  it('matching is case-insensitive on both flag name and role', () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAGS = 'Experimental-UI'
    process.env.NEXT_PUBLIC_ROLE_GATED_FLAGS = 'experimental-ui:Admin'
    expect(
      flags.isEnabledForUser('EXPERIMENTAL-UI', { role: 'ADMIN' }),
    ).toBe(true)
  })

  it('ignores malformed pairs in the gate env without throwing', () => {
    process.env.NEXT_PUBLIC_FEATURE_FLAGS = 'experimental-ui'
    process.env.NEXT_PUBLIC_ROLE_GATED_FLAGS = ',foo,:admin,bar:,experimental-ui:admin'
    expect(flags.isEnabledForUser('experimental-ui', { role: 'admin' })).toBe(true)
    expect(flags.isEnabledForUser('experimental-ui', { role: 'viewer' })).toBe(false)
  })
})
