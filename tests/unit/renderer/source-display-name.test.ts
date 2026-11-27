import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/renderer/stores/org-sign-in.store', () => ({ useOrgSignInStore: vi.fn() }))

import { sourceDisplayName } from '../../../src/renderer/hooks/useSourceDisplayName'

describe('sourceDisplayName', () => {
  it('shows an organization account under the sign-in name, and every other under its own', () => {
    expect(sourceDisplayName({ name: 'Halo Cloud', managedBy: 'organization' }, 'Company')).toBe('Company')
    expect(sourceDisplayName({ name: 'Halo Cloud', managedBy: 'organization' }, undefined)).toBe('Halo Cloud')
    expect(sourceDisplayName({ name: 'Halo Cloud' }, 'Company')).toBe('Halo Cloud')
  })
})
