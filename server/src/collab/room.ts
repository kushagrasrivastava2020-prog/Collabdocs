import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { WebSocket } from 'ws'
import type { Config } from '../config.js'
import type { Logger } from '../util/log.js'
import { can, type Role } from '../permissions.js'
import type { DocStore } from './persistence.js'
import type { PubSub } from './pubsub.js'
import type { Telemetry } from '../metrics.js'
import {
  BUS_AWARENESS,
  BUS_CONTROL,
  BUS_SYNC_REQUEST,
  BUS_UPDATE,
  CLOSE_RATE_LIMITED,
  CLOSE_SLOW_CONSUMER,
  MSG_AWARENESS,
  MSG_CONTROL,
  MSG_QUERY_AWARENESS,
  MSG_SAVED,
  MSG_SYNC,
  decodeEnvelope,
  decodeJson,
  docChannel,
  encodeEnvelope,
  encodeJson,
  encodeMessage,
  type ControlEvent,
} from './protocol.js'

export interface ConnUser {
  id: string
  name: string
  color: string
}

/** One WebSocket connection inside a room. */
export interface Conn {
  readonly ws: WebSocket
  readonly user: ConnUser
  role: Role
  /** Awareness client IDs announced over this connection (removed when it closes). */
  readonly awarenessIds: Set<number>
  /** Updates from this connection waiting to be written to the op log. */
  inflight: number
  alive: boolean
  /** Token bucket for per-connection message rate limiting. */
  tokens: number
  refilledAt: number
}

/** Transaction origins (Yjs passes these through to the 'update' event). */
const LOAD_ORIGIN = Symbol('load')
const REMOTE_ORIGIN = Symbol('remote')
export interface ServerOrigin {
  server: true
  userId: string | null
}
const isConn = (o: unknown): o is Conn => typeof o === 'object' && o !== null && 'ws' in o

export interface RoomMetrics {
  messagesIn: number
  messagesOut: number
  updatesApplied: number
  updatesRejected: number
  opLogAppends: number
  snapshots: number
  busIn: number
  busOut: number
  rateLimited: number
}

export interface RoomDeps {
  store: DocStore
  pubsub: PubSub
  config: Config
  log: Logger
  metrics: RoomMetrics
  telemetry: Telemetry
  /** Re-resolve a user's role (after a sharing change). */
  resolveRole: (docId: string, userId: string) => Promise<Role | null>
  /** Called when the last connection leaves (after roomIdleMs) or the doc is deleted. */
  onIdle: (room: Room) => void
}

const MAX_BATCH = 200
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024
/** Awareness states are tiny (cursor + user); anything bigger is abuse. */
const MAX_AWARENESS_STATE_BYTES = 4096

/**
 * In-memory replica of one document on one server instance.
 *
 * Data flow for a local edit:
 *   client --update--> Room.doc --+--> other local connections           (immediate)
 *                                 +--> Redis channel --> other instances  (immediate)
 *                                 +--> batch buffer --(flushIntervalMs)--> op log --> MSG_SAVED ack
 */
export class Room {
  readonly doc = new Y.Doc()
  readonly awareness = new awarenessProtocol.Awareness(this.doc)
  readonly conns = new Set<Conn>()
  closing = false
  /** Set when the document was deleted: nothing left to persist. */
  deleted = false

  private awarenessOwner = new Map<number, Conn>()
  /** Buffered updates grouped by author: one op-log row per author per flush keeps attribution exact. */
  private pending = new Map<string | null, Uint8Array[]>()
  private pendingCount = 0
  private pendingConns = new Map<Conn, number>()
  private flushTimer: NodeJS.Timeout | null = null
  private flushChain: Promise<void> = Promise.resolve()
  private flushesSinceSnapshot = 0
  private lastSnapshotAt = Date.now()
  private snapshotInFlight: Promise<unknown> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private readonly channel: string

  private constructor(
    readonly id: string,
    private deps: RoomDeps,
  ) {
    this.channel = docChannel(id)
    // The server is not a participant: drop the Awareness instance's own local state.
    this.awareness.setLocalState(null)
    this.doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
  }

  /**
   * Create a room: subscribe to the inter-instance channel *first*, then load from the
   * database, then ask peers for anything they hold that is not yet persisted. Subscribing
   * before loading guarantees no update can fall between "persisted" and "received".
   */
  static async open(id: string, deps: RoomDeps): Promise<Room> {
    const started = performance.now()
    const room = new Room(id, deps)
    await deps.pubsub.subscribe(room.channel, room.onBusMessage)
    await deps.store.load(id, room.doc, LOAD_ORIGIN)
    room.publish(BUS_SYNC_REQUEST, Y.encodeStateVector(room.doc))
    deps.telemetry.roomLoad((performance.now() - started) / 1000)
    return room
  }

  // ---------------------------------------------------------------- connections

  addConn(ws: WebSocket, user: ConnUser, role: Role): Conn {
    const burst = this.deps.config.wsRateLimit * 2
    const conn: Conn = { ws, user, role, awarenessIds: new Set(), inflight: 0, alive: true, tokens: burst, refilledAt: Date.now() }
    this.conns.add(conn)
    this.cancelIdle()

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => this.onMessage(conn, toBytes(data)))
    ws.on('close', () => this.removeConn(conn))
    ws.on('pong', () => (conn.alive = true))

    // Ask the client for anything it has that we don't (e.g. edits made while offline).
    // Read-only clients cannot contribute, so don't bother.
    if (can.edit(role)) {
      this.send(
        conn,
        encodeMessage(MSG_SYNC, (enc) => syncProtocol.writeSyncStep1(enc, this.doc)),
      )
    }
    const states = this.awareness.getStates()
    if (states.size > 0) {
      const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()])
      this.send(
        conn,
        encodeMessage(MSG_AWARENESS, (enc) => encoding.writeVarUint8Array(enc, update)),
      )
    }
    return conn
  }

  private removeConn(conn: Conn) {
    if (!this.conns.delete(conn)) return
    const ids = [...conn.awarenessIds]
    for (const id of ids) this.awarenessOwner.delete(id)
    if (ids.length) awarenessProtocol.removeAwarenessStates(this.awareness, ids, null)
    if (this.conns.size === 0) this.scheduleIdle()
  }

  /** Token bucket: `wsRateLimit` messages/s sustained, bursts of twice that. */
  private allow(conn: Conn): boolean {
    const rate = this.deps.config.wsRateLimit
    if (rate <= 0) return true
    const now = Date.now()
    conn.tokens = Math.min(rate * 2, conn.tokens + ((now - conn.refilledAt) / 1000) * rate)
    conn.refilledAt = now
    if (conn.tokens < 1) return false
    conn.tokens -= 1
    return true
  }

  onMessage(conn: Conn, data: Uint8Array) {
    if (this.closing) return
    this.deps.metrics.messagesIn++
    if (!this.allow(conn)) {
      // A real editor sends a few messages per keystroke at most; this is a runaway or hostile
      // client. 45xx = "try again later": y-websocket reconnects with backoff and resyncs.
      this.deps.metrics.rateLimited++
      conn.ws.close(CLOSE_RATE_LIMITED, 'rate limited')
      return
    }
    try {
      const dec = decoding.createDecoder(data)
      const type = decoding.readVarUint(dec)
      switch (type) {
        case MSG_SYNC: {
          const sub = decoding.readVarUint(dec)
          if (sub === syncProtocol.messageYjsSyncStep1) {
            this.send(
              conn,
              encodeMessage(MSG_SYNC, (enc) => syncProtocol.readSyncStep1(dec, enc, this.doc)),
            )
          } else if (sub === syncProtocol.messageYjsSyncStep2 || sub === syncProtocol.messageYjsUpdate) {
            // Role enforcement happens here, server-side: viewers/commenters can't mutate.
            if (!can.edit(conn.role)) {
              this.deps.metrics.updatesRejected++
              return
            }
            syncProtocol.readSyncStep2(dec, this.doc, conn)
            this.deps.metrics.updatesApplied++
            // Initial sync contributed nothing new: the client is already fully saved.
            if (sub === syncProtocol.messageYjsSyncStep2 && conn.inflight === 0) this.sendSaved(conn)
          }
          break
        }
        case MSG_AWARENESS: {
          const update = this.sanitizeAwareness(conn, decoding.readVarUint8Array(dec))
          if (update) awarenessProtocol.applyAwarenessUpdate(this.awareness, update, conn)
          break
        }
        case MSG_QUERY_AWARENESS: {
          const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...this.awareness.getStates().keys()])
          this.send(
            conn,
            encodeMessage(MSG_AWARENESS, (enc) => encoding.writeVarUint8Array(enc, update)),
          )
          break
        }
        default:
          // Unknown / auth messages from clients are ignored.
          break
      }
    } catch (err) {
      this.deps.log.error('bad message', { doc: this.id, err: String(err) })
      conn.ws.close(1003, 'malformed message')
    }
  }

  /**
   * Awareness payloads are client-controlled JSON. Stamp the authenticated identity onto
   * every state (so nobody can impersonate another user's cursor) and refuse to touch client
   * IDs owned by another connection.
   */
  private sanitizeAwareness(conn: Conn, update: Uint8Array): Uint8Array | null {
    const dec = decoding.createDecoder(update)
    const enc = encoding.createEncoder()
    const len = decoding.readVarUint(dec)
    const entries: Array<[number, number, string]> = []
    for (let i = 0; i < len; i++) {
      const clientId = decoding.readVarUint(dec)
      const clock = decoding.readVarUint(dec)
      const json = decoding.readVarString(dec)
      const owner = this.awarenessOwner.get(clientId)
      if ((owner && owner !== conn) || json.length > MAX_AWARENESS_STATE_BYTES) continue
      let state = JSON.parse(json)
      if (state !== null && typeof state === 'object') {
        state = {
          ...state,
          user: { ...(state.user ?? {}), id: conn.user.id, name: conn.user.name, color: conn.user.color, role: conn.role },
        }
      }
      entries.push([clientId, clock, JSON.stringify(state)])
    }
    if (!entries.length) return null
    encoding.writeVarUint(enc, entries.length)
    for (const [clientId, clock, json] of entries) {
      encoding.writeVarUint(enc, clientId)
      encoding.writeVarUint(enc, clock)
      encoding.writeVarString(enc, json)
    }
    return encoding.toUint8Array(enc)
  }

  // ---------------------------------------------------------------- Yjs + awareness fan-out

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === LOAD_ORIGIN) return
    const msg = encodeMessage(MSG_SYNC, (enc) => syncProtocol.writeUpdate(enc, update))
    for (const c of this.conns) if (c !== origin) this.send(c, msg)
    if (origin === REMOTE_ORIGIN) return
    // Originated on this instance (a client, or the server itself e.g. a version restore):
    // relay to peers and make it durable.
    this.publish(BUS_UPDATE, update)
    this.enqueue(update, origin)
  }

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (isConn(origin)) {
      for (const id of [...added, ...updated]) {
        origin.awarenessIds.add(id)
        this.awarenessOwner.set(id, origin)
      }
      for (const id of removed) {
        origin.awarenessIds.delete(id)
        this.awarenessOwner.delete(id)
      }
    }
    const changed = [...added, ...updated, ...removed]
    if (!changed.length) return
    const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)
    // Broadcast to everyone, including the sender: the echo doubles as a keep-alive for
    // y-websocket's "no message in 30s" watchdog.
    const msg = encodeMessage(MSG_AWARENESS, (enc) => encoding.writeVarUint8Array(enc, update))
    for (const c of this.conns) this.send(c, msg)
    if (origin !== REMOTE_ORIGIN && origin !== 'timeout') this.publish(BUS_AWARENESS, update)
  }

  // ---------------------------------------------------------------- inter-instance bus

  private publish(kind: number, payload: Uint8Array) {
    this.deps.metrics.busOut++
    this.deps.pubsub
      .publish(this.channel, encodeEnvelope(this.deps.config.instanceId, kind, payload))
      .catch((err) => this.deps.log.error('publish failed', { doc: this.id, err: String(err) }))
  }

  private onBusMessage = (raw: Uint8Array) => {
    if (this.closing) return
    let env
    try {
      env = decodeEnvelope(raw)
    } catch {
      return
    }
    if (env.origin === this.deps.config.instanceId) return
    this.deps.metrics.busIn++
    switch (env.kind) {
      case BUS_UPDATE:
        Y.applyUpdate(this.doc, env.payload, REMOTE_ORIGIN)
        break
      case BUS_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, env.payload, REMOTE_ORIGIN)
        break
      case BUS_SYNC_REQUEST: {
        // A peer just opened this room. Send whatever it lacks plus our clients' presence.
        const diff = Y.encodeStateAsUpdate(this.doc, env.payload)
        this.publish(BUS_UPDATE, diff)
        const local = [...this.awarenessOwner.keys()]
        if (local.length) this.publish(BUS_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, local))
        break
      }
      case BUS_CONTROL:
        void this.handleControl(decodeJson<ControlEvent>(env.payload))
        break
    }
  }

  /** Publish a control event to every instance (including this one). */
  control(ev: ControlEvent) {
    this.publish(BUS_CONTROL, encodeJson(ev))
    return this.handleControl(ev)
  }

  async handleControl(ev: ControlEvent) {
    if (ev.type === 'access') {
      // Sharing changed: re-check affected connections, kick anyone who lost access.
      const affected = [...this.conns].filter((c) => !ev.userId || c.user.id === ev.userId)
      for (const c of affected) {
        const role = await this.deps.resolveRole(this.id, c.user.id)
        if (!role) {
          c.ws.close(4403, 'access revoked')
        } else if (role !== c.role) {
          const couldEdit = can.edit(c.role)
          c.role = role
          if (!couldEdit && can.edit(role)) {
            this.send(
              c,
              encodeMessage(MSG_SYNC, (enc) => syncProtocol.writeSyncStep1(enc, this.doc)),
            )
          }
          this.sendControl(c, ev)
        }
      }
      return
    }
    if (ev.type === 'deleted') {
      this.deleted = true
      this.pending.clear()
      this.pendingCount = 0
      for (const c of this.conns) c.ws.close(4404, 'document deleted')
      this.deps.onIdle(this)
      return
    }
    for (const c of this.conns) this.sendControl(c, ev)
  }

  private sendControl(conn: Conn, ev: ControlEvent) {
    this.send(
      conn,
      encodeMessage(MSG_CONTROL, (enc) => encoding.writeVarString(enc, JSON.stringify(ev))),
    )
  }

  // ---------------------------------------------------------------- persistence

  private enqueue(update: Uint8Array, origin: unknown) {
    let author: string | null
    if (isConn(origin)) {
      origin.inflight++
      this.pendingConns.set(origin, (this.pendingConns.get(origin) ?? 0) + 1)
      author = origin.user.id
    } else {
      author = (origin as ServerOrigin | null)?.userId ?? null
    }
    const list = this.pending.get(author)
    if (list) list.push(update)
    else this.pending.set(author, [update])
    this.pendingCount++
    if (this.pendingCount >= MAX_BATCH) void this.flush()
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), this.deps.config.flushIntervalMs)
  }

  /** Write buffered updates to the op log. Calls are serialised per room. */
  flush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.doFlush())
    return this.flushChain
  }

  private async doFlush() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.pendingCount) return

    const batches = this.pending
    const conns = this.pendingConns
    this.pending = new Map()
    this.pendingCount = 0
    this.pendingConns = new Map()
    // Everything in this state vector that originated here is covered by this batch.
    const sv = Y.encodeStateVector(this.doc)

    const remaining = [...batches]
    try {
      while (remaining.length) {
        const [author, updates] = remaining[0]!
        const merged = updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates)
        const started = performance.now()
        await this.deps.store.append(this.id, merged, author)
        this.deps.telemetry.oplogAppend((performance.now() - started) / 1000, updates.length)
        this.deps.metrics.opLogAppends++
        remaining.shift()
      }
    } catch (err) {
      // Put the unwritten part back and retry; clients still hold the data, so nothing is lost
      // meanwhile (and re-appending an already-written update would be harmless anyway).
      this.deps.log.error('op log append failed, will retry', { doc: this.id, err: String(err) })
      for (const [author, updates] of remaining) {
        this.pending.set(author, [...updates, ...(this.pending.get(author) ?? [])])
        this.pendingCount += updates.length
      }
      for (const [c, n] of conns) this.pendingConns.set(c, (this.pendingConns.get(c) ?? 0) + n)
      if (!this.closing) this.flushTimer = setTimeout(() => void this.flush(), 1000)
      return
    }

    const ack = encodeMessage(MSG_SAVED, (enc) => encoding.writeVarUint8Array(enc, sv))
    for (const [c, n] of conns) {
      c.inflight -= n
      this.send(c, ack)
    }

    this.flushesSinceSnapshot++
    const due =
      this.flushesSinceSnapshot >= this.deps.config.snapshotEveryFlushes ||
      Date.now() - this.lastSnapshotAt >= this.deps.config.snapshotIntervalMs
    if (due && !this.snapshotInFlight) void this.snapshot()
  }

  /** Take an automatic snapshot (built from the database, see DocStore.snapshot). */
  snapshot() {
    this.flushesSinceSnapshot = 0
    this.lastSnapshotAt = Date.now()
    const started = performance.now()
    this.snapshotInFlight = this.deps.store
      .snapshot(this.id, { kind: 'auto' })
      .then((v) => {
        if (v) {
          this.deps.telemetry.snapshot((performance.now() - started) / 1000)
          this.deps.metrics.snapshots++
          void this.control({ type: 'versions' })
        }
      })
      .catch((err) => this.deps.log.error('snapshot failed', { doc: this.id, err: String(err) }))
      .finally(() => (this.snapshotInFlight = null))
    return this.snapshotInFlight
  }

  private sendSaved(conn: Conn) {
    const sv = Y.encodeStateVector(this.doc)
    this.send(
      conn,
      encodeMessage(MSG_SAVED, (enc) => encoding.writeVarUint8Array(enc, sv)),
    )
  }

  /**
   * Restore an old version as a *new* forward edit: replace the live content with a copy of
   * the old content. History is preserved and connected clients converge as for any edit.
   */
  async restore(state: Uint8Array, userId: string) {
    const old = new Y.Doc()
    try {
      Y.applyUpdate(old, state)
      const src = old.getXmlFragment('default')
      const dst = this.doc.getXmlFragment('default')
      const origin: ServerOrigin = { server: true, userId }
      this.doc.transact(() => {
        dst.delete(0, dst.length)
        dst.insert(
          0,
          src.toArray().map((n) => (n as Y.XmlElement | Y.XmlText).clone()),
        )
      }, origin)
    } finally {
      old.destroy()
    }
    await this.flush()
  }

  // ---------------------------------------------------------------- lifecycle

  private send(conn: Conn, msg: Uint8Array) {
    const ws = conn.ws
    if (ws.readyState !== ws.OPEN) return
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Slow consumer: drop it rather than buffer unboundedly. It will reconnect and resync.
      ws.close(CLOSE_SLOW_CONSUMER, 'slow consumer')
      return
    }
    this.deps.metrics.messagesOut++
    ws.send(msg, (err) => {
      if (err) ws.terminate()
    })
  }

  scheduleIdle() {
    this.cancelIdle()
    this.idleTimer = setTimeout(() => {
      if (this.conns.size === 0) this.deps.onIdle(this)
    }, this.deps.config.roomIdleMs)
  }

  private cancelIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private abandon() {
    this.closing = true
    this.cancelIdle()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.pending.clear()
    this.pendingCount = 0
    this.doc.off('update', this.onDocUpdate)
    for (const c of this.conns) c.ws.terminate()
    void this.deps.pubsub.unsubscribe(this.channel).catch(() => {})
    this.awareness.off('update', this.onAwarenessUpdate)
    this.awareness.destroy()
    this.doc.destroy()
  }

  /**
   * Flush, reconcile and release. Reconciliation is a small anti-entropy step: if this replica
   * holds anything the op log lacks (e.g. updates relayed from an instance that crashed before
   * its flush), append the difference. Duplicates are harmless because Yjs updates are idempotent.
   */
  async close({ persist = true } = {}) {
    if (this.closing) return
    this.closing = true
    this.cancelIdle()
    this.doc.off('update', this.onDocUpdate)
    try {
      if (persist) {
        await this.flush()
        await this.snapshotInFlight
        const { doc: stored } = await this.deps.store.load(this.id)
        try {
          if (!Y.equalSnapshots(Y.snapshot(this.doc), Y.snapshot(stored))) {
            const diff = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(stored))
            await this.deps.store.append(this.id, diff, null)
          }
        } finally {
          stored.destroy()
        }
        const v = await this.deps.store.snapshot(this.id, { kind: 'auto' })
        if (v) this.deps.metrics.snapshots++
      }
    } catch (err) {
      this.deps.log.error('room close persistence failed', { doc: this.id, err: String(err) })
    } finally {
      await this.deps.pubsub.unsubscribe(this.channel).catch(() => {})
      this.awareness.off('update', this.onAwarenessUpdate)
      this.awareness.destroy()
      this.doc.destroy()
    }
  }
}

/**
 * Simulate the process dying (`kill -9`): sockets drop, buffered updates that were never flushed
 * are lost, nothing is persisted. Only used by tests to prove recovery doesn't depend on graceful
 * shutdown.
 */
export function abandonRoom(room: Room) {
  ;(room as unknown as { abandon(): void }).abandon()
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
