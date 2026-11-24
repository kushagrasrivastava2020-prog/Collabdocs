import { Router, type Request } from 'express'
import * as encoding from 'lib0/encoding'
import { z } from 'zod'
import type { Ctx } from '../context.js'
import { requireUser } from '../auth/index.js'
import { MEMBER_ROLES, atLeast, can, resolveRole, type MemberRole, type Role } from '../permissions.js'
import { badRequest, forbidden, notFound } from '../util/http.js'
import { newId, newToken } from '../util/identity.js'

const titleSchema = z.string().trim().min(1).max(200)
const roleSchema = z.enum(MEMBER_ROLES as [MemberRole, ...MemberRole[]])
const anchorSchema = z.object({ from: z.string().max(4000), to: z.string().max(4000), quote: z.string().max(1000) })

const serializeDoc = (row: any, role: Role) => ({
  id: row.id,
  title: row.title,
  role,
  owner: { id: row.owner_id, name: row.owner_name },
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
})

const serializeComment = (row: any) => ({
  id: row.id,
  parentId: row.parent_id,
  body: row.body,
  anchor: row.anchor ?? null,
  resolved: row.resolved,
  createdAt: new Date(row.created_at).toISOString(),
  author: row.author_id ? { id: row.author_id, name: row.author_name, color: row.author_color } : null,
})

export function documentsRouter(ctx: Ctx) {
  const r = Router()
  const { db, store, collab, config } = ctx
  r.use(requireUser(db, config.jwtSecret))

  /**
   * Load the caller's role on :id and require at least `min`. Users without any access get a
   * 404 (not 403) so document IDs can't be probed.
   */
  async function access(req: Request, min: Role): Promise<Role> {
    const id = req.params.id as string
    const role = await resolveRole(db, id, req.user!.id)
    if (!role) throw notFound('Document not found')
    if (!atLeast(role, min)) throw forbidden()
    return role
  }

  // ------------------------------------------------------------------ documents

  r.get('/', async (req, res) => {
    const uid = req.user!.id
    const rows = await db.query<any>(
      `SELECT d.id, d.title, d.owner_id, u.name AS owner_name, d.created_at, d.updated_at,
              CASE WHEN d.owner_id = $1 THEN 'owner' ELSE m.role END AS role
         FROM documents d
         JOIN users u ON u.id = d.owner_id
         LEFT JOIN document_members m ON m.document_id = d.id AND m.user_id = $1
        WHERE d.owner_id = $1 OR m.user_id = $1
        ORDER BY d.updated_at DESC`,
      [uid],
    )
    const docs = rows.rows.map((row) => serializeDoc(row, row.role))
    res.json({ owned: docs.filter((d) => d.role === 'owner'), shared: docs.filter((d) => d.role !== 'owner') })
  })

  r.post('/', async (req, res) => {
    const title = req.body?.title === undefined ? 'Untitled document' : titleSchema.parse(req.body.title)
    const id = newId()
    await db.query(`INSERT INTO documents (id, title, owner_id) VALUES ($1, $2, $3)`, [id, title, req.user!.id])
    const row = (
      await db.query<any>(`SELECT d.*, u.name AS owner_name FROM documents d JOIN users u ON u.id = d.owner_id WHERE d.id = $1`, [id])
    ).rows[0]
    res.status(201).json({ document: serializeDoc(row, 'owner') })
  })

  r.get('/:id', async (req, res) => {
    const role = await access(req, 'viewer')
    const row = (
      await db.query<any>(`SELECT d.*, u.name AS owner_name FROM documents d JOIN users u ON u.id = d.owner_id WHERE d.id = $1`, [
        req.params.id,
      ])
    ).rows[0]
    res.json({ document: serializeDoc(row, role) })
  })

  r.patch('/:id', async (req, res) => {
    await access(req, 'editor')
    const title = titleSchema.parse(req.body?.title)
    await db.query(`UPDATE documents SET title = $2, updated_at = now() WHERE id = $1`, [req.params.id, title])
    await collab.control(req.params.id as string, { type: 'title', title })
    res.json({ ok: true, title })
  })

  r.delete('/:id', async (req, res) => {
    await access(req, 'owner')
    await db.query(`DELETE FROM documents WHERE id = $1`, [req.params.id])
    await collab.control(req.params.id as string, { type: 'deleted' })
    res.status(204).end()
  })

  r.get('/:id/stats', async (req, res) => {
    await access(req, 'viewer')
    res.json(await store.stats(req.params.id as string))
  })

  /**
   * Op-log page for time-travel replay, as a compact binary frame (lib0 encoding):
   *   varUint count, then per row: varUint seq, float64 timestamp, varString userId,
   *   varString userName, varString userColor, varUint8Array yjsUpdate
   */
  r.get('/:id/oplog', async (req, res) => {
    await access(req, 'viewer')
    const after = Math.max(0, Number.parseInt(String(req.query.after ?? '0'), 10) || 0)
    const limit = Math.min(5000, Math.max(1, Number.parseInt(String(req.query.limit ?? '2000'), 10) || 2000))
    const rows = await store.readLog(req.params.id as string, after, limit)
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, rows.length)
    for (const row of rows) {
      encoding.writeVarUint(enc, row.seq)
      encoding.writeFloat64(enc, row.at)
      encoding.writeVarString(enc, row.userId)
      encoding.writeVarString(enc, row.userName)
      encoding.writeVarString(enc, row.userColor)
      encoding.writeVarUint8Array(enc, row.data)
    }
    res.setHeader('X-Has-More', rows.length === limit ? '1' : '0')
    res.type('application/octet-stream').send(Buffer.from(encoding.toUint8Array(enc)))
  })

  // ------------------------------------------------------------------ members

  r.get('/:id/members', async (req, res) => {
    await access(req, 'viewer')
    const rows = await db.query<any>(
      `SELECT u.id, u.name, u.email, u.color, u.is_guest, 'owner' AS role, d.created_at AS added_at
         FROM documents d JOIN users u ON u.id = d.owner_id WHERE d.id = $1
       UNION ALL
       SELECT u.id, u.name, u.email, u.color, u.is_guest, m.role, m.added_at
         FROM document_members m JOIN users u ON u.id = m.user_id WHERE m.document_id = $1
       ORDER BY added_at`,
      [req.params.id],
    )
    res.json({
      members: rows.rows.map((u) => ({
        user: { id: u.id, name: u.name, email: u.is_guest ? null : u.email, color: u.color },
        role: u.role,
      })),
    })
  })

  r.patch('/:id/members/:userId', async (req, res) => {
    await access(req, 'owner')
    const role = roleSchema.parse(req.body?.role)
    const r2 = await db.query(`UPDATE document_members SET role = $3 WHERE document_id = $1 AND user_id = $2 RETURNING user_id`, [
      req.params.id,
      req.params.userId,
      role,
    ])
    if (!r2.rows.length) throw notFound('Member not found')
    await collab.control(req.params.id as string, { type: 'access', userId: req.params.userId as string })
    res.json({ ok: true })
  })

  r.delete('/:id/members/:userId', async (req, res) => {
    const role = await access(req, 'viewer')
    const leavingSelf = req.params.userId === req.user!.id
    if (!leavingSelf && !can.manage(role)) throw forbidden()
    await db.query(`DELETE FROM document_members WHERE document_id = $1 AND user_id = $2`, [req.params.id, req.params.userId])
    await collab.control(req.params.id as string, { type: 'access', userId: req.params.userId as string })
    res.status(204).end()
  })

  // ------------------------------------------------------------------ share links

  r.get('/:id/links', async (req, res) => {
    await access(req, 'owner')
    const rows = await db.query<any>(
      `SELECT token, role, created_at FROM share_links WHERE document_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
      [req.params.id],
    )
    res.json({ links: rows.rows.map((l) => ({ token: l.token, role: l.role, createdAt: new Date(l.created_at).toISOString() })) })
  })

  r.post('/:id/links', async (req, res) => {
    await access(req, 'owner')
    const role = roleSchema.parse(req.body?.role)
    const token = newToken()
    const row = (
      await db.query<any>(`INSERT INTO share_links (token, document_id, role, created_by) VALUES ($1, $2, $3, $4) RETURNING created_at`, [
        token,
        req.params.id,
        role,
        req.user!.id,
      ])
    ).rows[0]
    res.status(201).json({ link: { token, role, createdAt: new Date(row.created_at).toISOString() } })
  })

  r.delete('/:id/links/:token', async (req, res) => {
    await access(req, 'owner')
    await db.query(`UPDATE share_links SET revoked_at = now() WHERE document_id = $1 AND token = $2`, [req.params.id, req.params.token])
    res.status(204).end()
  })

  // ------------------------------------------------------------------ version history

  r.get('/:id/versions', async (req, res) => {
    await access(req, 'viewer')
    res.json({ versions: await store.listVersions(req.params.id as string) })
  })

  r.post('/:id/versions', async (req, res) => {
    await access(req, 'editor')
    const label = z.string().trim().min(1).max(100).parse(req.body?.label)
    const id = req.params.id as string
    await collab.flush(id)
    const version = await store.snapshot(id, { kind: 'manual', label, userId: req.user!.id, force: true })
    await collab.control(id, { type: 'versions' })
    res.status(201).json({ version: { ...version, createdBy: { id: req.user!.id, name: req.user!.name } } })
  })

  r.get('/:id/versions/:vid/state', async (req, res) => {
    await access(req, 'viewer')
    const state = await store.versionState(req.params.id as string, req.params.vid as string)
    if (!state) throw notFound('Version not found')
    res.type('application/octet-stream').send(Buffer.from(state))
  })

  r.post('/:id/versions/:vid/restore', async (req, res) => {
    await access(req, 'editor')
    const id = req.params.id as string
    const vid = req.params.vid as string
    const state = await store.versionState(id, vid)
    if (!state) throw notFound('Version not found')
    const restored = (
      await db.query<{ label: string | null; created_at: Date }>(`SELECT label, created_at FROM doc_snapshots WHERE id = $1`, [vid])
    ).rows[0]!
    const when = new Date(restored.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
    const version = await collab.withRoom(id, async (room) => {
      await room.flush()
      // Checkpoint the current state first so the restore itself can be undone.
      await store.snapshot(id, { kind: 'auto', label: 'Before restore' })
      await room.restore(state, req.user!.id)
      const v = await store.snapshot(id, {
        kind: 'restore',
        label: `Restored ${restored.label ? `"${restored.label}"` : `version from ${when} UTC`}`,
        userId: req.user!.id,
        force: true,
      })
      await room.control({ type: 'restored', versionId: vid, by: req.user!.name })
      await room.control({ type: 'versions' })
      return v
    })
    res.json({ version })
  })

  // ------------------------------------------------------------------ comments

  r.get('/:id/comments', async (req, res) => {
    await access(req, 'viewer')
    const rows = await db.query<any>(
      `SELECT c.*, u.name AS author_name, u.color AS author_color
         FROM comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.document_id = $1 ORDER BY c.created_at`,
      [req.params.id],
    )
    res.json({ comments: rows.rows.map(serializeComment) })
  })

  r.post('/:id/comments', async (req, res) => {
    await access(req, 'commenter')
    const body = z
      .object({ body: z.string().trim().min(1).max(5000), anchor: anchorSchema.nullish(), parentId: z.string().nullish() })
      .parse(req.body)
    if (body.parentId) {
      const parent = await db.query(`SELECT 1 FROM comments WHERE id = $1 AND document_id = $2 AND parent_id IS NULL`, [
        body.parentId,
        req.params.id,
      ])
      if (!parent.rows.length) throw badRequest('Parent comment not found')
    } else if (!body.anchor) {
      throw badRequest('A comment needs a text selection to attach to')
    }
    const id = newId()
    await db.query(`INSERT INTO comments (id, document_id, parent_id, author_id, body, anchor) VALUES ($1, $2, $3, $4, $5, $6)`, [
      id,
      req.params.id,
      body.parentId ?? null,
      req.user!.id,
      body.body,
      body.parentId ? null : JSON.stringify(body.anchor),
    ])
    const row = (
      await db.query<any>(
        `SELECT c.*, u.name AS author_name, u.color AS author_color FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.id = $1`,
        [id],
      )
    ).rows[0]
    await collab.control(req.params.id as string, { type: 'comments' })
    res.status(201).json({ comment: serializeComment(row) })
  })

  r.patch('/:id/comments/:cid', async (req, res) => {
    await access(req, 'commenter')
    const body = z.object({ body: z.string().trim().min(1).max(5000).optional(), resolved: z.boolean().optional() }).parse(req.body)
    const existing = (
      await db.query<any>(`SELECT author_id FROM comments WHERE id = $1 AND document_id = $2`, [req.params.cid, req.params.id])
    ).rows[0]
    if (!existing) throw notFound('Comment not found')
    if (body.body !== undefined && existing.author_id !== req.user!.id) throw forbidden('Only the author can edit a comment')
    await db.query(`UPDATE comments SET body = COALESCE($2, body), resolved = COALESCE($3, resolved) WHERE id = $1`, [
      req.params.cid,
      body.body ?? null,
      body.resolved ?? null,
    ])
    await collab.control(req.params.id as string, { type: 'comments' })
    res.json({ ok: true })
  })

  r.delete('/:id/comments/:cid', async (req, res) => {
    const role = await access(req, 'commenter')
    const existing = (
      await db.query<any>(`SELECT author_id FROM comments WHERE id = $1 AND document_id = $2`, [req.params.cid, req.params.id])
    ).rows[0]
    if (!existing) throw notFound('Comment not found')
    if (existing.author_id !== req.user!.id && !can.manage(role)) throw forbidden('Only the author or the owner can delete a comment')
    await db.query(`DELETE FROM comments WHERE id = $1`, [req.params.cid])
    await collab.control(req.params.id as string, { type: 'comments' })
    res.status(204).end()
  })

  return r
}

export function shareRouter(ctx: Ctx) {
  const r = Router()
  const { db, collab, config } = ctx
  r.use(requireUser(db, config.jwtSecret))

  async function findLink(token: string) {
    const row = (
      await db.query<any>(
        `SELECT l.document_id, l.role, d.title, d.owner_id, u.name AS owner_name
           FROM share_links l JOIN documents d ON d.id = l.document_id JOIN users u ON u.id = d.owner_id
          WHERE l.token = $1 AND l.revoked_at IS NULL`,
        [token],
      )
    ).rows[0]
    if (!row) throw notFound('This link is invalid or has been revoked')
    return row
  }

  r.get('/:token', async (req, res) => {
    const link = await findLink(req.params.token as string)
    const current = await resolveRole(db, link.document_id, req.user!.id)
    res.json({
      document: { id: link.document_id, title: link.title, owner: { id: link.owner_id, name: link.owner_name } },
      role: link.role,
      currentRole: current,
    })
  })

  r.post('/:token/accept', async (req, res) => {
    const link = await findLink(req.params.token as string)
    const docId = link.document_id as string
    const current = await resolveRole(db, docId, req.user!.id)
    // Accepting a link never downgrades existing access.
    if (!current || (current !== 'owner' && atLeast(link.role, current) && link.role !== current)) {
      await db.query(
        `INSERT INTO document_members (document_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (document_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [docId, req.user!.id, link.role],
      )
      await collab.control(docId, { type: 'access', userId: req.user!.id })
    }
    res.json({ documentId: docId, role: await resolveRole(db, docId, req.user!.id) })
  })

  return r
}
