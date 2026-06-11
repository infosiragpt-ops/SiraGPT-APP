import { describe, it, expect } from 'vitest'
import { describeGeoHintStatus } from '@/lib/appshots-geo-hint'

// Task 29 — covers the discreet sub-text the Appshots settings page
// renders when the backend reports `geoHintStatus !== 'ok'`. We test
// the pure helper rather than mounting the whole page because:
//   - the page is a Next.js client component that fetches on mount and
//     would need fetch + CSRF mocking just to render two <li> rows;
//   - the only Task-29-specific UI is this label, so a focused unit
//     test gives us regression coverage without the surface area.
describe('describeGeoHintStatus (Task 29)', () => {
  it('returns null when the lookup succeeded', () => {
    expect(describeGeoHintStatus('ok')).toBeNull()
  })

  it('flags a private/LAN network with an explicit reason', () => {
    const label = describeGeoHintStatus('private')
    expect(label).not.toBeNull()
    expect(label!.toLowerCase()).toContain('red privada')
    expect(label!.toLowerCase()).toContain('no disponible')
  })

  it('reports an unresolved lookup without leaking implementation details', () => {
    const label = describeGeoHintStatus('unresolved')
    expect(label).not.toBeNull()
    expect(label!.toLowerCase()).toContain('no disponible')
    // We deliberately do NOT mention "timeout", "upstream" or the
    // provider name — the user shouldn't have to care.
    expect(label!.toLowerCase()).not.toContain('timeout')
    expect(label!.toLowerCase()).not.toContain('upstream')
  })
})
