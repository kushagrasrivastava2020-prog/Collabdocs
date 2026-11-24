// One load-generator thread: owns a slice of the simulated clients.
import { parentPort, workerData } from 'node:worker_threads'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import * as Y from 'yjs'
import { connectDoc, sleep } from './lib.mjs'

const { clients, wsBase, total, startAt, rampMs, t0, t1, drainUntil, rate, awarenessEvery } = workerData
const now = () => performance.timeOrigin + performance.now()

const connectMs = []
const syncMs = []
const latencies = []
const resyncMs = []
const sentByDoc = {}
const recvByDoc = {}
const connectedByDoc = {}
let connected = 0
let failed = 0
let disconnects = 0
let sent = 0
const live = []

const elu0 = performance.eventLoopUtilization()
const lag = monitorEventLoopDelay({ resolution: 10 })
lag.enable()

async function runClient({ idx, docId, token }) {
  await sleep(Math.max(0, startAt + (idx / total) * rampMs - Date.now()))
  const started = now()
  let opened = 0
  const c = connectDoc({
    wsBase,
    docId,
    token,
    user: { name: `lt-${idx}` },
    reconnect: true,
    onDisconnect: () => disconnects++,
    onResync: (ms) => resyncMs.push(ms),
  })
  c.ws.once('open', () => (opened = now()))
  c.ready.catch(() => {})
  try {
    await Promise.race([c.ready, sleep(15_000).then(() => Promise.reject(new Error('connect timeout')))])
  } catch {
    failed++
    c.close()
    return
  }
  connected++
  connectedByDoc[docId] = (connectedByDoc[docId] ?? 0) + 1
  connectMs.push(opened - started)
  syncMs.push(now() - opened)

  // Probes: each writer appends [sentAtMs] to its own Y.Array inside the 'probes' map. Array
  // deltas report exactly which items are new, even when a reconnect delivers many at once, so
  // every write is counted once per receiver.
  const probes = c.doc.getMap('probes')
  const record = (ts, t) => {
    if (ts < t0 || ts > t1 || t > drainUntil) return
    latencies.push(t - ts)
    recvByDoc[docId] = (recvByDoc[docId] ?? 0) + 1
  }
  probes.observeDeep((events, tr) => {
    if (tr.local) return
    const t = now()
    for (const e of events) {
      if (e.target === probes) {
        // A writer's array appeared (possibly already holding items): count everything in it.
        for (const key of e.keysChanged) {
          if (Number(key) === idx) continue
          const arr = probes.get(key)
          if (arr instanceof Y.Array) for (const ts of arr.toArray()) record(ts, t)
        }
      } else if (Number(e.path[0]) !== idx) {
        for (const d of e.changes.delta) if (d.insert) for (const ts of d.insert) record(ts, t)
      }
    }
  })
  live.push({ c, docId })

  // Edit loop: type a word into our own paragraph + append a probe, `rate` times per second.
  // Edits keep happening while disconnected (like a user typing through a network blip);
  // they are delivered by the resync after failover.
  await sleep(Math.max(0, t0 - Date.now()) + Math.random() * (1000 / rate))
  let para = null
  let mine = null
  let lastAwareness = 0
  while (now() < t1 && !c.destroyed) {
    const ts = now()
    c.doc.transact(() => {
      if (!para) {
        const frag = c.doc.getXmlFragment('default')
        para = new Y.XmlElement('paragraph')
        para.insert(0, [new Y.XmlText(`client ${idx}: `)])
        frag.insert(frag.length, [para])
        mine = new Y.Array()
        probes.set(String(idx), mine)
      }
      const text = para.get(0)
      text.insert(text.length, `w${sent % 100} `)
      mine.push([ts])
    })
    sent++
    sentByDoc[docId] = (sentByDoc[docId] ?? 0) + 1
    if (awarenessEvery > 0 && ts - lastAwareness > awarenessEvery * 1000) {
      lastAwareness = ts
      c.awareness.setLocalStateField('cursor', { anchor: Math.floor(Math.random() * 100), head: 0 })
    }
    await sleep(1000 / rate)
  }
}

await Promise.all(clients.map(runClient))
await sleep(Math.max(0, drainUntil - Date.now()))

// Final state per replica: state vector + delete-set size identifies the CRDT state.
const finalStates = live.map(({ c, docId }) => ({
  docId,
  connected: c.connected,
  state: Buffer.from(Y.encodeStateVector(c.doc)).toString('base64') + ':' + Y.snapshot(c.doc).ds.clients.size,
}))
const reconnects = live.reduce((n, { c }) => n + c.reconnects, 0)
const elu = performance.eventLoopUtilization(elu0).utilization
lag.disable()
const lagMs = { p50: lag.percentile(50) / 1e6, p99: lag.percentile(99) / 1e6, max: lag.max / 1e6 }
for (const { c } of live) c.close()

parentPort.postMessage({
  connected,
  failed,
  disconnects,
  reconnects,
  resyncMs,
  sent,
  connectMs,
  syncMs,
  latencies: Float64Array.from(latencies),
  sentByDoc,
  recvByDoc,
  connectedByDoc,
  finalStates,
  elu,
  lagMs,
})
