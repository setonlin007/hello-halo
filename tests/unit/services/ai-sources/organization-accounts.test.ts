import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OrgSignInState } from '../../../../src/shared/types/enterprise-identity'

const manager = vi.hoisted(() => ({
  signInOrganizationAccounts: vi.fn(async () => {}),
  signOutOrganizationAccounts: vi.fn(async () => {}),
}))
vi.mock('../../../../src/main/services/ai-sources/manager', () => ({ getAISourceManager: () => manager }))

function state(status: OrgSignInState['status'], capability: 'ready' | 'expired' = 'ready'): OrgSignInState {
  return {
    status, capabilities: [{ id: 'model', status: capability }] as never,
    boundTools: [], signingIn: false, canUnbindDevice: false,
  }
}

async function follower() {
  vi.resetModules()
  return (await import('../../../../src/main/services/ai-sources/organization-accounts')).followOrganizationSignIn
}

describe('followOrganizationSignIn', () => {
  beforeEach(() => {
    manager.signInOrganizationAccounts.mockClear()
    manager.signOutOrganizationAccounts.mockClear()
  })

  it('signs the missing accounts in once a restored sign-in is ready, and only once', async () => {
    const follow = await follower()
    follow(state('loading'))
    follow(state('restoring'))
    follow(state('active'))
    follow(state('active'))
    expect(manager.signInOrganizationAccounts.mock.calls).toEqual([[false]])
    expect(manager.signOutOrganizationAccounts).not.toHaveBeenCalled()
  })

  it('signs every account out when the sign-in ends, and in again for the next one', async () => {
    const follow = await follower()
    follow(state('active'))
    follow(state('signed-out'))
    follow(state('signed-out'))
    follow(state('active'))
    expect(manager.signOutOrganizationAccounts).toHaveBeenCalledTimes(1)
    expect(manager.signInOrganizationAccounts.mock.calls).toEqual([[false], [true]])
  })

  it('renews every account when a lapsed sign-in is ready again', async () => {
    const follow = await follower()
    follow(state('active'))
    follow(state('active', 'expired'))
    follow(state('active'))
    expect(manager.signInOrganizationAccounts.mock.calls).toEqual([[false], [true]])
  })

  it('signs every account out when a lapsed sign-in ends', async () => {
    const follow = await follower()
    follow(state('active'))
    follow(state('active', 'expired'))
    follow(state('signed-out'))
    expect(manager.signOutOrganizationAccounts).toHaveBeenCalledTimes(1)
  })

  it('clears accounts an earlier run left signed in when it starts signed out', async () => {
    const follow = await follower()
    follow(state('unavailable'))
    follow(state('signed-out'))
    expect(manager.signOutOrganizationAccounts).toHaveBeenCalledTimes(1)
    expect(manager.signInOrganizationAccounts).not.toHaveBeenCalled()
  })
})
