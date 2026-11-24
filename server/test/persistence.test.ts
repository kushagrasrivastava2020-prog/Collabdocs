import * as Y from 'yjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import * as decoding from 'lib0/decoding'
import { DocStore } from '../src/collab/persistence.js'
import { createDb } from '../src/db/index.js'
import { addParagraph, connect, isSaved, memoryDb, newDoc, newUser, sleep, startServer, synced, textOf, until } from './helpers.js'

describe('DocStore (op log + snapshots)', () => {
  async function setup() {
    const db = await memoryDb()
    const store = new DocStore(db)
    const uid = crypto.randomUUID()
    const docId = crypto.randomUUID()
    await db.query(`INSERT INTO users (id, email, name, password_hash, color) VALUES ($1, $2, 'U', 'x', '#000')`, [uid, `${uid}@t.dev`])
    await db.query(`INSERT INTO documents (id, owner_id) VALUES ($1, $2)`, [docId, uid])
    return { db, store, docId }
  }

  it('assigns gap-free sequence numbers under concurrent appends', async () => {
    const { db, store, docId } = await setup()
    const source = new Y.Doc()
    const updates: Uint8Array[] = []
    source.on('update', (u: Uint8Array) => updates.push(u))
    for (let i = 0; i < 40; i++) source.getText('t').insert(i, 'x')

    const seqs = await Promise.all(updates.map((u) => store.append(docId, u, null)))
    expect([...seqs].sort((a, b) => a! - b!)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))

    const { doc } = await store.load(docId)
    expect(doc.getText('t').toString()).toBe('x'.repeat(40))
    await db.close()
  })

  it('loads snapshot + tail, and snapshots are equivalent to replaying the full log', async () => {
    const { db, store, docId } = await setup()
    const src = new Y.Doc()
    src.on('update', (u: Uint8Array) => void store.append(docId, u, null))
    src.getText('t').insert(0, 'hello')
    await sleep(20)
    const v1 = await store.snapshot(docId, { kind: 'auto' })
    expect(v1?.seq).toBe(1)
    src.getText('t').insert(5, ' world')
    src.getText('t').delete(0, 1)
    await sleep(20)

    expect(await store.pendingCount(docId)).toBe(2)
    const { doc, tail } = await store.load(docId)
    expect(tail).toBe(2)
    expect(doc.getText('t').toString()).toBe('ello world')

    // Nothing new: no snapshot unless forced.
    await store.snapshot(docId, { kind: 'auto' })
    expect(await store.snapshot(docId, { kind: 'auto' })).toBeNull()
    expect((await store.snapshot(docId, { kind: 'manual', label: 'named', force: true }))?.label).toBe('named')
    expect(await store.pendingCount(docId)).toBe(0)

    const reloaded = (await store.load(docId)).doc
    expect(reloaded.getText('t').toString()).toBe('ello world')
    // The op log is append-only: all rows are still there.
    expect((await store.stats(docId)).updates).toBe(3)
    const versions = await store.listVersions(docId)
    expect(versions.map((v) => v.kind)).toEqual(['manual', 'auto', 'auto'])
    await db.close()
  })
})

describe('embedded database (PGlite)', () => {
  it('recovers a data directory left locked by a process that was killed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collabdocs-pglite-'))
    try {
      const db1 = await createDb({ pgliteDir: dir })
      await db1.query(`INSERT INTO users (id, email, name, password_hash, color) VALUES ('u1', 'u1@t.dev', 'U', 'x', '#000')`)
      await db1.close()
      // Simulate an unclean exit: PGlite's postmaster.pid plus our lock owned by a dead process.
      const dead = spawnSync(process.execPath, ['-e', '']).pid
      fs.writeFileSync(path.join(dir, 'postmaster.pid'), '-42\n/pglite/data\n')
      fs.writeFileSync(path.join(dir, 'collabdocs.lock'), String(dead))

      const db2 = await createDb({ pgliteDir: dir })
      expect((await db2.query(`SELECT name FROM users WHERE id = 'u1'`)).rows).toEqual([{ name: 'U' }])
      expect(fs.readFileSync(path.join(dir, 'collabdocs.lock'), 'utf8')).toBe(String(process.pid))
      await db2.close()
      expect(fs.existsSync(path.join(dir, 'collabdocs.lock'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('server persistence', () => {
  it('persists edits across room unload and full server restarts', async () => {
    const db = await memoryDb()
    const s1 = await startServer({}, { db })
    const owner = await newUser(s1.base)
    const id = await newDoc(owner.api)
    const a = connect(s1.ws, id, owner.token)
    await synced(a.provider)
    addParagraph(a.doc, 'survives restarts')
    await until(() => isSaved(a), 3000, 'saved')
    a.destroy()
    await s1.close()

    // Brand new server process on the same database.
    const s2 = await startServer({}, { db })
    const b = connect(s2.ws, id, owner.token)
    await synced(b.provider)
    expect(textOf(b.doc)).toBe('survives restarts')
    b.destroy()

    // Graceful close wrote a snapshot covering the log.
    const stats = await s2.app.ctx.store.stats(id)
    expect(stats.snapshots).toBeGreaterThanOrEqual(1)
    await s2.close()
    await db.close()
  })

  it('takes automatic snapshots while editing', async () => {
    const srv = await startServer({ snapshotEveryFlushes: 5 })
    const owner = await newUser(srv.base)
    const id = await newDoc(owner.api)
    const a = connect(srv.ws, id, owner.token)
    await synced(a.provider)
    for (let i = 0; i < 12; i++) {
      addParagraph(a.doc, `line ${i}`)
      await sleep(25) // > flushIntervalMs, so each edit is its own op-log append
    }
    await until(async () => (await srv.app.ctx.store.stats(id)).snapshots >= 2, 3000, 'auto snapshots')
    a.destroy()
    await srv.close()
  })

  it('syncs offline edits on reconnect, merging with edits made meanwhile', async () => {
    const srv = await startServer()
    const owner = await newUser(srv.base)
    const id = await newDoc(owner.api)
    const a = connect(srv.ws, id, owner.token)
    const b = connect(srv.ws, id, owner.token)
    await Promise.all([synced(a.provider), synced(b.provider)])
    addParagraph(a.doc, 'base')
    await until(() => textOf(b.doc) === 'base', 3000, 'base synced')

    // A goes offline and keeps typing; B keeps editing online.
    a.provider.disconnect()
    addParagraph(a.doc, 'written offline')
    addParagraph(b.doc, 'written online')
    await sleep(100)
    expect(textOf(b.doc)).not.toContain('offline')

    a.provider.connect()
    await until(
      () => textOf(a.doc) === textOf(b.doc) && textOf(b.doc).includes('offline') && textOf(a.doc).includes('online'),
      5000,
      'offline merge',
    )
    const lines = textOf(a.doc).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('base')

    // ...and it reached durable storage, not just the other client.
    await until(
      async () => {
        const { doc } = await srv.app.ctx.store.load(id)
        return textOf(doc).includes('written offline')
      },
      3000,
      'offline edit persisted',
    )
    a.destroy()
    b.destroy()
    await srv.close()
  })
})

describe('version history', () => {
  it('creates named versions and restores them as a new forward edit', async () => {
    const srv = await startServer()
    const owner = await newUser(srv.base)
    const id = await newDoc(owner.api)
    const a = connect(srv.ws, id, owner.token)
    await synced(a.provider)

    addParagraph(a.doc, 'Draft one')
    await until(() => isSaved(a), 3000, 'saved')
    const v1 = await owner.api.post(`/api/docs/${id}/versions`, { label: 'First draft' })
    expect(v1.status).toBe(201)
    expect(v1.body.version).toMatchObject({ kind: 'manual', label: 'First draft' })

    addParagraph(a.doc, 'Bad idea')
    await until(() => textOf(a.doc) === 'Draft one\nBad idea', 3000, 'second edit')
    await sleep(50)

    // Version state can be fetched for preview.
    const stateRes = await fetch(`${srv.base}/api/docs/${id}/versions/${v1.body.version.id}/state`, {
      headers: { authorization: `Bearer ${owner.token}` },
    })
    const preview = new Y.Doc()
    Y.applyUpdate(preview, new Uint8Array(await stateRes.arrayBuffer()))
    expect(textOf(preview)).toBe('Draft one')

    const restored = await owner.api.post(`/api/docs/${id}/versions/${v1.body.version.id}/restore`)
    expect(restored.status).toBe(200)
    // The connected client receives the restore like any other edit.
    await until(() => textOf(a.doc) === 'Draft one', 3000, 'client sees restore')
    expect(a.controls.some((c) => c.type === 'restored')).toBe(true)

    const versions = (await owner.api.get(`/api/docs/${id}/versions`)).body.versions
    expect(versions[0]).toMatchObject({ kind: 'restore', label: 'Restored "First draft"' })
    expect(versions.some((v: any) => v.label === 'Before restore')).toBe(true)

    // Undo-the-restore is possible: the "Before restore" checkpoint still has the bad idea.
    const before = versions.find((v: any) => v.label === 'Before restore')
    const st = await fetch(`${srv.base}/api/docs/${id}/versions/${before.id}/state`, {
      headers: { authorization: `Bearer ${owner.token}` },
    })
    const beforeDoc = new Y.Doc()
    Y.applyUpdate(beforeDoc, new Uint8Array(await st.arrayBuffer()))
    expect(textOf(beforeDoc)).toBe('Draft one\nBad idea')

    a.destroy()
    await srv.close()
  })
})

describe('op-log replay API', () => {
  it('returns every write in order; replaying a prefix reproduces that point in history', async () => {
    const srv = await startServer()
    const owner = await newUser(srv.base)
    const id = await newDoc(owner.api)
    const a = connect(srv.ws, id, owner.token)
    await synced(a.provider)
    const states: string[] = []
    for (const word of ['one', 'two', 'three']) {
      addParagraph(a.doc, word)
      await until(() => isSaved(a), 3000, 'saved')
      states.push(textOf(a.doc))
    }

    const res = await fetch(`${srv.base}/api/docs/${id}/oplog?after=0`, { headers: { authorization: `Bearer ${owner.token}` } })
    expect(res.headers.get('x-has-more')).toBe('0')
    const dec = decoding.createDecoder(new Uint8Array(await res.arrayBuffer()))
    const n = decoding.readVarUint(dec)
    expect(n).toBe(3)
    const replay = new Y.Doc()
    let lastSeq = 0
    for (let i = 0; i < n; i++) {
      const seq = decoding.readVarUint(dec)
      const at = decoding.readFloat64(dec)
      const userId = decoding.readVarString(dec)
      const userName = decoding.readVarString(dec)
      decoding.readVarString(dec) // colour
      const update = decoding.readVarUint8Array(dec)
      expect(seq).toBe(lastSeq + 1)
      lastSeq = seq
      expect(Math.abs(Date.now() - at)).toBeLessThan(60_000)
      expect(userId).toBe(owner.user.id)
      expect(userName).toBe(owner.user.name)
      Y.applyUpdate(replay, update)
      expect(textOf(replay)).toBe(states[i])
    }

    // Paging and permissions.
    const page = await fetch(`${srv.base}/api/docs/${id}/oplog?after=2`, { headers: { authorization: `Bearer ${owner.token}` } })
    expect(decoding.readVarUint(decoding.createDecoder(new Uint8Array(await page.arrayBuffer())))).toBe(1)
    const stranger = await newUser(srv.base)
    expect((await stranger.api.get(`/api/docs/${id}/oplog`)).status).toBe(404)
    a.destroy()
    await srv.close()
  })
})

describe('op-log attribution', () => {
  it('keeps one row per author when several people type inside the same batching window', async () => {
    const srv = await startServer({ flushIntervalMs: 300 })
    const alice = await newUser(srv.base, 'Alice')
    const id = await newDoc(alice.api)
    const t = (await alice.api.post(`/api/docs/${id}/links`, { role: 'editor' })).body.link.token
    const bob = await newUser(srv.base, 'Bob')
    await bob.api.post(`/api/share/${t}/accept`)
    const a = connect(srv.ws, id, alice.token)
    const b = connect(srv.ws, id, bob.token)
    await Promise.all([synced(a.provider), synced(b.provider)])

    addParagraph(a.doc, 'from alice')
    addParagraph(b.doc, 'from bob')
    await until(() => isSaved(a) && isSaved(b), 3000, 'both saved')

    const rows = await srv.app.ctx.store.readLog(id, 0, 100)
    expect(rows.map((r) => r.userName).sort()).toEqual([alice.user.name, bob.user.name].sort())
    a.destroy()
    b.destroy()
    await srv.close()
  })
})
