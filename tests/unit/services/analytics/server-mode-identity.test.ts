/**
 * Server mode attributes telemetry to the platform's function id (the container
 * hostname) instead of the per-install UUID on disk, so a report can be traced
 * back to a deployment. The watermarks in the same record must survive that
 * substitution — losing them re-sends already-forwarded automation runs.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { hostname } from 'os'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { AnalyticsConfig } from '../../../../src/main/services/analytics/types'

// The real module imports BrowserWindow from electron, which resolves to the
// native binding (a path string under ELECTRON_RUN_AS_NODE) because vitest does
// not apply the electron mock inside externalized dependencies.
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { analytics } from '../../../../src/main/services/analytics/analytics.service'

function loadConfig(): AnalyticsConfig {
  return (analytics as unknown as { loadOrCreateConfig(): AnalyticsConfig }).loadOrCreateConfig()
}

function seedConfig(analyticsConfig: AnalyticsConfig): void {
  const configPath = join(globalThis.__HALO_TEST_DIR__, '.halo', 'config.json')
  writeFileSync(configPath, JSON.stringify({ analytics: analyticsConfig }), 'utf-8')
}

describe('AnalyticsService identity resolution', () => {
  afterEach(() => {
    delete process.env.HALO_SERVER_MODE
  })

  it('uses the hostname as userId in server mode', () => {
    seedConfig({ userId: 'disk-uuid-0001', lastVersion: '0.9.0' })
    process.env.HALO_SERVER_MODE = '1'

    const config = loadConfig()

    expect(config.userId).toBe(hostname())
    expect(config.lastVersion).toBe('1.0.0-test')
  })

  it('keeps the snapshot watermarks when overriding userId', () => {
    seedConfig({
      userId: 'disk-uuid-0001',
      lastVersion: '0.9.0',
      lastSnapshotRunId: 'run-42',
      lastSnapshotTs: 1_700_000_000_000
    })
    process.env.HALO_SERVER_MODE = '1'

    const config = loadConfig()

    expect(config.lastSnapshotRunId).toBe('run-42')
    expect(config.lastSnapshotTs).toBe(1_700_000_000_000)
  })

  it('keeps the persisted userId on the desktop', () => {
    seedConfig({ userId: 'disk-uuid-0001', lastVersion: '0.9.0' })

    expect(loadConfig().userId).toBe('disk-uuid-0001')
  })
})
