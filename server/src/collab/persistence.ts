import * as Y from 'yjs'
import { bytes, int, type Db } from '../db/index.js'
import { newId } from '../util/identity.js'

export type SnapshotKind = 'auto' | 'manual' | 'restore'

export interface VersionInfo {
  id: string
  seq: number
  kind: SnapshotKind
  label: string | null
  createdAt: string
  createdBy: { id: string; name: string } | null
}

/**
 * Durable storage for Yjs documents.
 *
 *   doc_updates   append-only op log of binary Yjs updates, ordered by a per-document seq
 *   doc_snapshots compacted state covering all updates with seq <= snapshot.seq
 *
 * Load = latest snapshot + every update after it. Because Yjs updates are idempotent and
 * commutative, replaying an update twice is harmless, which makes the recovery paths simple.
 */
export class DocStore {
  constructor(private db: Db) {}

  /**
   * Reconstruct a document from its latest snapshot plus the op-log tail.
   * Pass `doc` to load into an existing replica (`origin` is used as the transaction origin).
   */
  async load(docId: string, doc = new Y.Doc(), origin: unknown = null): Promise<{ doc: Y.Doc; seq: number; tail: number }> {
    const snap = await this.db.query<{ seq: string; state: Uint8Array }>(
      `SELECT seq, state FROM doc_snapshots WHERE document_id = $1 ORDER BY seq DESC, created_at DESC LIMIT 1`,
      [docId],
    )
    const base = snap.rows[0]
    const baseSeq = base ? int(base.seq) : 0
    const tail = await this.db.query<{ seq: string; data: Uint8Array }>(
      `SELECT seq, data FROM doc_updates WHERE document_id = $1 AND seq > $2 ORDER BY seq`,
      [docId, baseSeq],
    )
    doc.transact(() => {
      if (base) Y.applyUpdate(doc, bytes(base.state))
      for (const row of tail.rows) Y.applyUpdate(doc, bytes(row.data))
    }, origin)
    const seq = tail.rows.length ? int(tail.rows[tail.rows.length - 1]!.seq) : baseSeq
    return { doc, seq, tail: tail.rows.length }
  }

  /**
   * Append one update to the op log. The UPDATE ... RETURNING takes a row lock on the
   * document, so concurrent appends (from any server instance) are serialised and seqs
   * commit in order: readers always observe a gap-free prefix of the log.
   * Returns null if the document no longer exists.
   */
  async append(docId: string, update: Uint8Array, userId: string | null): Promise<number | null> {
    return this.db.tx(async (q) => {
      const r = await q.query<{ seq: string }>(
        `UPDATE documents SET update_seq = update_seq + 1, updated_at = now() WHERE id = $1 RETURNING update_seq AS seq`,
        [docId],
      )
      if (!r.rows[0]) return null
      const seq = int(r.rows[0].seq)
      await q.query(`INSERT INTO doc_updates (document_id, seq, data, user_id) VALUES ($1, $2, $3, $4)`, [
        docId,
        seq,
        Buffer.from(update.buffer, update.byteOffset, update.byteLength),
        userId,
      ])
      return seq
    })
  }

  /** Number of op-log rows not yet covered by a snapshot. */
  async pendingCount(docId: string): Promise<number> {
    const r = await this.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM doc_updates WHERE document_id = $1
         AND seq > COALESCE((SELECT max(seq) FROM doc_snapshots WHERE document_id = $1), 0)`,
      [docId],
    )
    return int(r.rows[0]?.n ?? 0)
  }

  /**
   * Fold the op-log tail into a new snapshot. The snapshot is built from the database (not
   * from an in-memory replica), so it is correct no matter which instance runs it or whether
   * instances run it concurrently. With `force`, a snapshot is written even if nothing changed
   * (used for user-named versions).
   */
  async snapshot(
    docId: string,
    opts: { kind: SnapshotKind; label?: string | null; userId?: string | null; force?: boolean } = { kind: 'auto' },
  ): Promise<VersionInfo | null> {
    const { doc, seq, tail } = await this.load(docId)
    try {
      if (tail === 0 && !opts.force) return null
      const id = newId()
      const state = Y.encodeStateAsUpdate(doc)
      const r = await this.db.query<{ created_at: Date }>(
        `INSERT INTO doc_snapshots (id, document_id, seq, state, kind, label, created_by)
         SELECT $1, $2, $3, $4, $5, $6, $7 WHERE EXISTS (SELECT 1 FROM documents WHERE id = $2)
         RETURNING created_at`,
        [id, docId, seq, Buffer.from(state), opts.kind, opts.label ?? null, opts.userId ?? null],
      )
      if (!r.rows[0]) return null
      return {
        id,
        seq,
        kind: opts.kind,
        label: opts.label ?? null,
        createdAt: new Date(r.rows[0].created_at).toISOString(),
        createdBy: null,
      }
    } finally {
      doc.destroy()
    }
  }

  async listVersions(docId: string): Promise<VersionInfo[]> {
    const r = await this.db.query<any>(
      `SELECT s.id, s.seq, s.kind, s.label, s.created_at, u.id AS user_id, u.name AS user_name
         FROM doc_snapshots s LEFT JOIN users u ON u.id = s.created_by
        WHERE s.document_id = $1 ORDER BY s.seq DESC, s.created_at DESC LIMIT 200`,
      [docId],
    )
    return r.rows.map((row) => ({
      id: row.id,
      seq: int(row.seq),
      kind: row.kind,
      label: row.label,
      createdAt: new Date(row.created_at).toISOString(),
      createdBy: row.user_id ? { id: row.user_id, name: row.user_name } : null,
    }))
  }

  async versionState(docId: string, versionId: string): Promise<Uint8Array | null> {
    const r = await this.db.query<{ state: Uint8Array }>(`SELECT state FROM doc_snapshots WHERE document_id = $1 AND id = $2`, [
      docId,
      versionId,
    ])
    return r.rows[0] ? bytes(r.rows[0].state) : null
  }

  /**
   * Read a page of the op log (for time-travel replay). Returned in seq order with author info.
   * Because the log is append-only and never rewritten, replaying rows 1..n from an empty
   * document reproduces the exact state after the n-th write.
   */
  async readLog(docId: string, afterSeq: number, limit: number) {
    const r = await this.db.query<any>(
      `SELECT l.seq, l.data, l.created_at, l.user_id, u.name AS user_name, u.color AS user_color
         FROM doc_updates l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.document_id = $1 AND l.seq > $2 ORDER BY l.seq LIMIT $3`,
      [docId, afterSeq, limit],
    )
    return r.rows.map((row) => ({
      seq: int(row.seq),
      at: new Date(row.created_at).getTime(),
      userId: (row.user_id as string | null) ?? '',
      userName: (row.user_name as string | null) ?? '',
      userColor: (row.user_color as string | null) ?? '',
      data: bytes(row.data),
    }))
  }

  /** Op-log statistics, exposed for the UI / debugging. */
  async stats(docId: string) {
    const r = await this.db.query<any>(
      `SELECT (SELECT count(*) FROM doc_updates WHERE document_id = $1) AS updates,
              (SELECT coalesce(sum(octet_length(data)), 0) FROM doc_updates WHERE document_id = $1) AS update_bytes,
              (SELECT count(*) FROM doc_snapshots WHERE document_id = $1) AS snapshots`,
      [docId],
    )
    const row = r.rows[0]
    return { updates: int(row.updates), updateBytes: int(row.update_bytes), snapshots: int(row.snapshots) }
  }
}
