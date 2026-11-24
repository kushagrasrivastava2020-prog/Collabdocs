import client from 'prom-client'
import type { NextFunction, Request, Response } from 'express'

/** Timings the collaboration layer reports. Decoupled from prom-client so rooms stay testable. */
export interface Telemetry {
  oplogAppend(seconds: number, batchUpdates: number): void
  roomLoad(seconds: number): void
  snapshot(seconds: number): void
}

export const noopTelemetry: Telemetry = { oplogAppend() {}, roomLoad() {}, snapshot() {} }

export interface CounterSource {
  messagesIn: number
  messagesOut: number
  updatesApplied: number
  updatesRejected: number
  opLogAppends: number
  snapshots: number
  busIn: number
  busOut: number
  connectionsTotal: number
  rejectedConnections: number
  rateLimited: number
}

/**
 * Prometheus metrics for one server instance (own registry, so several instances can live in
 * one test process). Counters that the hot path already tracks as plain numbers are exported
 * through collect() callbacks instead of being double-counted.
 */
export function createMetrics(opts: {
  instanceId: string
  defaultMetrics: boolean
  counters: CounterSource
  gauges: () => { rooms: number; connections: number }
}) {
  const register = new client.Registry()
  register.setDefaultLabels({ node: opts.instanceId })
  if (opts.defaultMetrics) client.collectDefaultMetrics({ register })

  const c = opts.counters
  const fromSource = (name: string, help: string, labelName: string, values: () => Record<string, number>) =>
    new client.Counter({
      name,
      help,
      labelNames: [labelName],
      registers: [register],
      collect() {
        this.reset()
        for (const [label, value] of Object.entries(values())) this.inc({ [labelName]: label }, value)
      },
    })

  fromSource('collabdocs_ws_messages_total', 'WebSocket messages by direction', 'direction', () => ({
    in: c.messagesIn,
    out: c.messagesOut,
  }))
  fromSource('collabdocs_updates_total', 'Yjs updates received from clients', 'result', () => ({
    applied: c.updatesApplied,
    rejected: c.updatesRejected,
  }))
  fromSource('collabdocs_bus_messages_total', 'Inter-instance (Redis) messages by direction', 'direction', () => ({
    in: c.busIn,
    out: c.busOut,
  }))
  fromSource('collabdocs_ws_connections_total', 'WebSocket connection attempts by outcome', 'outcome', () => ({
    accepted: c.connectionsTotal,
    rejected: c.rejectedConnections,
    rate_limited: c.rateLimited,
  }))
  fromSource('collabdocs_storage_writes_total', 'Durable writes by kind', 'kind', () => ({
    oplog_append: c.opLogAppends,
    snapshot: c.snapshots,
  }))

  new client.Gauge({
    name: 'collabdocs_ws_connections',
    help: 'Open WebSocket connections',
    registers: [register],
    collect() {
      this.set(opts.gauges().connections)
    },
  })
  new client.Gauge({
    name: 'collabdocs_rooms',
    help: 'Documents loaded in memory on this instance',
    registers: [register],
    collect() {
      this.set(opts.gauges().rooms)
    },
  })

  const oplogAppendSeconds = new client.Histogram({
    name: 'collabdocs_oplog_append_seconds',
    help: 'Latency of one op-log append transaction (seq allocation + insert)',
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [register],
  })
  const oplogBatchUpdates = new client.Histogram({
    name: 'collabdocs_oplog_batch_updates',
    help: 'Client updates merged into one op-log row',
    buckets: [1, 2, 3, 5, 10, 20, 50, 100, 200],
    registers: [register],
  })
  const roomLoadSeconds = new client.Histogram({
    name: 'collabdocs_room_load_seconds',
    help: 'Time to open a room: subscribe + load snapshot and op-log tail',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [register],
  })
  const snapshotSeconds = new client.Histogram({
    name: 'collabdocs_snapshot_seconds',
    help: 'Time to build and store a snapshot',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [register],
  })
  const httpSeconds = new client.Histogram({
    name: 'collabdocs_http_request_seconds',
    help: 'REST API latency',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [register],
  })

  const telemetry: Telemetry = {
    oplogAppend(seconds, batch) {
      oplogAppendSeconds.observe(seconds)
      oplogBatchUpdates.observe(batch)
    },
    roomLoad: (s) => roomLoadSeconds.observe(s),
    snapshot: (s) => snapshotSeconds.observe(s),
  }

  /** Express middleware recording latency per *route pattern* (never raw URLs: bounded cardinality). */
  const httpMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/')) return next()
    const end = httpSeconds.startTimer()
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched'
      end({ method: req.method, route, status: String(res.statusCode) })
    })
    next()
  }

  return { register, telemetry, httpMiddleware }
}
