import type { Queryable } from './db/index.js'

export type MemberRole = 'viewer' | 'commenter' | 'editor'
export type Role = MemberRole | 'owner'

const RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 }

export const MEMBER_ROLES: MemberRole[] = ['viewer', 'commenter', 'editor']

export const atLeast = (role: Role | null | undefined, min: Role) => !!role && RANK[role] >= RANK[min]
export const maxRole = <R extends Role>(a: R, b: R): R => (RANK[a] >= RANK[b] ? a : b)

export const can = {
  view: (r: Role | null) => atLeast(r, 'viewer'),
  comment: (r: Role | null) => atLeast(r, 'commenter'),
  edit: (r: Role | null) => atLeast(r, 'editor'),
  manage: (r: Role | null) => r === 'owner',
}

/** Resolve a user's effective role on a document, or null if they have no access. */
export async function resolveRole(db: Queryable, docId: string, userId: string): Promise<Role | null> {
  const r = await db.query<{ owner_id: string; role: MemberRole | null }>(
    `SELECT d.owner_id, m.role FROM documents d
       LEFT JOIN document_members m ON m.document_id = d.id AND m.user_id = $2
      WHERE d.id = $1`,
    [docId, userId],
  )
  const row = r.rows[0]
  if (!row) return null
  if (row.owner_id === userId) return 'owner'
  return row.role ?? null
}
