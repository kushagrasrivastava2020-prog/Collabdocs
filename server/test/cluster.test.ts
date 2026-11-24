import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryBus } from '../src/collab/pubsub.js'
import type { Db } from '../src/db/index.js'
import {
  addParagraph,
  clusterPubSub,
  connect,
  memoryDb,
  newDoc,
  newUser,
  sleep,
  startServer,
  synced,
  textOf,
  until,
  type TestServer,
} from './helpers.js'

/**
 * Several server instances sharing one database and one pub/sub bus - the same topology as
 * the docker-compose cluster (Redis is used instead of the in-process bus when REDIS_URL is set).
 */
describe('multi-instance cluster', () => {
  let db: Db
  let bus: MemoryBus
  let nodes: TestServer[]

  beforeAll(async () => {
    db = await memoryDb()
    bus = new MemoryBus()
    nodes = await Promise.all([0, 1, 2].map(() => startServer({}, { db, pubsub: clusterPubSub(bus) })))
  })
  afterAll(async () => {
    for (const n of nodes) {
      await n.close()
      await n.app.pubsub.close()
    }
    await db.close()
  })

  it('relays edits and presence between clients on different instances', async () => {
    const owner = await newUser(nodes[0]!.base)
    const id = await newDoc(owner.api)
    const clients = nodes.map((n) => connect(n.ws, id, owner.token))
    await Promise.all(clients.map((c) => synced(c.provider)))

    clients.forEach((c, i) => addParagraph(c.doc, `from node ${i}`))
    await until(() => clients.every((c) => textOf(c.doc).split('\n').length === 3), 5000, 'all edits everywhere')
    const texts = clients.map((c) => textOf(c.doc))
    expect(new Set(texts).size).toBe(1)

    clients[0]!.provider.awareness.setLocalStateField('cursor', { anchor: 0, head: 0 })
    await until(() => clients[2]!.provider.awareness.getStates().has(clients[0]!.doc.clientID), 5000, 'cross-node presence')

    // Each edit is persisted exactly once (by the instance that received it), not once per node.
    await sleep(100)
    const stats = await nodes[0]!.app.ctx.store.stats(id)
    expect(stats.updates).toBe(3)
    clients.forEach((c) => c.destroy())
  })

  it('a node that opens a room late receives not-yet-persisted updates from its peers', async () => {
    // Node "slow" buffers for 10s, so its edits are only in memory when node[1] opens the room.
    const slow = await startServer({ flushIntervalMs: 10_000 }, { db, pubsub: clusterPubSub(bus) })
    try {
      const owner = await newUser(slow.base)
      const id = await newDoc(owner.api)
      const a = connect(slow.ws, id, owner.token)
      await synced(a.provider)
      addParagraph(a.doc, 'only in memory')
      await sleep(50)
      expect((await slow.app.ctx.store.stats(id)).updates).toBe(0)

      const b = connect(nodes[1]!.ws, id, owner.token)
      await synced(b.provider)
      await until(() => textOf(b.doc) === 'only in memory', 5000, 'peer sync on room open')
      a.destroy()
      b.destroy()
    } finally {
      await slow.close()
      await slow.app.pubsub.close()
    }
  })

  it('propagates REST-side changes (title, access) to sockets on other instances', async () => {
    const owner = await newUser(nodes[0]!.base)
    const id = await newDoc(owner.api)
    const editor = await newUser(nodes[0]!.base)
    const t = (await owner.api.post(`/api/docs/${id}/links`, { role: 'editor' })).body.link.token
    await editor.api.post(`/api/share/${t}/accept`)

    const e = connect(nodes[2]!.ws, id, editor.token)
    await synced(e.provider)
    // REST call lands on node 0; the socket lives on node 2.
    await owner.api.patch(`/api/docs/${id}`, { title: 'Renamed on node 0' })
    await until(() => e.controls.some((c) => c.type === 'title'), 5000, 'title across nodes')
    await owner.api.del(`/api/docs/${id}/members/${editor.user.id}`)
    await until(() => e.closes.some((c) => c.code === 4403), 5000, 'kick across nodes')
    e.destroy()
  })
})
