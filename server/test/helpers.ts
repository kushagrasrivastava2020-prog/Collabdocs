import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WebSocket from 'ws'
import * as decoding from 'lib0/decoding'
import { createApp, type App } from '../src/app.js'
import { loadConfig, type Config } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import { MemoryBus, MemoryPubSub, RedisPubSub, type PubSub } from '../src/collab/pubsub.js'
import { MSG_CONTROL, MSG_SAVED } from '../src/collab/protocol.js'

let counter = 0

export interface TestServer {
  app: App
  base: string
  ws: string
  close(): Promise<void>
}

export async function memoryDb(): Promise<Db> {
  return createDb(process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL, pgliteDir: '' } : { pgliteDir: 'memory://' })
}

/** Pub/sub for multi-instance tests: real Redis when REDIS_URL is set (CI), else an in-process bus. */
export function clusterPubSub(bus: MemoryBus): PubSub {
  return process.env.REDIS_URL ? new RedisPubSub(process.env.REDIS_URL) : new MemoryPubSub(bus)
}

export async function startServer(overrides: Partial<Config> = {}, opts: { db?: Db; pubsub?: PubSub } = {}): Promise<TestServer> {
  const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv, {
    pgliteDir: 'memory://',
    databaseUrl: process.env.DATABASE_URL,
    logLevel: 'silent',
    flushIntervalMs: 10,
    roomIdleMs: 150,
    // Tests hammer the server far faster than a human; the rate limiter has its own test.
    wsRateLimit: 0,
    processMetrics: false,
    instanceId: `test-${process.pid}-${++counter}`,
    ...overrides,
  })
  const ownDb = opts.db ? null : await memoryDb()
  const app = await createApp(config, { db: opts.db ?? ownDb!, pubsub: opts.pubsub })
  const port = await app.listen(0, '127.0.0.1')
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}/ws`,
    close: async () => {
      await app.close()
      await ownDb?.close()
    },
  }
}

export interface ApiResult<T = any> {
  status: number
  body: T
}

export function client(base: string, token?: string) {
  const call = async <T = any>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let parsed: any = text
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      /* binary or plain text */
    }
    return { status: res.status, body: parsed }
  }
  return {
    get: <T = any>(p: string) => call<T>('GET', p),
    post: <T = any>(p: string, b?: unknown) => call<T>('POST', p, b ?? {}),
    patch: <T = any>(p: string, b?: unknown) => call<T>('PATCH', p, b ?? {}),
    del: <T = any>(p: string) => call<T>('DELETE', p),
  }
}

export async function newUser(base: string, name = `user${++counter}`) {
  const res = await client(base).post('/api/auth/signup', {
    email: `${name}-${Date.now()}-${counter}@test.dev`,
    name,
    password: 'password123',
  })
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`)
  return { token: res.body.token as string, user: res.body.user, api: client(base, res.body.token) }
}

export async function newDoc(api: ReturnType<typeof client>, title = 'Test doc') {
  const res = await api.post('/api/docs', { title })
  if (res.status !== 201) throw new Error(`create doc failed: ${JSON.stringify(res.body)}`)
  return res.body.document.id as string
}

/** A real y-websocket client, exactly what the browser uses (minus the editor). */
export function connect(wsBase: string, docId: string, token: string, doc = new Y.Doc()) {
  const provider = new WebsocketProvider(wsBase, docId, doc, {
    params: { token },
    WebSocketPolyfill: WebSocket as any,
    disableBc: true,
  })
  const saved: Uint8Array[] = []
  const controls: any[] = []
  provider.messageHandlers[MSG_SAVED] = (_enc, dec) => {
    saved.push(decoding.readVarUint8Array(dec))
  }
  provider.messageHandlers[MSG_CONTROL] = (_enc, dec) => {
    controls.push(JSON.parse(decoding.readVarString(dec)))
  }
  const closes: Array<{ code: number; reason: string }> = []
  provider.on('connection-close', (ev: any) => {
    if (ev) closes.push({ code: ev.code, reason: ev.reason })
  })
  return { doc, provider, saved, controls, closes, destroy: () => provider.destroy() }
}

export const synced = (p: WebsocketProvider) =>
  p.synced ? Promise.resolve() : new Promise<void>((resolve) => p.once('sync', (s: boolean) => s && resolve()))

/** True once the server has acknowledged persisting every local edit of this client. */
export function isSaved(c: { doc: Y.Doc; saved: Uint8Array[] }): boolean {
  const last = c.saved[c.saved.length - 1]
  if (!last) return false
  const acked = Y.decodeStateVector(last)
  const local = Y.decodeStateVector(Y.encodeStateVector(c.doc))
  return [...local].every(([client, clock]) => (acked.get(client) ?? 0) >= clock)
}

/** Poll until `fn` returns truthy (or throw after `timeout` ms). */
export async function until<T>(fn: () => T | Promise<T>, timeout = 5000, label = 'condition'): Promise<NonNullable<T>> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Append a paragraph to the ProseMirror-shaped fragment TipTap uses. */
export function addParagraph(doc: Y.Doc, text: string) {
  const frag = doc.getXmlFragment('default')
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText(text)])
  frag.insert(frag.length, [p])
}

/** Plain text of the fragment, one line per block. */
export function textOf(doc: Y.Doc): string {
  return doc
    .getXmlFragment('default')
    .toArray()
    .map((n) =>
      n instanceof Y.XmlElement
        ? n
            .toArray()
            .map((c) => (c instanceof Y.XmlText ? c.toString() : ''))
            .join('')
        : '',
    )
    .join('\n')
}

export { MemoryBus }
