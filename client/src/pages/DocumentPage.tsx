import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import * as Y from 'yjs'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import {
  api,
  ApiError,
  canComment,
  canEdit,
  ROLE_LABEL,
  type Comment,
  type CommentAnchor,
  type DocMeta,
  type User,
  type Version,
} from '../api'
import { useAuth } from '../auth'
import { CollabSession } from '../lib/collab'
import { saveLabel } from '../lib/saveStatus'
import { dateTime } from '../lib/format'
import { Logo, Spinner, UserMenu } from '../components/common'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toasts'
import { PresenceBar } from '../components/PresenceBar'
import { CommentsPanel } from '../components/CommentsPanel'
import { HistoryPanel } from '../components/HistoryPanel'
import { ShareDialog } from '../components/ShareDialog'
import { ReplayView } from '../components/ReplayView'
import { Toolbar } from '../editor/Toolbar'
import { baseExtensions } from '../editor/extensions'
import { CommentHighlights, createAnchor, resolveAnchor, selectedRange, setCommentRanges } from '../editor/commentHighlights'

type Panel = 'comments' | 'history' | null

const announced = new Set<string>()

export function DocumentPage() {
  const { id } = useParams() as { id: string }
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<CollabSession | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [panel, setPanel] = useState<Panel>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [versionsTick, setVersionsTick] = useState(0)

  // 1. Document metadata (title + my role).
  useEffect(() => {
    setMeta(null)
    setError(null)
    api
      .getDoc(id)
      .then((r) => setMeta(r.document))
      .catch((e) =>
        setError(e instanceof ApiError && e.status === 404 ? "This document doesn't exist or you don't have access to it." : e.message),
      )
  }, [id])

  useEffect(() => {
    const joined = (location.state as { joined?: string } | null)?.joined
    // Once per navigation (StrictMode runs effects twice in development).
    if (joined && !announced.has(location.key)) {
      announced.add(location.key)
      toast(joined, 'success')
    }
  }, [location.key, location.state, toast])

  // 2. The collaborative session (Y.Doc + IndexedDB + WebSocket). Created once per document.
  const metaLoaded = meta !== null
  useEffect(() => {
    if (!metaLoaded) return
    const s = new CollabSession(id, canEdit(meta!.role))
    setSession(s)
    return () => {
      s.destroy()
      setSession(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, metaLoaded])

  useEffect(() => {
    if (meta) document.title = `${meta.title} - CollabDocs`
    return () => {
      document.title = 'CollabDocs'
    }
  }, [meta?.title]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadComments = useCallback(() => {
    api
      .comments(id)
      .then((r) => setComments(r.comments))
      .catch(() => {})
  }, [id])
  useEffect(() => {
    if (metaLoaded) loadComments()
  }, [metaLoaded, loadComments])

  // 3. Server-pushed control events.
  useEffect(() => {
    if (!session) return
    return session.onControl((ev) => {
      switch (ev.type) {
        case 'title':
          setMeta((m) => (m ? { ...m, title: ev.title } : m))
          break
        case 'comments':
          loadComments()
          break
        case 'versions':
          setVersionsTick((t) => t + 1)
          break
        case 'restored':
          toast(`${ev.by} restored an earlier version`, 'info')
          break
        case 'access':
          api
            .getDoc(id)
            .then((r) => {
              setMeta(r.document)
              session.setCanEdit(canEdit(r.document.role))
              toast(`Your access changed: ${ROLE_LABEL[r.document.role].toLowerCase()}`, 'info')
            })
            .catch(() => setError('Your access to this document was removed.'))
          break
        case 'deleted':
          void session.forgetLocalCopy()
          setError('This document was deleted by its owner.')
          break
      }
    })
  }, [session, id, loadComments, toast])

  const state = useSyncExternalStore(session?.subscribe ?? noopSubscribe, session?.getState ?? nullState)

  // 4. Terminal socket closes.
  useEffect(() => {
    if (!state?.fatal) return
    if (state.fatal.code === 4401) navigate(`/login?next=/d/${id}`)
    else if (state.fatal.code === 4403) setError('Your access to this document was removed.')
    else if (state.fatal.code === 4404) setError("This document doesn't exist anymore.")
  }, [state?.fatal, id, navigate])

  if (error)
    return (
      <div className="center-screen">
        <h1>Can't open document</h1>
        <p className="muted">{error}</p>
        <Link className="btn btn-primary" to="/">
          Back to documents
        </Link>
      </div>
    )
  if (!meta || !session || !user || !state) return <Spinner label="Opening document…" />

  const editable = canEdit(meta.role)
  const openComments = comments.filter((c) => !c.parentId && !c.resolved).length

  return (
    <div className="doc-page">
      <header className="doc-header">
        <Logo />
        <TitleInput meta={meta} editable={editable} onRenamed={(title) => setMeta({ ...meta, title })} />
        <SaveIndicator state={state} role={meta.role} onToggleOnline={(on) => session.setOnline(on)} />
        <div className="grow" />
        <PresenceBar awareness={session.provider.awareness} selfId={user.id} />
        <button
          className={`btn btn-ghost ${panel === 'history' ? 'active' : ''}`}
          onClick={() => setPanel(panel === 'history' ? null : 'history')}
          title="Version history"
        >
          <Icon name="history" size={17} />
          <span className="hide-sm">History</span>
        </button>
        <button
          className={`btn btn-ghost ${panel === 'comments' ? 'active' : ''}`}
          onClick={() => setPanel(panel === 'comments' ? null : 'comments')}
          title="Comments"
        >
          <Icon name="comment" size={17} />
          <span className="hide-sm">Comments</span>
          {openComments > 0 && <span className="count">{openComments}</span>}
        </button>
        <button className="btn btn-primary" onClick={() => setShareOpen(true)}>
          <Icon name="share" size={16} />
          <span className="hide-sm">Share</span>
        </button>
        <UserMenu />
      </header>

      {state.status === 'disconnected' && editable && (
        <div className="offline-banner">
          <Icon name="wifiOff" size={16} /> You're offline. Keep editing: changes are stored on this device and merge automatically when you
          reconnect.
          <button className="link-btn" onClick={() => session.setOnline(true)}>
            Reconnect now
          </button>
        </div>
      )}

      <Workspace
        key={session.docId}
        session={session}
        meta={meta}
        user={user}
        comments={comments}
        panel={panel}
        setPanel={setPanel}
        versionsTick={versionsTick}
        onCommentsChanged={loadComments}
      />

      {shareOpen && <ShareDialog docId={meta.id} title={meta.title} role={meta.role} user={user} onClose={() => setShareOpen(false)} />}
    </div>
  )
}

const noopSubscribe = () => () => {}
const nullState = () => null

function Workspace({
  session,
  meta,
  user,
  comments,
  panel,
  setPanel,
  versionsTick,
  onCommentsChanged,
}: {
  session: CollabSession
  meta: DocMeta
  user: User
  comments: Comment[]
  panel: Panel
  setPanel: (p: Panel) => void
  versionsTick: number
  onCommentsChanged: () => void
}) {
  const toast = useToast()
  const editable = canEdit(meta.role)
  const [activeComment, setActiveComment] = useState<string | null>(null)
  const [draft, setDraft] = useState<CommentAnchor | null>(null)
  const [preview, setPreview] = useState<{ version: Version; json: unknown } | null>(null)
  const [replaying, setReplaying] = useState(false)
  const [positions, setPositions] = useState<Map<string, number | null>>(new Map())
  const activateRef = useRef<(id: string) => void>(() => {})
  activateRef.current = (cid: string) => {
    setActiveComment(cid)
    setPanel('comments')
  }

  const editor = useEditor(
    {
      extensions: [
        ...baseExtensions({ collaborative: true }),
        Collaboration.configure({ document: session.doc }),
        CollaborationCaret.configure({ provider: session.provider, user: { name: user.name, color: user.color } }),
        CommentHighlights.configure({ onClickComment: (cid) => activateRef.current(cid) }),
      ],
      editable,
      editorProps: { attributes: { class: 'doc-content', spellcheck: 'true', 'aria-label': 'Document body' } },
    },
    [session],
  )

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable)
  }, [editor, editable])

  // Keep highlights + thread ordering in sync with comments and document changes.
  const topLevel = useMemo(() => comments.filter((c) => !c.parentId && c.anchor), [comments])
  useEffect(() => {
    if (!editor) return
    setCommentRanges(
      editor,
      topLevel.filter((c) => !c.resolved).map((c) => ({ id: c.id, anchor: c.anchor!, active: c.id === activeComment })),
    )
    const recompute = () => {
      const m = new Map<string, number | null>()
      for (const c of topLevel) m.set(c.id, resolveAnchor(editor.state, c.anchor!)?.from ?? null)
      setPositions(m)
    }
    recompute()
    let t: ReturnType<typeof setTimeout> | undefined
    const onUpdate = () => {
      clearTimeout(t)
      t = setTimeout(recompute, 300)
    }
    editor.on('update', onUpdate)
    return () => {
      clearTimeout(t)
      editor.off('update', onUpdate)
    }
  }, [editor, topLevel, activeComment])

  const startComment = useCallback(() => {
    if (!editor) return
    const range = selectedRange(editor)
    const anchor = range && createAnchor(editor, range.from, range.to)
    if (!anchor || !anchor.quote.trim()) {
      toast('Select some text to comment on', 'info')
      return
    }
    setDraft(anchor)
    setPanel('comments')
  }, [editor, setPanel, toast])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'm' && canComment(meta.role)) {
        e.preventDefault()
        startComment()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [startComment, meta.role])

  // Scroll the active thread's highlight into view.
  useEffect(() => {
    if (!activeComment) return
    document.querySelector(`.comment-mark[data-comment-id="${activeComment}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeComment])

  async function openPreview(v: Version | null) {
    if (!v) return setPreview(null)
    try {
      const state = await api.versionState(meta.id, v.id)
      const doc = new Y.Doc()
      Y.applyUpdate(doc, state)
      const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default'))
      doc.destroy()
      setPreview({ version: v, json })
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  async function restore(v: Version) {
    if (!confirm('Restore this version? The current content is checkpointed first, so you can undo this from history.')) return
    try {
      await api.restoreVersion(meta.id, v.id)
      setPreview(null)
      toast('Version restored', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  if (!editor) return null

  return (
    <div className="workspace">
      {!preview && !replaying && <Toolbar editor={editor} canEdit={editable} canComment={canComment(meta.role)} onComment={startComment} />}
      <div className="doc-body">
        <div className="editor-scroll">
          {replaying ? (
            <ReplayView docId={meta.id} onClose={() => setReplaying(false)} />
          ) : preview ? (
            <>
              <div className="preview-banner">
                <span>
                  <Icon name="eye" size={16} /> Viewing <strong>{preview.version.label ?? 'checkpoint'}</strong> from{' '}
                  {dateTime(preview.version.createdAt)}
                </span>
                <span className="row">
                  {editable && (
                    <button className="btn btn-primary btn-small" onClick={() => void restore(preview.version)}>
                      <Icon name="restore" size={14} /> Restore this version
                    </button>
                  )}
                  <button className="btn btn-small" onClick={() => setPreview(null)}>
                    Back to current
                  </button>
                </span>
              </div>
              <VersionPreview key={preview.version.id} json={preview.json} />
            </>
          ) : (
            <div className="page">
              <EditorContent editor={editor} />
            </div>
          )}
        </div>
        {panel === 'comments' && (
          <CommentsPanel
            docId={meta.id}
            role={meta.role}
            user={user}
            comments={comments}
            positions={positions}
            draft={draft}
            activeId={activeComment}
            onActivate={setActiveComment}
            onCancelDraft={() => setDraft(null)}
            onChanged={onCommentsChanged}
            onClose={() => setPanel(null)}
          />
        )}
        {panel === 'history' && (
          <HistoryPanel
            docId={meta.id}
            canEdit={editable}
            tick={versionsTick}
            previewId={preview?.version.id ?? null}
            onPreview={(v) => {
              setReplaying(false)
              void openPreview(v)
            }}
            onReplay={() => {
              setPreview(null)
              setReplaying(true)
            }}
            onClose={() => {
              setPanel(null)
              setPreview(null)
              setReplaying(false)
            }}
          />
        )}
      </div>
    </div>
  )
}

function VersionPreview({ json }: { json: unknown }) {
  const editor = useEditor({
    extensions: baseExtensions({ collaborative: false }),
    content: json as object,
    editable: false,
    editorProps: { attributes: { class: 'doc-content' } },
  })
  return (
    <div className="page page-preview">
      <EditorContent editor={editor as Editor} />
    </div>
  )
}

function TitleInput({ meta, editable, onRenamed }: { meta: DocMeta; editable: boolean; onRenamed: (t: string) => void }) {
  const toast = useToast()
  const [value, setValue] = useState(meta.title)
  useEffect(() => setValue(meta.title), [meta.title])
  const commit = async () => {
    const t = value.trim()
    if (!t || t === meta.title) return setValue(meta.title)
    try {
      await api.renameDoc(meta.id, t)
      onRenamed(t)
    } catch (e) {
      toast((e as Error).message, 'error')
      setValue(meta.title)
    }
  }
  return (
    <input
      className="title-input"
      value={value}
      readOnly={!editable}
      aria-label="Document title"
      maxLength={200}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setValue(meta.title)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

function SaveIndicator({
  state,
  role,
  onToggleOnline,
}: {
  state: NonNullable<ReturnType<CollabSession['getState']>>
  role: DocMeta['role']
  onToggleOnline: (online: boolean) => void
}) {
  const s = state.save
  if (s.kind === 'readonly')
    return (
      <span className={`role-badge role-${role}`} title="Your access level">
        {ROLE_LABEL[role]}
      </span>
    )
  const offline = state.status === 'disconnected'
  return (
    <span className={`save-indicator save-${s.kind}`}>
      <Icon name={offline ? 'wifiOff' : s.kind === 'saved' ? 'check' : 'cloud'} size={15} />
      <span>{saveLabel(s)}</span>
      <button
        className="link-btn tiny"
        title={offline ? 'Reconnect' : 'Simulate going offline (for testing offline edits)'}
        onClick={() => onToggleOnline(offline)}
      >
        {offline ? 'Go online' : 'Go offline'}
      </button>
    </span>
  )
}
