import http from 'node:http'
import fs from 'node:fs'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import cookieParser from 'cookie-parser'
import { ZodError } from 'zod'
import type { Config } from './config.js'
import { createDb, type Db } from './db/index.js'
import { DocStore } from './collab/persistence.js'
import { CollabServer } from './collab/server.js'
import { MemoryPubSub, RedisPubSub, type PubSub } from './collab/pubsub.js'
import { authRouter } from './routes/auth.js'
import { documentsRouter, shareRouter } from './routes/documents.js'
import { HttpError } from './util/http.js'
import { createLogger } from './util/log.js'
import { createMetrics } from './metrics.js'
import type { Ctx } from './context.js'

export interface App {
  server: http.Server
  app: express.Express
  ctx: Ctx
  pubsub: PubSub
  /** Start listening; resolves with the bound port. */
  listen(port?: number, host?: string): Promise<number>
  /** Graceful shutdown: drain WebSockets, persist rooms, close DB / Redis. */
  close(): Promise<void>
  /** Test hook: stop like a killed process (no flush, no persistence, sockets dropped). */
  crash(): void
}

export async function createApp(config: Config, opts: { db?: Db; pubsub?: PubSub } = {}): Promise<App> {
  const log = createLogger(config)
  const ownsDb = !opts.db
  const db = opts.db ?? (await createDb(config))
  const pubsub = opts.pubsub ?? (config.redisUrl ? new RedisPubSub(config.redisUrl) : new MemoryPubSub())
  const store = new DocStore(db)
  const collab = new CollabServer({ db, store, pubsub, config, log })
  const ctx: Ctx = { config, db, store, collab, log }
  const metrics = createMetrics({
    instanceId: config.instanceId,
    defaultMetrics: config.processMetrics,
    counters: collab.metrics,
    gauges: () => collab.gauges(),
  })
  collab.telemetry = metrics.telemetry

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use((req, res, next) => {
    res.setHeader('X-Instance-Id', config.instanceId)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    if (config.clientDist && !req.path.startsWith('/api/')) {
      // Strict CSP for the SPA: no inline/3rd-party scripts. Inline *styles* are needed for
      // ProseMirror/caret colours. WebSockets only to this same host.
      const host = req.headers.host ?? ''
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https:",
          `connect-src 'self' ws://${host} wss://${host}`,
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join('; '),
      )
    }
    next()
  })
  app.use(metrics.httpMiddleware)

  app.get('/api/health', async (_req, res) => {
    await db.query('SELECT 1')
    res.json({ ok: true, instance: config.instanceId, db: db.kind, pubsub: config.redisUrl ? 'redis' : 'memory' })
  })
  // Event-loop health since the previous /api/metrics call: tells you whether an instance is saturated.
  const loopDelay = monitorEventLoopDelay({ resolution: 10 })
  loopDelay.enable()
  let eluMark = performance.eventLoopUtilization()
  app.get('/api/metrics', async (_req, res) => {
    const elu = performance.eventLoopUtilization(eluMark)
    eluMark = performance.eventLoopUtilization()
    const ms = (ns: number) => Math.round(ns / 1e4) / 100
    const eventLoop = {
      utilization: Math.round(elu.utilization * 100) / 100,
      delayP50Ms: ms(loopDelay.percentile(50)),
      delayP99Ms: ms(loopDelay.percentile(99)),
      delayMaxMs: ms(loopDelay.max),
    }
    loopDelay.reset()
    res.json({
      instance: config.instanceId,
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1e6),
      eventLoop,
      ...(await collab.stats()),
    })
  })
  // Prometheus scrape endpoint (per instance).
  app.get('/metrics', async (_req, res) => {
    res.type(metrics.register.contentType).send(await metrics.register.metrics())
  })
  app.use('/api/auth', authRouter(ctx))
  app.use('/api/docs', documentsRouter(ctx))
  app.use('/api/share', shareRouter(ctx))
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found', 'not_found')))

  // Production single-container mode: serve the built SPA.
  if (config.clientDist && fs.existsSync(config.clientDist)) {
    const dist = path.resolve(config.clientDist)
    app.use(express.static(dist, { index: false, maxAge: '1h' }))
    app.get(/^(?!\/api|\/ws|\/metrics).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      const first = err.issues[0]
      return res
        .status(400)
        .json({ error: first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input', code: 'validation' })
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code })
    if (err instanceof SyntaxError && 'body' in (err as object)) return res.status(400).json({ error: 'Malformed JSON', code: 'bad_json' })
    log.error('unhandled error', { err: err instanceof Error ? err.stack : String(err) })
    res.status(500).json({ error: 'Internal server error', code: 'internal' })
  })

  const server = http.createServer(app)
  server.on('upgrade', (req, socket, head) => collab.handleUpgrade(req, socket, head))

  return {
    server,
    app,
    ctx,
    pubsub,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve((server.address() as import('node:net').AddressInfo).port))
      })
    },
    async close() {
      loopDelay.disable()
      await collab.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      if (!opts.pubsub) await pubsub.close()
      if (ownsDb) await db.close()
    },
    crash() {
      loopDelay.disable()
      collab.crash()
      server.closeAllConnections()
      server.close()
    },
  }
}
