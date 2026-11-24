export type Role = 'owner' | 'editor' | 'commenter' | 'viewer'
export type MemberRole = Exclude<Role, 'owner'>

export interface User {
  id: string
  email: string
  name: string
  color: string
  isGuest: boolean
}

export interface DocMeta {
  id: string
  title: string
  role: Role
  owner: { id: string; name: string }
  createdAt: string
  updatedAt: string
}

export interface Member {
  user: { id: string; name: string; email: string | null; color: string }
  role: Role
}

export interface ShareLink {
  token: string
  role: MemberRole
  createdAt: string
}

export interface Version {
  id: string
  seq: number
  kind: 'auto' | 'manual' | 'restore'
  label: string | null
  createdAt: string
  createdBy: { id: string; name: string } | null
}

export interface CommentAnchor {
  from: string
  to: string
  quote: string
}

export interface Comment {
  id: string
  parentId: string | null
  body: string
  anchor: CommentAnchor | null
  resolved: boolean
  createdAt: string
  author: { id: string; name: string; color: string } | null
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'Network error - are you offline?', 'network')
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.code)
  return data as T
}

export const api = {
  // auth
  me: () => request<{ user: User }>('GET', '/api/auth/me'),
  login: (email: string, password: string) => request<{ user: User }>('POST', '/api/auth/login', { email, password }),
  signup: (email: string, name: string, password: string) => request<{ user: User }>('POST', '/api/auth/signup', { email, name, password }),
  guest: () => request<{ user: User }>('POST', '/api/auth/guest'),
  logout: () => request<void>('POST', '/api/auth/logout'),
  updateProfile: (name: string) => request<{ user: User }>('PATCH', '/api/auth/me', { name }),

  // documents
  listDocs: () => request<{ owned: DocMeta[]; shared: DocMeta[] }>('GET', '/api/docs'),
  createDoc: (title?: string) => request<{ document: DocMeta }>('POST', '/api/docs', title ? { title } : {}),
  getDoc: (id: string) => request<{ document: DocMeta }>('GET', `/api/docs/${id}`),
  renameDoc: (id: string, title: string) => request<{ title: string }>('PATCH', `/api/docs/${id}`, { title }),
  deleteDoc: (id: string) => request<void>('DELETE', `/api/docs/${id}`),
  docStats: (id: string) => request<{ updates: number; updateBytes: number; snapshots: number }>('GET', `/api/docs/${id}/stats`),

  // sharing
  members: (id: string) => request<{ members: Member[] }>('GET', `/api/docs/${id}/members`),
  setMemberRole: (id: string, userId: string, role: MemberRole) => request<void>('PATCH', `/api/docs/${id}/members/${userId}`, { role }),
  removeMember: (id: string, userId: string) => request<void>('DELETE', `/api/docs/${id}/members/${userId}`),
  links: (id: string) => request<{ links: ShareLink[] }>('GET', `/api/docs/${id}/links`),
  createLink: (id: string, role: MemberRole) => request<{ link: ShareLink }>('POST', `/api/docs/${id}/links`, { role }),
  revokeLink: (id: string, token: string) => request<void>('DELETE', `/api/docs/${id}/links/${token}`),
  previewShare: (token: string) =>
    request<{ document: { id: string; title: string; owner: { name: string } }; role: MemberRole; currentRole: Role | null }>(
      'GET',
      `/api/share/${token}`,
    ),
  acceptShare: (token: string) => request<{ documentId: string; role: Role }>('POST', `/api/share/${token}/accept`),

  // versions
  versions: (id: string) => request<{ versions: Version[] }>('GET', `/api/docs/${id}/versions`),
  saveVersion: (id: string, label: string) => request<{ version: Version }>('POST', `/api/docs/${id}/versions`, { label }),
  restoreVersion: (id: string, vid: string) => request<{ version: Version }>('POST', `/api/docs/${id}/versions/${vid}/restore`),
  versionState: async (id: string, vid: string): Promise<Uint8Array> => {
    const res = await fetch(`/api/docs/${id}/versions/${vid}/state`, { credentials: 'same-origin' })
    if (!res.ok) throw new ApiError(res.status, 'Could not load version')
    return new Uint8Array(await res.arrayBuffer())
  },

  // comments
  comments: (id: string) => request<{ comments: Comment[] }>('GET', `/api/docs/${id}/comments`),
  addComment: (id: string, body: string, anchor: CommentAnchor | null, parentId?: string) =>
    request<{ comment: Comment }>('POST', `/api/docs/${id}/comments`, { body, anchor, parentId }),
  updateComment: (id: string, cid: string, patch: { body?: string; resolved?: boolean }) =>
    request<void>('PATCH', `/api/docs/${id}/comments/${cid}`, patch),
  deleteComment: (id: string, cid: string) => request<void>('DELETE', `/api/docs/${id}/comments/${cid}`),
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  editor: 'Can edit',
  commenter: 'Can comment',
  viewer: 'Can view',
}

export const canEdit = (r: Role | null | undefined) => r === 'owner' || r === 'editor'
export const canComment = (r: Role | null | undefined) => canEdit(r) || r === 'commenter'
