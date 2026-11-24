import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, ROLE_LABEL, type DocMeta } from '../api'
import { useAuth } from '../auth'
import { Logo, UserMenu } from '../components/common'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toasts'
import { timeAgo } from '../lib/format'

export function DashboardPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const [docs, setDocs] = useState<{ owned: DocMeta[]; shared: DocMeta[] } | null>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(() => {
    api
      .listDocs()
      .then(setDocs)
      .catch((e) => toast(e.message, 'error'))
  }, [toast])
  useEffect(load, [load])

  async function create() {
    setCreating(true)
    try {
      const { document } = await api.createDoc()
      navigate(`/d/${document.id}`)
    } catch (e) {
      toast((e as Error).message, 'error')
      setCreating(false)
    }
  }

  async function rename(doc: DocMeta) {
    const title = prompt('Rename document', doc.title)?.trim()
    if (!title || title === doc.title) return
    await api.renameDoc(doc.id, title).catch((e) => toast(e.message, 'error'))
    load()
  }

  async function remove(doc: DocMeta) {
    if (!confirm(`Delete "${doc.title}" for everyone? This cannot be undone.`)) return
    await api.deleteDoc(doc.id).catch((e) => toast(e.message, 'error'))
    toast('Document deleted', 'success')
    load()
  }

  async function leave(doc: DocMeta) {
    if (!confirm(`Remove "${doc.title}" from your documents? You will need a new link to get back in.`)) return
    await api.removeMember(doc.id, user!.id).catch((e) => toast(e.message, 'error'))
    load()
  }

  const filter = (list: DocMeta[]) => list.filter((d) => d.title.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div className="app-shell">
      <header className="topbar">
        <Logo />
        <div className="search">
          <Icon name="search" size={16} />
          <input placeholder="Search documents" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search documents" />
        </div>
        <UserMenu />
      </header>

      <main className="dashboard">
        {user?.isGuest && (
          <div className="banner">
            You're using a guest account. Documents are kept, but you can't sign back in after signing out.{' '}
            <Link to="/login?mode=signup">Create a real account</Link> to keep access.
          </div>
        )}
        <div className="dashboard-head">
          <h1>Documents</h1>
          <button className="btn btn-primary" onClick={() => void create()} disabled={creating}>
            <Icon name="plus" size={16} /> New document
          </button>
        </div>

        {!docs ? (
          <div className="doc-grid">
            {[0, 1, 2].map((i) => (
              <div key={i} className="doc-card skeleton" />
            ))}
          </div>
        ) : (
          <>
            <DocSection
              title="My documents"
              docs={filter(docs.owned)}
              empty={
                <div className="empty">
                  <p>No documents yet.</p>
                  <button className="btn btn-primary" onClick={() => void create()}>
                    Create your first document
                  </button>
                </div>
              }
              actions={(d) => (
                <>
                  <button className="icon-btn" title="Rename" onClick={() => void rename(d)}>
                    <Icon name="pencil" size={15} />
                  </button>
                  <button className="icon-btn danger" title="Delete" onClick={() => void remove(d)}>
                    <Icon name="trash" size={15} />
                  </button>
                </>
              )}
            />
            <DocSection
              title="Shared with me"
              docs={filter(docs.shared)}
              empty={<p className="muted">When someone shares a document with you, it shows up here.</p>}
              actions={(d) => (
                <button className="icon-btn" title="Remove from my documents" onClick={() => void leave(d)}>
                  <Icon name="x" size={15} />
                </button>
              )}
            />
          </>
        )}
      </main>
    </div>
  )
}

function DocSection({
  title,
  docs,
  empty,
  actions,
}: {
  title: string
  docs: DocMeta[]
  empty: React.ReactNode
  actions: (d: DocMeta) => React.ReactNode
}) {
  return (
    <section className="doc-section">
      <h2>{title}</h2>
      {docs.length === 0 ? (
        empty
      ) : (
        <div className="doc-grid">
          {docs.map((d) => (
            <div key={d.id} className="doc-card">
              <Link to={`/d/${d.id}`} className="doc-card-link">
                <div className="doc-thumb">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <div className="doc-card-title">{d.title}</div>
                <div className="doc-card-meta">
                  {d.role === 'owner' ? 'You' : d.owner.name} · edited {timeAgo(d.updatedAt)}
                </div>
              </Link>
              <div className="doc-card-foot">
                <span className={`role-badge role-${d.role}`}>{ROLE_LABEL[d.role]}</span>
                <div className="doc-card-actions">{actions(d)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
