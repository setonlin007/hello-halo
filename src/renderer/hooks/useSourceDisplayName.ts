import { useEffect } from 'react'
import { useOrgSignInStore } from '../stores/org-sign-in.store'
import type { AISource } from '../types'

type NamedSource = Pick<AISource, 'name' | 'managedBy'>

/** An account that comes with the organization sign-in is shown under the sign-in's name. */
export function sourceDisplayName(source: NamedSource, signInName: string | undefined): string {
  return source.managedBy === 'organization' && signInName ? signInName : source.name
}

/** Names AI accounts as people see them in lists and pickers. */
export function useSourceDisplayName(): (source: NamedSource) => string {
  const start = useOrgSignInStore(s => s.start)
  const signInName = useOrgSignInStore(s => s.state?.name)
  useEffect(() => start(), [start])
  return source => sourceDisplayName(source, signInName)
}
