import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addParagraph, connect, isSaved, newDoc, newUser, startServer, synced, textOf, until, type TestServer } from './helpers.js'

let srv: TestServer
beforeAll(async () => {
  srv = await startServer()
})
afterAll(async () => {
  await srv.close()
})

async function share(owner: Awaited<ReturnType<typeof newUser>>, docId: string, role: string) {
  const user = await newUser(srv.base)
  const token = (await owner.api.post(`/api/docs/${docId}/links`, { role })).body.link.token
  await user.api.post(`/api/share/${token}/accept`)
  return user
}

describe('real-time sync', () => {
  it('converges two editors, including concurrent edits', async () => {
    const owner = await newUser(srv.base)
    const id = await newDoc(owner.api)
    const editor = await share(owner, id, 'editor')
    const a = connect(srv.ws, id, owner.token)
    const b = connect(srv.ws, id, editor.token)
    await Promise.all([synced(a.provider), synced(b.provider)])

    addParagraph(a.doc, 'Hello from A')
    await until(() => textOf(b.doc).includes('Hello from A'), 3000, 'B sees A')

    // Concurrent edits in the same paragraph: both survive and both replicas agree.
    const pa = a.doc.getXmlFragment('default').get(0) as Y.XmlElement
    const pb = b.doc.getXmlFragment('default').get(0) as Y.XmlElement
    ;(pa.get(0) as Y.XmlText).insert(0, '[A] ')
    ;(pb.get(0) as Y.XmlText).insert(12, ' [B]')
    await until(
      () => textOf(a.doc) === textOf(b.doc) && textOf(a.doc).includes('[A]') && textOf(a.doc).includes('[B]'),
      3000,
      'convergence',
    )
    expect(textOf(a.doc)).toBe('[A] Hello from A [B]')

    a.destroy()
    b.destroy()
  })

  it('acknowledges persisted edits with a state vector (drives the "Saved" indicator)', async () => {
    const owner = await newUser(srv.base)
    const id = await newDoc(owner.api)
    const a = connect(srv.ws, id, owner.token)
    await synced(a.provider)
    addParagraph(a.doc, 'durable')
    expect(isSaved(a)).toBe(false)
    await until(() => isSaved(a), 3000, 'saved ack')
    const sv = Y.decodeStateVector(a.saved[a.saved.length - 1]!)
    const mine = Y.decodeStateVector(Y.encodeStateVector(a.doc)).get(a.doc.clientID)
    expect(sv.get(a.doc.clientID)).toBe(mine)
    // The ack really means durable: it is in the op log.
    const { doc } = await srv.app.ctx.store.load(id)
    expect(textOf(doc)).toBe('durable')
    a.destroy()
  })

  it('enforces read-only roles on the server', async () => {
    const owner = await newUser(srv.base)
    const id = await newDoc(owner.api)
    const viewer = await share(owner, id, 'viewer')
    const commenter = await share(owner, id, 'commenter')
    const o = connect(srv.ws, id, owner.token)
    const v = connect(srv.ws, id, viewer.token)
    const c = connect(srv.ws, id, commenter.token)
    await Promise.all([synced(o.provider), synced(v.provider), synced(c.provider)])

    addParagraph(o.doc, 'official')
    await until(() => textOf(v.doc).includes('official') && textOf(c.doc).includes('official'), 3000, 'readers receive edits')

    // A modified client tries to write anyway.
    addParagraph(v.doc, 'viewer vandalism')
    addParagraph(c.doc, 'commenter vandalism')
    await new Promise((r) => setTimeout(r, 300))
    expect(textOf(o.doc)).toBe('official')
    const stats = await srv.app.ctx.collab.stats()
    expect(stats.updatesRejected).toBeGreaterThanOrEqual(2)
    for (const x of [o, v, c]) x.destroy()
  })

  it('shares presence and stamps the authenticated identity onto awareness', async () => {
    const owner = await newUser(srv.base, 'Alice')
    const id = await newDoc(owner.api)
    const viewer = await share(owner, id, 'viewer')
    const a = connect(srv.ws, id, owner.token)
    const b = connect(srv.ws, id, viewer.token)
    await Promise.all([synced(a.provider), synced(b.provider)])

    // Client claims to be someone else; server overwrites the identity fields.
    a.provider.awareness.setLocalStateField('user', { name: 'Mallory', color: '#000000' })
    a.provider.awareness.setLocalStateField('cursor', { anchor: 1, head: 3 })
    const seen = await until(() => b.provider.awareness.getStates().get(a.doc.clientID), 3000, 'remote awareness')
    expect(seen.user.name).toBe(owner.user.name)
    expect(seen.user.id).toBe(owner.user.id)
    expect(seen.user.role).toBe('owner')
    expect(seen.cursor).toEqual({ anchor: 1, head: 3 })

    a.destroy()
    await until(() => !b.provider.awareness.getStates().has(a.doc.clientID), 3000, 'presence removed on disconnect')
    b.destroy()
  })

  it('rejects unauthenticated, unauthorised and unknown-document connections with terminal close codes', async () => {
    const owner = await newUser(srv.base)
    const stranger = await newUser(srv.base)
    const id = await newDoc(owner.api)
    const cases: Array<[string, string, number]> = [
      [id, 'not-a-token', 4401],
      [id, stranger.token, 4403],
      ['00000000-0000-0000-0000-000000000000', owner.token, 4404],
    ]
    for (const [doc, token, code] of cases) {
      const c = connect(srv.ws, doc, token)
      await until(() => c.closes.length > 0, 3000, `close ${code}`)
      expect(c.closes[0]!.code).toBe(code)
      // y-websocket treats 44xx as permanent and stops reconnecting.
      expect(c.provider.shouldConnect).toBe(false)
      c.destroy()
    }
  })

  it('kicks a connected user when their access is revoked and downgrades live when demoted', async () => {
    const owner = await newUser(srv.base)
    const id = await newDoc(owner.api)
    const editor = await share(owner, id, 'editor')
    const o = connect(srv.ws, id, owner.token)
    const e = connect(srv.ws, id, editor.token)
    await Promise.all([synced(o.provider), synced(e.provider)])

    await owner.api.patch(`/api/docs/${id}/members/${editor.user.id}`, { role: 'viewer' })
    await until(() => e.controls.some((c) => c.type === 'access'), 3000, 'access control event')
    addParagraph(e.doc, 'after demotion')
    await new Promise((r) => setTimeout(r, 200))
    expect(textOf(o.doc)).not.toContain('after demotion')

    await owner.api.del(`/api/docs/${id}/members/${editor.user.id}`)
    await until(() => e.closes.some((c) => c.code === 4403), 3000, 'kicked')
    o.destroy()
    e.destroy()
  })

  it('broadcasts title and comment changes as control events', async () => {
    const owner = await newUser(srv.base)
    const id = await newDoc(owner.api)
    const a = connect(srv.ws, id, owner.token)
    await synced(a.provider)
    await owner.api.patch(`/api/docs/${id}`, { title: 'Live title' })
    await owner.api.post(`/api/docs/${id}/comments`, { body: 'hi', anchor: { from: 'x', to: 'y', quote: 'z' } })
    await until(() => a.controls.some((c) => c.type === 'title' && c.title === 'Live title'), 3000, 'title event')
    await until(() => a.controls.some((c) => c.type === 'comments'), 3000, 'comments event')
    a.destroy()
  })

  it('rate-limits a flooding client with a retryable close code', async () => {
    const limited = await startServer({ wsRateLimit: 50 })
    try {
      const owner = await newUser(limited.base)
      const id = await newDoc(owner.api)
      const a = connect(limited.ws, id, owner.token)
      await synced(a.provider)
      // 300 separate updates in one burst: far beyond 50/s with a burst of 100.
      for (let i = 0; i < 300; i++) addParagraph(a.doc, `spam ${i}`)
      await until(() => a.closes.some((c) => c.code === 4529), 3000, 'rate-limit close')
      // 45xx is "try again later": the provider keeps reconnecting rather than giving up.
      expect(a.provider.shouldConnect).toBe(true)
      expect((await limited.app.ctx.collab.stats()).rateLimited).toBeGreaterThan(0)
      a.destroy()
    } finally {
      await limited.close()
    }
  })
})
