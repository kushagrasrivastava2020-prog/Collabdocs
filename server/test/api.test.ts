import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { client, newDoc, newUser, startServer, type TestServer } from './helpers.js'

let srv: TestServer
// Unique per run so the suite can also run against a persistent Postgres (CI / docker).
const run = `${Date.now()}${Math.floor(Math.random() * 1e4)}`
beforeAll(async () => {
  srv = await startServer()
})
afterAll(async () => {
  await srv.close()
})

describe('auth', () => {
  it('signs up, sets an httpOnly session cookie, and returns the user', async () => {
    const res = await fetch(`${srv.base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `Ada-${run}@Example.com`, name: 'Ada', password: 'correct horse' }),
    })
    expect(res.status).toBe(201)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/cd_session=/)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    const body = (await res.json()) as any
    expect(body.user).toMatchObject({ email: `ada-${run}@example.com`, name: 'Ada', isGuest: false })
    expect(body.user.password_hash).toBeUndefined()

    // The cookie alone authenticates.
    const me = await fetch(`${srv.base}/api/auth/me`, { headers: { cookie: cookie.split(';')[0]! } })
    expect(((await me.json()) as any).user.email).toBe(`ada-${run}@example.com`)
  })

  it('rejects duplicate emails, weak passwords and bad credentials', async () => {
    const api = client(srv.base)
    await api.post('/api/auth/signup', { email: `bob-${run}@example.com`, name: 'Bob', password: 'password123' })
    expect((await api.post('/api/auth/signup', { email: `BOB-${run}@example.com`, name: 'Bob 2', password: 'password123' })).status).toBe(
      409,
    )
    const weak = await api.post('/api/auth/signup', { email: 'c@example.com', name: 'C', password: 'short' })
    expect(weak.status).toBe(400)
    expect(weak.body.error).toMatch(/at least 8/)
    expect((await api.post('/api/auth/login', { email: `bob-${run}@example.com`, password: 'nope-nope' })).status).toBe(401)
    expect((await api.post('/api/auth/login', { email: 'nobody@example.com', password: 'nope-nope' })).status).toBe(401)
    const ok = await api.post('/api/auth/login', { email: `Bob-${run}@Example.com`, password: 'password123' })
    expect(ok.status).toBe(200)
    expect(ok.body.user.name).toBe('Bob')
  })

  it('creates one-click guest accounts', async () => {
    const res = await client(srv.base).post('/api/auth/guest')
    expect(res.status).toBe(201)
    expect(res.body.user.isGuest).toBe(true)
    expect(res.body.user.name).toMatch(/^\w+ \w+$/)
    const me = await client(srv.base, res.body.token).get('/api/auth/me')
    expect(me.body.user.id).toBe(res.body.user.id)
  })

  it('requires authentication for document APIs', async () => {
    expect((await client(srv.base).get('/api/docs')).status).toBe(401)
    expect((await client(srv.base, 'garbage.token.value').get('/api/docs')).status).toBe(401)
  })
})

describe('documents', () => {
  it('supports create / list / get / rename / delete', async () => {
    const { api } = await newUser(srv.base)
    const created = await api.post('/api/docs', { title: 'Roadmap' })
    expect(created.status).toBe(201)
    const id = created.body.document.id
    expect(created.body.document).toMatchObject({ title: 'Roadmap', role: 'owner' })

    const untitled = await api.post('/api/docs', {})
    expect(untitled.body.document.title).toBe('Untitled document')

    const list = await api.get('/api/docs')
    expect(list.body.owned.map((d: any) => d.id)).toContain(id)
    expect(list.body.shared).toEqual([])

    expect((await api.patch(`/api/docs/${id}`, { title: 'Roadmap 2027' })).status).toBe(200)
    expect((await api.get(`/api/docs/${id}`)).body.document.title).toBe('Roadmap 2027')
    expect((await api.patch(`/api/docs/${id}`, { title: '   ' })).status).toBe(400)

    expect((await api.del(`/api/docs/${id}`)).status).toBe(204)
    expect((await api.get(`/api/docs/${id}`)).status).toBe(404)
  })

  it('hides documents from non-members (404, not 403)', async () => {
    const owner = await newUser(srv.base)
    const stranger = await newUser(srv.base)
    const id = await newDoc(owner.api)
    expect((await stranger.api.get(`/api/docs/${id}`)).status).toBe(404)
    expect((await stranger.api.patch(`/api/docs/${id}`, { title: 'pwned' })).status).toBe(404)
    expect((await stranger.api.del(`/api/docs/${id}`)).status).toBe(404)
    expect((await stranger.api.get(`/api/docs/${id}/versions`)).status).toBe(404)
  })
})

describe('share links and roles', () => {
  it('grants the link role on accept and enforces it', async () => {
    const owner = await newUser(srv.base, 'owner')
    const guest = await newUser(srv.base, 'guest')
    const id = await newDoc(owner.api, 'Shared plan')

    const link = await owner.api.post(`/api/docs/${id}/links`, { role: 'viewer' })
    expect(link.status).toBe(201)
    const token = link.body.link.token
    expect(token.length).toBeGreaterThanOrEqual(20)

    // Only the owner manages links.
    expect((await guest.api.post(`/api/docs/${id}/links`, { role: 'editor' })).status).toBe(404)

    const preview = await guest.api.get(`/api/share/${token}`)
    expect(preview.body).toMatchObject({ role: 'viewer', currentRole: null, document: { id, title: 'Shared plan' } })

    const accepted = await guest.api.post(`/api/share/${token}/accept`)
    expect(accepted.body).toEqual({ documentId: id, role: 'viewer' })
    expect((await guest.api.get('/api/docs')).body.shared.map((d: any) => d.id)).toEqual([id])

    // Viewer: can read, cannot rename, comment, or snapshot.
    expect((await guest.api.get(`/api/docs/${id}`)).body.document.role).toBe('viewer')
    expect((await guest.api.patch(`/api/docs/${id}`, { title: 'x' })).status).toBe(403)
    expect((await guest.api.post(`/api/docs/${id}/comments`, { body: 'hi', anchor: { from: 'a', to: 'b', quote: 'q' } })).status).toBe(403)
    expect((await guest.api.post(`/api/docs/${id}/versions`, { label: 'v1' })).status).toBe(403)

    // Accepting a lower link never downgrades; a higher one upgrades.
    const editLink = (await owner.api.post(`/api/docs/${id}/links`, { role: 'editor' })).body.link.token
    expect((await guest.api.post(`/api/share/${editLink}/accept`)).body.role).toBe('editor')
    expect((await guest.api.post(`/api/share/${token}/accept`)).body.role).toBe('editor')
    expect((await guest.api.patch(`/api/docs/${id}`, { title: 'Edited by guest' })).status).toBe(200)

    // Owner can change and remove members.
    expect((await owner.api.patch(`/api/docs/${id}/members/${guest.user.id}`, { role: 'commenter' })).status).toBe(200)
    expect((await guest.api.get(`/api/docs/${id}`)).body.document.role).toBe('commenter')
    const members = (await owner.api.get(`/api/docs/${id}/members`)).body.members
    expect(members.map((m: any) => m.role)).toEqual(['owner', 'commenter'])
    expect((await owner.api.del(`/api/docs/${id}/members/${guest.user.id}`)).status).toBe(204)
    expect((await guest.api.get(`/api/docs/${id}`)).status).toBe(404)

    // Revoked links stop working.
    expect((await owner.api.del(`/api/docs/${id}/links/${token}`)).status).toBe(204)
    expect((await guest.api.post(`/api/share/${token}/accept`)).status).toBe(404)
  })
})

describe('comments', () => {
  it('lets commenters comment and reply; only authors edit, authors/owners delete', async () => {
    const owner = await newUser(srv.base)
    const a = await newUser(srv.base)
    const b = await newUser(srv.base)
    const id = await newDoc(owner.api)
    for (const u of [a, b]) {
      const t = (await owner.api.post(`/api/docs/${id}/links`, { role: 'commenter' })).body.link.token
      await u.api.post(`/api/share/${t}/accept`)
    }
    const anchor = { from: 'AQID', to: 'BAUG', quote: 'hello world' }
    expect((await a.api.post(`/api/docs/${id}/comments`, { body: 'no anchor' })).status).toBe(400)
    const c = await a.api.post(`/api/docs/${id}/comments`, { body: 'Is this right?', anchor })
    expect(c.status).toBe(201)
    expect(c.body.comment).toMatchObject({ body: 'Is this right?', anchor, resolved: false, author: { id: a.user.id } })
    const cid = c.body.comment.id

    const reply = await b.api.post(`/api/docs/${id}/comments`, { body: 'Yes', parentId: cid })
    expect(reply.body.comment.parentId).toBe(cid)
    // Replies to replies are not allowed (threads are one level deep).
    expect((await a.api.post(`/api/docs/${id}/comments`, { body: 'nested', parentId: reply.body.comment.id })).status).toBe(400)

    expect((await b.api.patch(`/api/docs/${id}/comments/${cid}`, { body: 'hijack' })).status).toBe(403)
    expect((await b.api.patch(`/api/docs/${id}/comments/${cid}`, { resolved: true })).status).toBe(200)
    expect((await b.api.del(`/api/docs/${id}/comments/${cid}`)).status).toBe(403)

    const list = (await owner.api.get(`/api/docs/${id}/comments`)).body.comments
    expect(list).toHaveLength(2)
    expect(list[0].resolved).toBe(true)

    expect((await owner.api.del(`/api/docs/${id}/comments/${cid}`)).status).toBe(204)
    // Deleting a thread removes its replies.
    expect((await owner.api.get(`/api/docs/${id}/comments`)).body.comments).toHaveLength(0)
  })
})

describe('operability', () => {
  it('exposes Prometheus metrics and per-route latency histograms', async () => {
    const { api } = await newUser(srv.base)
    await api.get('/api/docs')
    const res = await fetch(`${srv.base}/metrics`)
    expect(res.headers.get('content-type')).toMatch(/text\/plain/)
    const text = await res.text()
    for (const name of [
      'collabdocs_ws_connections',
      'collabdocs_rooms',
      'collabdocs_ws_messages_total',
      'collabdocs_oplog_append_seconds_bucket',
      'collabdocs_room_load_seconds_bucket',
    ]) {
      expect(text).toContain(name)
    }
    // Routes are labelled by pattern, never by raw URL (bounded cardinality).
    expect(text).toMatch(/collabdocs_http_request_seconds_count\{[^}]*route="\/api\/docs\/"/)
  })

  it('sends hardening headers', async () => {
    const res = await fetch(`${srv.base}/api/health`)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
  })
})
