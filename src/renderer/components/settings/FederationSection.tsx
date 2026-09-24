/**
 * Federation Section Component
 * Gateway server used to relay team collaboration beyond the local network
 */

import { useState } from 'react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { HaloConfig } from '../../types'

const SUPPORTED_PROTOCOLS = ['http:', 'https:', 'ws:', 'wss:']

interface FederationSectionProps {
  config: HaloConfig | null
  setConfig: (config: HaloConfig) => void
}

export function FederationSection({ config, setConfig }: FederationSectionProps) {
  const { t } = useTranslation()

  const [gatewayInput, setGatewayInput] = useState(config?.federation?.gatewayUrl || '')
  const [gatewayError, setGatewayError] = useState<string | null>(null)
  const [gatewaySaved, setGatewaySaved] = useState(false)

  const handleGatewaySave = async () => {
    const value = gatewayInput.trim()
    if (value) {
      try {
        const u = new URL(value)
        if (!SUPPORTED_PROTOCOLS.includes(u.protocol)) {
          setGatewayError(t('Unsupported protocol. Use http://, https://, ws://, wss://'))
          return
        }
      } catch {
        setGatewayError(t('Invalid gateway URL. Example: https://gateway.example.com'))
        return
      }
    }
    setGatewayError(null)
    try {
      const updatedFederation = { ...config?.federation, gatewayUrl: value || undefined }
      const updatedConfig = { ...config, federation: updatedFederation } as HaloConfig
      await api.setConfig({ federation: updatedFederation })
      setConfig(updatedConfig)
      setGatewaySaved(true)
      setTimeout(() => setGatewaySaved(false), 2000)
    } catch (error) {
      console.error('[FederationSection] Failed to save gateway URL:', error)
      setGatewayError(t('Failed to save'))
    }
  }

  return (
    <section id="federation" className="bg-card rounded-xl border border-border p-6">
      <div className="mb-4">
        <h2 className="text-lg font-medium">{t('Federation Gateway')}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('Relay team collaboration through a gateway server so members outside your local network can join. Leave empty for LAN-only teams.')}
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          value={gatewayInput}
          onChange={(e) => {
            setGatewayInput(e.target.value)
            setGatewayError(null)
          }}
          placeholder={t('https://gateway.example.com')}
          className="flex-1 px-2 py-1 text-sm bg-input rounded border border-border focus:border-primary focus:outline-none"
        />
        <button
          onClick={handleGatewaySave}
          className="text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded hover:bg-primary/90"
        >
          {gatewaySaved ? t('Saved') : t('Save')}
        </button>
      </div>
      {gatewayError && <p className="text-xs text-red-500 mt-2">{gatewayError}</p>}

      {/* An office already hosted without a gateway keeps its LAN-only
          attachment; the relay is picked up the next time it is hosted. */}
      <p className="text-xs text-muted-foreground mt-3">
        {t('Restart Halo after changing this so existing teams pick up the new gateway.')}
      </p>
    </section>
  )
}
