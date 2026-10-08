/**
 * The `ws` library never reads proxy environment variables, so a containerized
 * WeCom bot must be handed an explicit agent or its WebSocket escapes the
 * egress path the platform provides — invisible until a proxied deployment
 * cannot connect. Desktop deliberately keeps connecting directly.
 *
 * These tests pin that split and the wiring it introduces: the agent is
 * resolved once per start() and reaches the SDK as `wsOptions.agent`,
 * reconnects reuse it, a resolution failure degrades to a direct connection,
 * and a reconnect racing the resolution leaves exactly one live client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('../../../../../src/main/services/notification.service', () => ({
  notifyAppEvent: vi.fn(),
}))

const fakeAgent = { marker: 'proxy-agent' }
const resolveProxyAgentMock = vi.fn(async (_url: string) => ({ agent: fakeAgent, endpoint: 'http://10.107.100.64:9090' }))
vi.mock('../../../../../src/main/services/proxy-fetch', () => ({
  resolveProxyAgent: (url: string) => resolveProxyAgentMock(url),
}))

interface FakeWSClient extends EventEmitter {
  opts: { wsUrl?: string; wsOptions?: { agent?: unknown } }
  isConnected: boolean
  disconnectCount: number
  connect(): void
  disconnect(): void
}

vi.mock('@wecom/aibot-node-sdk', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events')
  const registry: FakeWSClient[] = []

  class WSClient extends EE {
    isConnected = false
    disconnectCount = 0
    opts: unknown
    sendMessage = vi.fn(async () => undefined)

    constructor(opts: unknown) {
      super()
      this.opts = opts
      registry.push(this as unknown as FakeWSClient)
    }

    connect(): void {}
    disconnect(): void {
      this.disconnectCount++
      this.isConnected = false
    }
  }

  return { default: { WSClient }, __registry: registry }
})

import { WecomBotProvider } from '../../../../../src/main/apps/runtime/im-channels/wecom-bot.provider'
import * as sdk from '@wecom/aibot-node-sdk'

const createdClients = (sdk as unknown as { __registry: FakeWSClient[] }).__registry

interface InstanceWithInternals {
  start(): void
  stop(): void
  reconnect(): void
}

function makeInstance(): InstanceWithInternals {
  const provider = new WecomBotProvider()
  return provider.createInstance('inst-proxy', {
    botId: 'aib-test',
    secret: 'shh',
  }) as unknown as InstanceWithInternals
}

/** The client is only constructed after proxy resolution settles. */
async function startAndConnect(inst: InstanceWithInternals): Promise<FakeWSClient> {
  inst.start()
  for (let i = 0; i < 5; i++) await Promise.resolve()
  return createdClients[createdClients.length - 1]
}

describe('WeCom bot WS proxy wiring', () => {
  beforeEach(() => {
    process.env.HALO_SERVER_MODE = '1'
    createdClients.length = 0
    resolveProxyAgentMock.mockClear()
    resolveProxyAgentMock.mockResolvedValue({ agent: fakeAgent, endpoint: 'http://10.107.100.64:9090' })
    vi.useFakeTimers()
  })

  afterEach(() => {
    delete process.env.HALO_SERVER_MODE
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('passes the resolved agent to the SDK, resolved against the WS url', async () => {
    const client = await startAndConnect(makeInstance())
    expect(resolveProxyAgentMock).toHaveBeenCalledWith('wss://openws.work.weixin.qq.com')
    expect(client.opts.wsOptions?.agent).toBe(fakeAgent)
  })

  it('reuses the agent across reconnects without re-resolving', async () => {
    const inst = makeInstance()
    await startAndConnect(inst)
    inst.reconnect()
    expect(resolveProxyAgentMock).toHaveBeenCalledTimes(1)
    expect(createdClients[createdClients.length - 1].opts.wsOptions?.agent).toBe(fakeAgent)
  })

  it('connects directly when no proxy applies', async () => {
    resolveProxyAgentMock.mockResolvedValue(null as never)
    const client = await startAndConnect(makeInstance())
    expect(client.opts.wsOptions).toBeUndefined()
  })

  it('falls back to a direct connection when resolution throws', async () => {
    resolveProxyAgentMock.mockRejectedValue(new Error('session unavailable') as never)
    const client = await startAndConnect(makeInstance())
    expect(client).toBeDefined()
    expect(client.opts.wsOptions).toBeUndefined()
  })

  it('does not open a client when stop() races the resolution', async () => {
    const inst = makeInstance()
    inst.start()
    inst.stop()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(createdClients.length).toBe(0)
  })

  it('disconnects the unproxied client a reconnect opened during resolution', async () => {
    const inst = makeInstance()
    inst.start()
    inst.reconnect()
    const raced = createdClients[createdClients.length - 1]
    expect(raced.opts.wsOptions).toBeUndefined()

    for (let i = 0; i < 5; i++) await Promise.resolve()

    // The raced client would otherwise auto-reconnect forever alongside the
    // proxied one, feeding WeCom's newest-connection-wins supersede storm.
    expect(raced.disconnectCount).toBe(1)
    const current = createdClients[createdClients.length - 1]
    expect(current).not.toBe(raced)
    expect(current.opts.wsOptions?.agent).toBe(fakeAgent)
  })

  it('skips proxy resolution entirely on desktop', () => {
    delete process.env.HALO_SERVER_MODE
    makeInstance().start()
    expect(resolveProxyAgentMock).not.toHaveBeenCalled()
    expect(createdClients).toHaveLength(1)
    expect(createdClients[0].opts.wsOptions).toBeUndefined()
  })
})
