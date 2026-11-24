import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import type { Logger } from '../util/log.js'
import { authenticate } from '../auth/index.js'
import { resolveRole } from '../permissions.js'
import type { DocStore } from './persistence.js'
import type { PubSub } from './pubsub.js'
import { Room, abandonRoom, type RoomMetrics } from './room.js'
import { noopTelemetry, type Telemetry } from '../metrics.js'
import {
  BUS_CONTROL,
  CLOSE_FORBIDDEN,
  CLOSE_NOT_FOUND,
  CLOSE_RESTART,
  CLOSE_UNAUTHENTICATED,
  docChannel,
  encodeEnvelope,
  encodeJson,
  type ControlEvent,
} from './protocol.js'

const DOC_PATH = /^\/ws\/([A-Za-z0-9-]{1,64})\/?$/
const HEARTBEAT_MS = 30_000

/**
 * Owns the WebSocket endpoint and the set of rooms loaded on this instance.
 * Rooms are created lazily on first connection and unloaded when idle.
 */
export class CollabServer {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  readonly metrics: RoomMetrics & { connectionsTotal: number; rejectedConnections: number } = {
    messagesIn: 0,
    messagesOut: 0,
    updatesApplied: 0,
    updatesRejected: 0,
    opLogAppends: 0,
    snapshots: 0,
    busIn: 0,
    busOut: 0,
    rateLimited: 0,
    connectionsTotal: 0,
    rejectedConnections: 0,
  }
  private rooms = new Map<string, Promise<Room>>()
  private loaded = new Map<string, Room>()
  private unloading = new Map<string, Promise<void>>()
  private heartbeat: NodeJS.Timeout
  private shuttingDown = false
  telemetry: Telemetry = noopTelemetry

  constructor(private deps: { db: Db; store: DocStore; pubsub: PubSub; config: Config; log: Logger }) {
    this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS)
    this.heartbeat.unref()
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://x')
    const match = DOC_PATH.exec(url.pathname)
    const origin = req.headers.origin
    const { allowedOrigins } = this.deps.config
    if (!match || this.shuttingDown || (origin && allowedOrigins.length && !allowedOrigins.includes(origin))) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => void this.onConnection(ws, req, match[1]!))
  }

  private async onConnection(ws: WebSocket, req: IncomingMessage, docId: string) {
    // The client sends sync step 1 the moment the socket opens; hold messages until the room is ready.
    const early: Uint8Array[] = []
    const buffer = (d: Buffer) => early.push(new Uint8Array(d))
    ws.on('message', buffer)
    ws.on('error', () => ws.terminate())

    try {
      const user = await authenticate(this.deps.db, req, this.deps.config.jwtSecret)
      if (!user) return this.reject(ws, CLOSE_UNAUTHENTICATED, 'unauthenticated')
      const role = await resolveRole(this.deps.db, docId, user.id)
      if (!role) {
        const exists = await this.deps.db.query(`SELECT 1 FROM documents WHERE id = $1`, [docId])
        return this.reject(ws, exists.rows.length ? CLOSE_FORBIDDEN : CLOSE_NOT_FOUND, 'no access')
      }

      const room = await this.getRoom(docId)
      if (ws.readyState !== ws.OPEN) {
        if (room.conns.size === 0) room.scheduleIdle()
        return
      }
      ws.off('message', buffer)
      const conn = room.addConn(ws, { id: user.id, name: user.name, color: user.color }, role)
      this.metrics.connectionsTotal++
      for (const m of early) room.onMessage(conn, m)
    } catch (err) {
      this.deps.log.error('connection setup failed', { doc: docId, err: String(err) })
      ws.close(1011, 'internal error')
    }
  }

  private reject(ws: WebSocket, code: number, reason: string) {
    this.metrics.rejectedConnections++
    ws.close(code, reason)
  }

  /** Get (or load) the room for a document. Waits for any in-progress unload to finish first. */
  async getRoom(docId: string): Promise<Room> {
    for (;;) {
      const unloading = this.unloading.get(docId)
      if (unloading) await unloading
      let p = this.rooms.get(docId)
      if (!p) {
        p = Room.open(docId, {
          ...this.deps,
          metrics: this.metrics,
          telemetry: this.telemetry,
          resolveRole: (d, u) => resolveRole(this.deps.db, d, u),
          onIdle: (room) => void this.unload(room),
        })
        this.rooms.set(docId, p)
        p.then(
          (room) => this.loaded.set(docId, room),
          () => this.rooms.delete(docId),
        )
      }
      const room = await p
      if (!room.closing) return room
    }
  }

  /** Run `fn` against a room (loading it if needed) - used by REST endpoints such as restore. */
  async withRoom<T>(docId: string, fn: (room: Room) => Promise<T>): Promise<T> {
    const room = await this.getRoom(docId)
    try {
      return await fn(room)
    } finally {
      if (room.conns.size === 0) room.scheduleIdle()
    }
  }

  private unload(room: Room) {
    if (this.rooms.get(room.id) === undefined || this.unloading.has(room.id)) return this.unloading.get(room.id)
    this.rooms.delete(room.id)
    this.loaded.delete(room.id)
    const p = room.close({ persist: !room.deleted }).finally(() => this.unloading.delete(room.id))
    this.unloading.set(room.id, p)
    return p
  }

  /**
   * Notify every instance's clients about a change made through the REST API. If the room is
   * not loaded here, publishing on the channel is enough: only instances with clients care.
   */
  async control(docId: string, ev: ControlEvent) {
    const p = this.rooms.get(docId)
    if (p) {
      const room = await p
      await room.control(ev)
    } else {
      const msg = encodeEnvelope(this.deps.config.instanceId, BUS_CONTROL, encodeJson(ev))
      await this.deps.pubsub.publish(docChannel(docId), msg)
    }
  }

  /** Make sure everything buffered for a document is in the op log (used before snapshots). */
  async flush(docId: string) {
    const p = this.rooms.get(docId)
    if (p) await (await p).flush()
  }

  private ping() {
    for (const p of this.rooms.values()) {
      void p.then((room) => {
        for (const c of room.conns) {
          if (!c.alive) {
            c.ws.terminate()
            continue
          }
          c.alive = false
          c.ws.ping()
        }
      })
    }
  }

  /** Synchronous gauges for Prometheus (rooms still loading are not counted). */
  gauges() {
    let rooms = 0
    let connections = 0
    for (const r of this.loaded.values()) {
      rooms++
      connections += r.conns.size
    }
    return { rooms, connections }
  }

  async stats() {
    const rooms = await Promise.all(this.rooms.values())
    return {
      rooms: rooms.length,
      connections: rooms.reduce((n, r) => n + r.conns.size, 0),
      ...this.metrics,
    }
  }

  /** Test hook: die abruptly, losing every unflushed update (see abandonRoom). */
  crash() {
    this.shuttingDown = true
    clearInterval(this.heartbeat)
    for (const room of this.loaded.values()) abandonRoom(room)
    this.rooms.clear()
    this.loaded.clear()
    for (const ws of this.wss.clients) ws.terminate()
    this.wss.close()
  }

  /** Graceful shutdown: tell clients to reconnect elsewhere, then persist and release every room. */
  async close() {
    this.shuttingDown = true
    clearInterval(this.heartbeat)
    const rooms = await Promise.allSettled(this.rooms.values())
    for (const r of rooms) {
      if (r.status !== 'fulfilled') continue
      for (const c of r.value.conns) c.ws.close(CLOSE_RESTART, 'server restarting')
    }
    await Promise.all(rooms.filter((r): r is PromiseFulfilledResult<Room> => r.status === 'fulfilled').map((r) => this.unload(r.value)))
    await Promise.all(this.unloading.values())
    this.wss.close()
  }
}
