import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'
import { MemoryBus, clusterPubSub, memoryDb, newDoc, newUser, sleep, startServer, until, type TestServer } from './helpers.js'

/**
 * Property: no matter how edits interleave, how the network partitions, or which instance dies,
 * every replica ends up identical AND the database holds exactly that state.
 *
 * Each seed drives a random schedule against a 3-node cluster (shared DB + pub/sub):
 *   concurrent inserts / deletes / formatting / new paragraphs from 5 clients,
 *   clients dropping offline and coming back, clients failing over to another node,
 *   and one node killed (no graceful shutdown) while it holds unflushed writes.
 */

// Small, fast, seedable PRNG (mulberry32) so any failure is reproducible from its seed.
function prng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)]!,
  }
}

interface Replica {
  doc: Y.Doc
  provider: WebsocketProvider
  node: number
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'crdt', 'yjs', 'merge', 'sync', 'node', 'edit', '🙂', 'ü']

function connect(node: TestServer, docId: string, token: string, doc: Y.Doc) {
  return new WebsocketProvider(node.ws, docId, doc, {
    params: { token },
    WebSocketPolyfill: WebSocket as any,
    disableBc: true,
    maxBackoffTime: 200,
  })
}

const fingerprint = (doc: Y.Doc) => doc.getXmlFragment('default').toString()

async function runSchedule(seed: number, steps: number) {
  const r = prng(seed)
  const db = await memoryDb()
  const bus = new MemoryBus()
  // Node 2 batches for 5 s, so when it is killed it is guaranteed to hold unpersisted edits.
  const nodes = await Promise.all(
    [20, 20, 5000].map((flushIntervalMs) => startServer({ flushIntervalMs, roomIdleMs: 100 }, { db, pubsub: clusterPubSub(bus) })),
  )
  const alive = new Set([0, 1, 2])
  const owner = await newUser(nodes[0]!.base)
  const docId = await newDoc(owner.api)
  const replicas: Replica[] = Array.from({ length: 5 }, (_, i) => {
    const doc = new Y.Doc()
    return { doc, node: i % 3, provider: connect(nodes[i % 3]!, docId, owner.token, doc) }
  })
  const crashAt = Math.floor(steps * (0.4 + r.next() * 0.3))
  const stats = { inserts: 0, deletes: 0, formats: 0, paragraphs: 0, partitions: 0, failovers: 0, crashes: 0 }

  const failover = (rep: Replica) => {
    rep.provider.destroy()
    rep.node = r.pick([...alive].filter((n) => n !== rep.node).length ? [...alive].filter((n) => n !== rep.node) : [...alive])
    rep.provider = connect(nodes[rep.node]!, docId, owner.token, rep.doc)
  }

  for (let step = 0; step < steps; step++) {
    if (step === crashAt) {
      // kill -9 the slow-flushing node, then every client on it fails over (as the LB would route them).
      nodes[2]!.app.crash()
      alive.delete(2)
      stats.crashes++
      for (const rep of replicas) if (rep.node === 2) failover(rep)
      continue
    }
    const rep = r.pick(replicas)
    const frag = rep.doc.getXmlFragment('default')
    const roll = r.next()
    if (roll < 0.08) {
      if (rep.provider.shouldConnect) rep.provider.disconnect()
      else rep.provider.connect()
      stats.partitions++
    } else if (roll < 0.11) {
      failover(rep)
      stats.failovers++
    } else if (roll < 0.22 || frag.length === 0) {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText(r.pick(WORDS))])
      frag.insert(r.int(frag.length + 1), [p])
      stats.paragraphs++
    } else {
      const para = frag.get(r.int(frag.length)) as Y.XmlElement
      const text = para.get(0) as Y.XmlText | undefined
      if (!text) continue
      if (roll < 0.7 || text.length === 0) {
        text.insert(r.int(text.length + 1), `${r.pick(WORDS)} `)
        stats.inserts++
      } else if (roll < 0.9) {
        const at = r.int(text.length)
        text.delete(at, 1 + r.int(Math.min(6, text.length - at)))
        stats.deletes++
      } else {
        const at = r.int(text.length)
        text.format(at, 1 + r.int(text.length - at), r.next() < 0.5 ? { bold: {} } : { italic: {} })
        stats.formats++
      }
    }
    if (r.next() < 0.3) await sleep(r.int(8)) // let some messages cross the network mid-schedule
  }

  // Heal: everyone back online, wait for every replica to converge.
  for (const rep of replicas) if (!rep.provider.shouldConnect) rep.provider.connect()
  await until(
    () => replicas.every((rep) => rep.provider.synced) && new Set(replicas.map((rep) => fingerprint(rep.doc))).size === 1,
    15_000,
    `convergence (seed ${seed})`,
  )
  const final = fingerprint(replicas[0]!.doc)
  const finalSv = Buffer.from(Y.encodeStateVector(replicas[0]!.doc)).toString('base64')
  for (const rep of replicas) expect(Buffer.from(Y.encodeStateVector(rep.doc)).toString('base64')).toBe(finalSv)

  // Everyone leaves; rooms unload (flush + anti-entropy + snapshot). The DB must hold it all,
  // including edits that only ever existed in the killed node's unflushed buffer.
  for (const rep of replicas) rep.provider.destroy()
  const persisted = await until(
    async () => {
      const { doc } = await nodes[0]!.app.ctx.store.load(docId)
      const fp = fingerprint(doc)
      doc.destroy()
      return fp === final ? fp : null
    },
    15_000,
    `durable state (seed ${seed})`,
  )
  expect(persisted).toBe(final)

  for (const i of alive) await nodes[i]!.close()
  for (const n of nodes) await n.app.pubsub.close()
  await db.close()
  return { stats, length: final.length }
}

describe('convergence fuzzing (partitions, failover, node crash)', () => {
  for (const seed of [1, 7, 42, 1337]) {
    it(`seed ${seed}: all replicas and the database converge`, async () => {
      const { stats } = await runSchedule(seed, 220)
      // Sanity: the schedule actually exercised the interesting paths.
      expect(stats.crashes).toBe(1)
      expect(stats.inserts + stats.deletes + stats.formats + stats.paragraphs).toBeGreaterThan(150)
      expect(stats.partitions + stats.failovers).toBeGreaterThan(5)
    }, 60_000)
  }
})
