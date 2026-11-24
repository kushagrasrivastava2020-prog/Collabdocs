import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { api, ROLE_LABEL, type Member, type MemberRole, type Role, type ShareLink, type User } from '../api'
import { Avatar, Modal } from './common'
import { Icon } from './Icon'
import { useToast } from './Toasts'

const ROLES: MemberRole[] = ['viewer', 'commenter', 'editor']

export function ShareDialog({
  docId,
  title,
  role,
  user,
  onClose,
}: {
  docId: string
  title: string
  role: Role
  user: User
  onClose: () => void
}) {
  const toast = useToast()
  const navigate = useNavigate()
  const isOwner = role === 'owner'
  const [members, setMembers] = useState<Member[]>([])
  const [links, setLinks] = useState<ShareLink[]>([])
  const [newRole, setNewRole] = useState<MemberRole>('editor')
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .members(docId)
      .then((r) => setMembers(r.members))
      .catch((e) => toast(e.message, 'error'))
    if (isOwner)
      api
        .links(docId)
        .then((r) => setLinks(r.links))
        .catch((e) => toast(e.message, 'error'))
  }, [docId, isOwner, toast])
  useEffect(load, [load])

  const urlFor = (token: string) => `${location.origin}/join/${token}`

  const copy = async (token: string) => {
    await navigator.clipboard.writeText(urlFor(token)).catch(() => {})
    setCopied(token)
    setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500)
  }

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn()
      if (ok) toast(ok, 'success')
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <Modal title={`Share "${title}"`} onClose={onClose} wide>
      {isOwner && (
        <section className="share-section">
          <h3>Invite with a link</h3>
          <p className="muted small">Anyone who signs in with the link gets the access you choose. Revoke a link at any time.</p>
          <div className="row">
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as MemberRole)} aria-label="Link access">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              onClick={() =>
                act(async () => {
                  const { link } = await api.createLink(docId, newRole)
                  await copy(link.token)
                }, 'Link created and copied')
              }
            >
              <Icon name="link" size={15} /> Create link
            </button>
          </div>
          {links.length > 0 && (
            <ul className="link-list">
              {links.map((l) => (
                <li key={l.token}>
                  <span className={`role-badge role-${l.role}`}>{ROLE_LABEL[l.role]}</span>
                  <input readOnly value={urlFor(l.token)} onFocus={(e) => e.target.select()} aria-label="Share link" />
                  <button className="btn btn-small" onClick={() => void copy(l.token)}>
                    <Icon name={copied === l.token ? 'check' : 'copy'} size={14} /> {copied === l.token ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    className="btn btn-small btn-danger-ghost"
                    onClick={() => act(() => api.revokeLink(docId, l.token), 'Link revoked')}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="share-section">
        <h3>People with access</h3>
        <ul className="member-list">
          {members.map((m) => (
            <li key={m.user.id}>
              <Avatar name={m.user.name} color={m.user.color} size={32} />
              <div className="member-info">
                <strong>
                  {m.user.name}
                  {m.user.id === user.id ? ' (you)' : ''}
                </strong>
                {m.user.email && <span className="muted small">{m.user.email}</span>}
              </div>
              {isOwner && m.role !== 'owner' ? (
                <>
                  <select
                    value={m.role}
                    aria-label={`Access for ${m.user.name}`}
                    onChange={(e) => act(() => api.setMemberRole(docId, m.user.id, e.target.value as MemberRole))}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <button
                    className="icon-btn danger"
                    title="Remove access"
                    onClick={() => act(() => api.removeMember(docId, m.user.id), 'Access removed')}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </>
              ) : (
                <span className={`role-badge role-${m.role}`}>{ROLE_LABEL[m.role]}</span>
              )}
            </li>
          ))}
        </ul>
        {!isOwner && (
          <button
            className="btn btn-small btn-danger-ghost"
            onClick={() =>
              confirm('Leave this document? You will need a new link to get back in.') &&
              act(async () => {
                await api.removeMember(docId, user.id)
                navigate('/')
              })
            }
          >
            Leave document
          </button>
        )}
      </section>
    </Modal>
  )
}
