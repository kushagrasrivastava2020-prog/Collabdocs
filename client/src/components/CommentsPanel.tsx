import { useMemo, useState, type FormEvent } from 'react'
import { api, canComment as roleCanComment, type Comment, type CommentAnchor, type Role, type User } from '../api'
import { timeAgo } from '../lib/format'
import { Avatar } from './common'
import { Icon } from './Icon'
import { useToast } from './Toasts'

interface Props {
  docId: string
  role: Role
  user: User
  comments: Comment[]
  /** Document position of each thread's anchor (null = its text was deleted). */
  positions: Map<string, number | null>
  draft: CommentAnchor | null
  activeId: string | null
  onActivate: (id: string | null) => void
  onCancelDraft: () => void
  onChanged: () => void
  onClose: () => void
}

export function CommentsPanel(p: Props) {
  const toast = useToast()
  const [showResolved, setShowResolved] = useState(false)
  const canComment = roleCanComment(p.role)

  const { threads, replies, resolvedCount } = useMemo(() => {
    const top = p.comments.filter((c) => !c.parentId)
    const replies = new Map<string, Comment[]>()
    for (const c of p.comments) if (c.parentId) replies.set(c.parentId, [...(replies.get(c.parentId) ?? []), c])
    const pos = (c: Comment) => p.positions.get(c.id) ?? Number.MAX_SAFE_INTEGER
    const threads = top.filter((c) => showResolved || !c.resolved).sort((a, b) => pos(a) - pos(b) || a.createdAt.localeCompare(b.createdAt))
    return { threads, replies, resolvedCount: top.filter((c) => c.resolved).length }
  }, [p.comments, p.positions, showResolved])

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      p.onChanged()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <aside className="side-panel" aria-label="Comments">
      <div className="side-head">
        <h2>Comments</h2>
        <button className="icon-btn" onClick={p.onClose} aria-label="Close comments">
          <Icon name="x" />
        </button>
      </div>

      {p.draft && (
        <Composer
          quote={p.draft.quote}
          placeholder="Add a comment…"
          onCancel={p.onCancelDraft}
          onSubmit={(body) =>
            run(async () => {
              const { comment } = await api.addComment(p.docId, body, p.draft)
              p.onCancelDraft()
              p.onActivate(comment.id)
            })
          }
        />
      )}

      {threads.length === 0 && !p.draft && (
        <div className="side-empty">
          <Icon name="comment" size={28} />
          <p>No {showResolved ? '' : 'open '}comments.</p>
          {canComment && <p className="muted small">Select text in the document and press Comment.</p>}
        </div>
      )}

      <div className="threads">
        {threads.map((t) => {
          const orphaned = p.positions.get(t.id) === null
          const canDelete = t.author?.id === p.user.id || p.role === 'owner'
          return (
            <div
              key={t.id}
              className={`thread ${p.activeId === t.id ? 'active' : ''} ${t.resolved ? 'resolved' : ''}`}
              onClick={() => p.onActivate(t.id)}
            >
              {t.anchor && (
                <blockquote className={`thread-quote ${orphaned ? 'orphaned' : ''}`}>
                  {orphaned ? `"${t.anchor.quote}" (text was removed)` : t.anchor.quote}
                </blockquote>
              )}
              <CommentItem c={t} />
              {(replies.get(t.id) ?? []).map((r) => (
                <CommentItem
                  key={r.id}
                  c={r}
                  reply
                  onDelete={
                    r.author?.id === p.user.id || p.role === 'owner' ? () => run(() => api.deleteComment(p.docId, r.id)) : undefined
                  }
                />
              ))}
              <div className="thread-actions">
                {canComment && (
                  <button
                    className="link-btn"
                    onClick={(e) => (e.stopPropagation(), run(() => api.updateComment(p.docId, t.id, { resolved: !t.resolved })))}
                  >
                    <Icon name={t.resolved ? 'restore' : 'check'} size={14} /> {t.resolved ? 'Reopen' : 'Resolve'}
                  </button>
                )}
                {canDelete && (
                  <button
                    className="link-btn danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirm('Delete this comment thread?')) void run(() => api.deleteComment(p.docId, t.id))
                    }}
                  >
                    <Icon name="trash" size={14} /> Delete
                  </button>
                )}
              </div>
              {canComment && p.activeId === t.id && !t.resolved && (
                <Composer compact placeholder="Reply…" onSubmit={(body) => run(() => api.addComment(p.docId, body, null, t.id))} />
              )}
            </div>
          )
        })}
      </div>

      {resolvedCount > 0 && (
        <button className="link-btn side-foot" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? 'Hide' : 'Show'} resolved ({resolvedCount})
        </button>
      )}
    </aside>
  )
}

function CommentItem({ c, reply, onDelete }: { c: Comment; reply?: boolean; onDelete?: () => void }) {
  return (
    <div className={`comment ${reply ? 'comment-reply' : ''}`}>
      <div className="comment-head">
        <Avatar name={c.author?.name ?? 'Deleted user'} color={c.author?.color ?? '#94a3b8'} size={24} />
        <strong>{c.author?.name ?? 'Deleted user'}</strong>
        <span className="muted small">{timeAgo(c.createdAt)}</span>
        {onDelete && (
          <button className="icon-btn tiny" title="Delete reply" onClick={(e) => (e.stopPropagation(), onDelete())}>
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      <p className="comment-body">{c.body}</p>
    </div>
  )
}

function Composer({
  quote,
  placeholder,
  compact,
  onSubmit,
  onCancel,
}: {
  quote?: string
  placeholder: string
  compact?: boolean
  onSubmit: (body: string) => Promise<void>
  onCancel?: () => void
}) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!body.trim()) return
    setBusy(true)
    await onSubmit(body.trim())
    setBusy(false)
    setBody('')
  }
  return (
    <form className={`composer ${compact ? 'compact' : ''}`} onSubmit={submit} onClick={(e) => e.stopPropagation()}>
      {quote && <blockquote className="thread-quote">{quote}</blockquote>}
      <textarea
        autoFocus={!compact}
        value={body}
        placeholder={placeholder}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e)
          if (e.key === 'Escape') onCancel?.()
        }}
        rows={compact ? 1 : 3}
        maxLength={5000}
      />
      <div className="composer-actions">
        {onCancel && (
          <button type="button" className="btn btn-small" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn-primary btn-small" disabled={busy || !body.trim()}>
          {compact ? 'Reply' : 'Comment'}
        </button>
      </div>
    </form>
  )
}
