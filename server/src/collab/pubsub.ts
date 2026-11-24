import { Redis } from 'ioredis'

/**
 * Minimal pub/sub abstraction used to fan document traffic out between server instances.
 * - RedisPubSub: production / multi-instance.
 * - MemoryPubSub: single process. Several server instances can share one MemoryBus in tests
 *   to simulate a cluster without a Redis server.
 */
export interface PubSub {
  subscribe(channel: string, handler: (msg: Uint8Array) => void): Promise<void>
  unsubscribe(channel: string): Promise<void>
  publish(channel: string, msg: Uint8Array): Promise<void>
  close(): Promise<void>
}

export class MemoryBus {
  private channels = new Map<string, Set<(msg: Uint8Array) => void>>()

  on(channel: string, h: (msg: Uint8Array) => void) {
    let set = this.channels.get(channel)
    if (!set) this.channels.set(channel, (set = new Set()))
    set.add(h)
  }

  off(channel: string, h: (msg: Uint8Array) => void) {
    this.channels.get(channel)?.delete(h)
  }

  emit(channel: string, msg: Uint8Array) {
    // Deliver asynchronously, like a real broker would.
    for (const h of this.channels.get(channel) ?? []) setImmediate(() => h(msg))
  }
}

export class MemoryPubSub implements PubSub {
  private handlers = new Map<string, (msg: Uint8Array) => void>()
  constructor(private bus: MemoryBus = new MemoryBus()) {}

  async subscribe(channel: string, handler: (msg: Uint8Array) => void) {
    this.handlers.set(channel, handler)
    this.bus.on(channel, handler)
  }

  async unsubscribe(channel: string) {
    const h = this.handlers.get(channel)
    if (h) this.bus.off(channel, h)
    this.handlers.delete(channel)
  }

  async publish(channel: string, msg: Uint8Array) {
    this.bus.emit(channel, msg)
  }

  async close() {
    for (const ch of [...this.handlers.keys()]) await this.unsubscribe(ch)
  }
}

export class RedisPubSub implements PubSub {
  private pub: Redis
  private sub: Redis
  private handlers = new Map<string, (msg: Uint8Array) => void>()

  constructor(url: string) {
    this.pub = new Redis(url, { maxRetriesPerRequest: null })
    this.sub = new Redis(url, { maxRetriesPerRequest: null })
    this.sub.on('messageBuffer', (channel: Buffer, message: Buffer) => {
      this.handlers.get(channel.toString())?.(new Uint8Array(message.buffer, message.byteOffset, message.byteLength))
    })
  }

  async subscribe(channel: string, handler: (msg: Uint8Array) => void) {
    this.handlers.set(channel, handler)
    await this.sub.subscribe(channel)
  }

  async unsubscribe(channel: string) {
    this.handlers.delete(channel)
    await this.sub.unsubscribe(channel)
  }

  async publish(channel: string, msg: Uint8Array) {
    await this.pub.publish(channel, Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength))
  }

  async ping() {
    return this.pub.ping()
  }

  async close() {
    this.sub.disconnect()
    this.pub.disconnect()
  }
}
