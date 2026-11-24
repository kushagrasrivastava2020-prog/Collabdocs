import { useEffect, useState } from 'react'
import { api, type Version } from '../api'
import { dateTime, timeAgo } from '../lib/format'
import { Icon } from './Icon'
import { useToast } from './Toasts'

interface Props {
  docId: string
  canEdit: boolean
  /** Bumped when the server announces new versions. */
  tick: number
  previewId: string | null
  onPreview: (v: Version | null) => void
  onReplay: () => void
  onClose: () => void
}

const KIND_LABEL = { auto: 'Autosave checkpoint', manual: 'Named version', restore: 'Restore' }

export function HistoryPanel({ docId, canEdit, tick, previewId, onPreview, onReplay, onClose }: Props) {
  const toast = useToast()
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [onlyNamed, setOnlyNamed] = useState(false)
  const [stats, setStats] = useState<{ updates: number; updateBytes: number; snapshots: number } | null>(null)

  useEffect(() => {
    api
      .versions(docId)
      .then((r) => setVersions(r.versions))
      .catch((e) => toast(e.message, 'error'))
    api
      .docStats(docId)
      .then(setStats)
      .catch(() => {})
  }, [docId, tick, toast])

  async function nameVersion() {
    const label = prompt('Name this version', `Version ${new Date().toLocaleDateString()}`)?.trim()
    if (!label) return
    try {
      const { version } = await api.saveVersion(docId, label)
      setVersions((vs) => [version, ...(vs ?? [])])
      toast('Version saved', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const list = (versions ?? []).filter((v) => !onlyNamed || v.kind !== 'auto')

  return (
    <aside className="side-panel" aria-label="Version history">
      <div className="side-head">
        <h2>Version history</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close history">
          <Icon name="x" />
        </button>
      </div>
      <button className="replay-cta" onClick={onReplay}>
        <Icon name="history" size={18} />
        <span>
          <strong>Replay editing history</strong>
          <span className="muted small">Scrub through every write in the op log</span>
        </span>
      </button>
      <div className="side-tools">
        {canEdit && (
          <button className="btn btn-small" onClick={() => void nameVersion()}>
            <Icon name="bookmark" size={14} /> Name current version
          </button>
        )}
        <label className="checkbox small">
          <input type="checkbox" checked={onlyNamed} onChange={(e) => setOnlyNamed(e.target.checked)} /> Named only
        </label>
      </div>

      <button className={`version ${previewId === null ? 'active' : ''}`} onClick={() => onPreview(null)}>
        <span className="version-title">Current version</span>
        <span className="muted small">Live</span>
      </button>
      {!versions && <p className="muted small pad">Loading…</p>}
      {versions && list.length === 0 && (
        <p className="muted small pad">No saved versions yet. Checkpoints are created automatically as you edit.</p>
      )}
      <div className="versions">
        {list.map((v) => (
          <button key={v.id} className={`version kind-${v.kind} ${previewId === v.id ? 'active' : ''}`} onClick={() => onPreview(v)}>
            <span className="version-title">{v.label ?? KIND_LABEL[v.kind]}</span>
            <span className="muted small" title={dateTime(v.createdAt)}>
              {dateTime(v.createdAt)} · {timeAgo(v.createdAt)}
              {v.createdBy ? ` · ${v.createdBy.name}` : ''}
            </span>
          </button>
        ))}
      </div>
      {stats && (
        <p className="side-foot muted small" title="Append-only Yjs op log + compacted snapshots">
          Op log: {stats.updates} updates ({(stats.updateBytes / 1024).toFixed(1)} KB) · {stats.snapshots} snapshots
        </p>
      )}
    </aside>
  )
}
