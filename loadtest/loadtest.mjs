#!/usr/bin/env node
/**
 * CollabDocs load generator.
 *
 * Simulates N concurrent editors spread over D documents, connected through the load balancer
 * (so peers of one document land on different server instances). Every client edits at a fixed
 * rate; each edit carries a timestamped probe, and every *other* client in the document records
 * how long it took to arrive -> true end-to-end latency (client -> LB -> instance -> Redis ->
 * instance -> LB -> client). Clients are spread across worker threads so the generator itself
 * isn't the bottleneck (its event-loop utilisation is reported so you can tell).
 *
 * After the run it checks:
 *   - convergence: every replica of a document ends in the identical CRDT state
 *   - durability:  after all clients leave and rooms unload, a fresh client loads that same
 *                  state from Postgres
 *
 *   node loadtest.mjs --url http://localhost:8080 --clients 500 --docs 25 --duration 60
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { exec } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as Y from 'yjs'
import { api, connectDoc, sleep } from './lib.mjs'

const args = process.argv.slice(2)
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : d
}
const cfg = {
  url: opt('url', 'http://localhost:8080'),
  clients: Number(opt('clients', 500)),
  docs: Number(opt('docs', 25)),
  users: Number(opt('users', 50)),
  duration: Number(opt('duration', 60)),
  ramp: Number(opt('ramp', 20)),
  rate: Number(opt('rate', 1)),
  awarenessEvery: Number(opt('awareness-every', 5)),
  workers: Number(opt('workers', Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2))))),
  metrics: (opt('metrics', '') || '').split(',').filter(Boolean),
  unloadWait: Number(opt('unload-wait', 15)),
  drain: Number(opt('drain', 5)),
  // Chaos: shell commands run at given offsets (seconds) into the measurement window,
  // e.g. --chaos-cmd "docker kill collabdocs-app2-1" --chaos-at 20
  chaosCmd: opt('chaos-cmd', ''),
  chaosAt: Number(opt('chaos-at', 20)),
  recoverCmd: opt('recover-cmd', ''),
  recoverAt: Number(opt('recover-at', 40)),
  label: opt('label', ''),
  out: opt('out', ''),
}
cfg.wsBase = cfg.url.replace(/^http/, 'ws') + '/ws'

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)

function pct(sorted, p) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}
function summarize(values) {
  const s = Float64Array.from(values).sort()
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null
  const r = (v) => (v == null ? null : Math.round(v * 10) / 10)
  return {
    samples: s.length,
    mean: r(mean),
    p50: r(pct(s, 50)),
    p90: r(pct(s, 90)),
    p95: r(pct(s, 95)),
    p99: r(pct(s, 99)),
    max: r(s[s.length - 1] ?? null),
  }
}

async function pool(items, concurrency, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    }),
  )
  return out
}

async function serverMetrics() {
  return Promise.all(cfg.metrics.map((u) => api(u, '/api/metrics').catch((e) => ({ error: String(e) }))))
}

// ------------------------------------------------------------------ setup
log(`config: ${JSON.stringify({ ...cfg, wsBase: undefined })}`)
const owner = await api(cfg.url, '/api/auth/guest', { method: 'POST' })
const docs = await pool(
  Array.from({ length: cfg.docs }, (_, i) => i),
  10,
  async (i) => {
    const { document } = await api(cfg.url, '/api/docs', { method: 'POST', token: owner.token, body: { title: `Load test ${i + 1}` } })
    const { link } = await api(cfg.url, `/api/docs/${document.id}/links`, { method: 'POST', token: owner.token, body: { role: 'editor' } })
    return { id: document.id, link: link.token }
  },
)
const users = await pool(
  Array.from({ length: Math.min(cfg.users, cfg.clients) }, (_, i) => i),
  10,
  () => api(cfg.url, '/api/auth/guest', { method: 'POST' }),
)
const assignments = Array.from({ length: cfg.clients }, (_, i) => ({ idx: i, doc: docs[i % docs.length], user: users[i % users.length] }))
const pairs = new Map()
for (const a of assignments) pairs.set(`${a.user.user.id}:${a.doc.id}`, a)
await pool([...pairs.values()], 25, (a) => api(cfg.url, `/api/share/${a.doc.link}/accept`, { method: 'POST', token: a.user.token }))
log(`setup: ${docs.length} docs, ${users.length} users, ${pairs.size} memberships`)

const before = await serverMetrics()

// ------------------------------------------------------------------ run
const startAt = Date.now() + 1000
const t0 = startAt + cfg.ramp * 1000 + 3000 // measurement window starts after ramp + warmup
const t1 = t0 + cfg.duration * 1000
const drainUntil = t1 + cfg.drain * 1000

const chaosEvents = []
const runAt = (offsetSec, cmd, what) => {
  if (!cmd) return
  setTimeout(
    () => {
      const at = Math.round((Date.now() - t0) / 100) / 10
      log(`CHAOS ${what}: ${cmd}`)
      exec(cmd, (err, stdout, stderr) =>
        chaosEvents.push({ what, cmd, atSec: at, ok: !err, output: (stdout || stderr || String(err ?? '')).trim().slice(0, 200) }),
      )
    },
    t0 - Date.now() + offsetSec * 1000,
  )
}
runAt(cfg.chaosAt, cfg.chaosCmd, 'fault')
runAt(cfg.recoverAt, cfg.recoverCmd, 'recover')

const workerFile = fileURLToPath(new URL('./worker.mjs', import.meta.url))
const slices = Array.from({ length: cfg.workers }, () => [])
assignments.forEach((a, i) => slices[i % cfg.workers].push({ idx: a.idx, docId: a.doc.id, token: a.user.token }))

// Sample server metrics at the start and end of the measurement window. /api/metrics reports
// event-loop stats since its previous call, so the end sample covers exactly the window.
let midMetrics = null
setTimeout(() => void serverMetrics(), t0 - Date.now())
setTimeout(async () => (midMetrics = await serverMetrics()), t1 - Date.now())

log(`ramping ${cfg.clients} clients over ${cfg.ramp}s on ${cfg.workers} workers, measuring for ${cfg.duration}s…`)
const progress = setInterval(() => {
  const now = Date.now()
  const phase = now < t0 ? 'ramp/warmup' : now < t1 ? `measuring ${Math.round((now - t0) / 1000)}/${cfg.duration}s` : 'draining'
  log(phase)
}, 10_000)

const results = await Promise.all(
  slices.map(
    (clients) =>
      new Promise((resolve, reject) => {
        const w = new Worker(workerFile, {
          workerData: {
            clients,
            wsBase: cfg.wsBase,
            total: cfg.clients,
            startAt,
            rampMs: cfg.ramp * 1000,
            t0,
            t1,
            drainUntil,
            rate: cfg.rate,
            awarenessEvery: cfg.awarenessEvery,
          },
        })
        w.once('message', resolve)
        w.once('error', reject)
      }),
  ),
)
clearInterval(progress)
const after = await serverMetrics()

// ------------------------------------------------------------------ aggregate
const all = (k) => results.flatMap((r) => r[k])
const sum = (k) => results.reduce((n, r) => n + r[k], 0)
const latency = summarize(results.flatMap((r) => Array.from(r.latencies)))
const sentByDoc = new Map()
const recvByDoc = new Map()
const clientsByDoc = new Map()
for (const r of results) {
  for (const [d, n] of Object.entries(r.sentByDoc)) sentByDoc.set(d, (sentByDoc.get(d) ?? 0) + n)
  for (const [d, n] of Object.entries(r.recvByDoc)) recvByDoc.set(d, (recvByDoc.get(d) ?? 0) + n)
  for (const [d, n] of Object.entries(r.connectedByDoc)) clientsByDoc.set(d, (clientsByDoc.get(d) ?? 0) + n)
}
let expected = 0
let received = 0
for (const [d, sent] of sentByDoc) {
  expected += sent * Math.max(0, (clientsByDoc.get(d) ?? 1) - 1)
  received += recvByDoc.get(d) ?? 0
}

// Convergence: every replica of a document reported the same final state vector + delete set.
const finals = new Map()
for (const r of results) for (const f of r.finalStates) finals.set(f.docId, [...(finals.get(f.docId) ?? []), f.state])
let converged = 0
for (const states of finals.values()) if (new Set(states).size === 1) converged++

// Durability: wait for rooms to unload (snapshot + op log), then load each doc fresh from the DB.
log(`waiting ${cfg.unloadWait}s for rooms to unload, then verifying durability…`)
await sleep(cfg.unloadWait * 1000)
let durable = 0
await pool(docs, 5, async (d) => {
  const c = connectDoc({ wsBase: cfg.wsBase, docId: d.id, token: owner.token })
  try {
    await c.ready
    const fresh = Buffer.from(Y.encodeStateVector(c.doc)).toString('base64') + ':' + Y.snapshot(c.doc).ds.clients.size
    const expectedState = finals.get(d.id)?.[0]
    if (expectedState === fresh) durable++
  } finally {
    c.close()
  }
})

const diff = (a, b) => {
  if (!a || !b || a.error || b.error) return null
  const keys = ['messagesIn', 'messagesOut', 'updatesApplied', 'opLogAppends', 'snapshots', 'busIn', 'busOut', 'connectionsTotal']
  return Object.fromEntries(keys.map((k) => [k, (b[k] ?? 0) - (a[k] ?? 0)]))
}

const summary = {
  label: cfg.label,
  at: new Date().toISOString(),
  config: {
    clients: cfg.clients,
    docs: cfg.docs,
    clientsPerDoc: cfg.clients / cfg.docs,
    users: users.length,
    editRatePerClient: cfg.rate,
    durationSec: cfg.duration,
    rampSec: cfg.ramp,
    workers: cfg.workers,
    url: cfg.url,
  },
  host: {
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model,
    memGb: Math.round(os.totalmem() / 1e9),
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
  },
  connections: {
    attempted: cfg.clients,
    connected: sum('connected'),
    failed: sum('failed'),
    droppedByServer: sum('disconnects'),
    connectMs: summarize(all('connectMs')),
    syncMs: summarize(all('syncMs')),
  },
  edits: { sent: sum('sent'), perSecond: Math.round(sum('sent') / cfg.duration) },
  delivery: { expected, received, ratio: expected ? Math.round((received / expected) * 10000) / 100 : null },
  latencyMs: latency,
  failover: cfg.chaosCmd
    ? {
        events: chaosEvents,
        disconnects: sum('disconnects'),
        reconnectsResynced: sum('reconnects'),
        // From socket drop to fully resynced (backoff + LB retry + sync handshake).
        resyncMs: summarize(all('resyncMs')),
        replicasOnlineAtEnd: results.reduce((n, r) => n + r.finalStates.filter((f) => f.connected).length, 0),
      }
    : undefined,
  convergence: { docs: finals.size, converged },
  durability: { docs: docs.length, matchedAfterReload: durable },
  generator: {
    eventLoopUtilization: results.map((r) => Math.round(r.elu * 100) / 100),
    eventLoopDelayP99Ms: results.map((r) => Math.round(r.lagMs.p99)),
  },
  servers: cfg.metrics.map((u, i) => ({
    url: u,
    instance: after[i]?.instance,
    peakConnections: midMetrics?.[i]?.connections ?? null,
    peakRooms: midMetrics?.[i]?.rooms ?? null,
    memoryMbMid: midMetrics?.[i]?.memoryMb ?? null,
    eventLoopMid: midMetrics?.[i]?.eventLoop ?? null,
    delta: diff(before[i], after[i]),
  })),
}

console.log('\n' + JSON.stringify(summary, null, 2))
if (cfg.out) {
  fs.mkdirSync(path.dirname(cfg.out), { recursive: true })
  fs.writeFileSync(cfg.out, JSON.stringify(summary, null, 2))
  log(`wrote ${cfg.out}`)
}
process.exit(0)
