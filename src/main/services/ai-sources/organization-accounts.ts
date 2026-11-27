import type { OrgSignInState } from '../../../shared/types/enterprise-identity'
import { getAISourceManager } from './manager'

let ready = false
let signedOut = false
let settled = false

/**
 * Keeps the accounts that come with the organization sign-in in step with it:
 * signed in in the background once it is ready, signed out once it ends.
 * Loading, restoring and unavailable states change nothing.
 */
export function followOrganizationSignIn(state: OrgSignInState): void {
  if (state.status === 'signed-out') {
    // The first settled state also clears accounts left signed in by an earlier run.
    if (!signedOut) {
      getAISourceManager().signOutOrganizationAccounts().catch(error => {
        console.warn('[OrganizationAccounts] Sign-out of organization accounts failed', error)
      })
    }
    ready = false
    signedOut = true
    settled = true
    return
  }
  if (state.status !== 'active') return
  const now = state.capabilities.some(capability => capability.status === 'ready')
  // A sign-in after an earlier one lapsed may be someone else's, so every account signs in again.
  if (now && !ready) {
    getAISourceManager().signInOrganizationAccounts(settled).catch(error => {
      console.warn('[OrganizationAccounts] Sign-in of organization accounts failed', error)
    })
  }
  ready = now
  signedOut = false
  settled = true
}
