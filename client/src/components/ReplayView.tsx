import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import { baseExtensions } from '../editor/extensions'
import { ChangeHighlight, changeHighlightKey, type ChangeMeta } from '../editor/changeHighlight'
import { fetchOpLog, LogPlayer, type LogEntry } from '../lib/oplog'
import { Avatar } from './common'
import { Icon } from './Icon'

const SPEEDS = [1, 4, 16, 64]

/**
 * Time-travel: scrub or play through every write in the document's append-only op log.
 * Each step re-materialises the CRDT at that point and highlights what changed, in the
 * author's colour.
 */
export function ReplayView({ docId, onClose }: { docId: string; onClose: () => void }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null)
  const [loaded, setLoaded] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(4)
  const player = useRef<LogPlayer | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  const editor = useEditor({
    extensions: [...baseExtensions({ collaborative: false }), ChangeHighlight],
    editable: false,
    editorProps: { attributes: { class: 'doc-content' } },
  })

  useEffect(() => {
    let cancelled = false
    fetchOpLog(docId, setLoaded)
      .then((e) => {
        if (cancelled) return
        player.current = new LogPlayer(e)
        setEntries(e)
        setIndex(e.length)
      })
      .catch((err) => !cancelled && setError((err as Error).message))
    return () => {
      cancelled = true
      player.current?.destroy()
    }
  }, [docId])

  // Render the document as of `index`, highlighting the latest step's change.
  useEffect(() => {
    if (!editor || !entries || !player.current) return
    const toNode = (n: number) => {
      const json = yXmlFragmentToProsemirrorJSON(player.current!.seek(n).getXmlFragment('default'))
      return editor.schema.nodeFromJSON(json.content?.length ? json : { type: 'doc', content: [{ type: 'paragraph' }] })
    }
    // Highlight what *this write* changed: diff state n-1 against state n (one extra step forward).
    const before = index > 0 ? toNode(index - 1) : null
    const next = toNode(index)
    const start = before?.content.findDiffStart(next.content)
    const end = before?.content.findDiffEnd(next.content)
    const author = entries[index - 1]
    const meta: ChangeMeta | null =
      start != null && end && author ? { from: start, to: Math.max(start, end.b), color: author.userColor || '#4f46e5' } : null
    const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, next.content).setMeta(changeHighlightKey, meta)
    tr.setMeta('addToHistory', false)
    editor.view.dispatch(tr)
    if (meta) {
      requestAnimationFrame(() =>
        document.querySelector('.replay-change, .replay-deletion')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
      )
    }
  }, [editor, entries, index])

  // Playback loop.
  useEffect(() => {
    if (!playing || !entries) return
    const t = setInterval(
      () => {
        setIndex((i) => {
          if (i >= entries.length) {
            setPlaying(false)
            return i
          }
          return Math.min(entries.length, i + Math.max(1, Math.round(speed / 4)))
        })
      },
      Math.max(16, 250 / speed),
    )
    return () => clearInterval(t)
  }, [playing, speed, entries])

  // Author-coloured timeline strip (one sliver per write).
  useEffect(() => {
    const c = canvas.current
    if (!c || !entries?.length) return
    const w = (c.width = c.clientWidth * devicePixelRatio)
    const h = (c.height = c.clientHeight * devicePixelRatio)
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    entries.forEach((e, i) => {
      ctx.fillStyle = e.userColor || '#94a3b8'
      ctx.fillRect(Math.floor((i / entries.length) * w), 0, Math.max(1, Math.ceil(w / entries.length)), h)
    })
  }, [entries])

  const authors = useMemo(() => {
    const m = new Map<string, { name: string; color: string; writes: number }>()
    for (const e of entries ?? []) {
      const key = e.userId || 'system'
      const a = m.get(key) ?? { name: e.userName || 'System (restore / recovery)', color: e.userColor || '#94a3b8', writes: 0 }
      a.writes++
      m.set(key, a)
    }
    return [...m.values()].sort((a, b) => b.writes - a.writes)
  }, [entries])

  const step = useCallback(
    (d: number) => {
      setPlaying(false)
      setIndex((i) => Math.max(0, Math.min(entries?.length ?? 0, i + d)))
    },
    [entries],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === ' ') {
        e.preventDefault()
        setPlaying((p) => !p)
      } else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, onClose])

  if (error) return <div className="preview-banner">{error}</div>
  const current = entries && index > 0 ? entries[index - 1] : null

  return (
    <>
      <div className="replay-bar">
        <div className="replay-row">
          <span className="replay-title">
            <Icon name="history" size={16} /> Time travel
          </span>
          {entries ? (
            <span className="muted small">{entries.length} writes from the append-only op log · ← → to step, space to play</span>
          ) : (
            <span className="muted small">Loading op log… {loaded > 0 && `${loaded} writes`}</span>
          )}
          <span className="grow" />
          <button className="btn btn-small" onClick={onClose}>
            Back to live document
          </button>
        </div>
        {entries && (
          <>
            <div className="replay-row">
              <button className="icon-btn" onClick={() => step(-1)} title="Previous write (←)" aria-label="Previous write">
                <Icon name="arrowLeft" size={16} />
              </button>
              <button
                className="btn btn-primary btn-small replay-play"
                onClick={() => {
                  if (index >= entries.length) setIndex(0)
                  setPlaying((p) => !p)
                }}
              >
                {playing ? 'Pause' : index >= entries.length ? 'Replay from start' : 'Play'}
              </button>
              <button className="icon-btn flip" onClick={() => step(1)} title="Next write (→)" aria-label="Next write">
                <Icon name="arrowLeft" size={16} />
              </button>
              <div className="replay-track">
                <canvas ref={canvas} className="replay-timeline" aria-hidden="true" />
                <input
                  type="range"
                  min={0}
                  max={entries.length}
                  value={index}
                  onChange={(e) => {
                    setPlaying(false)
                    setIndex(Number(e.target.value))
                  }}
                  aria-label="Position in history"
                />
              </div>
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed" className="tb-select">
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </div>
            <div className="replay-row small">
              <span className="replay-pos">
                Write <strong>{index}</strong> / {entries.length}
              </span>
              {current ? (
                <span className="replay-author">
                  <Avatar name={current.userName || 'System'} color={current.userColor || '#94a3b8'} size={20} />
                  {current.userName || 'System'} ·{' '}
                  {new Date(current.at).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              ) : (
                <span className="muted">Empty document</span>
              )}
              <span className="grow" />
              {authors.map((a) => (
                <span key={a.name} className="replay-legend" title={`${a.writes} writes`}>
                  <i style={{ background: a.color }} />
                  {a.name} <span className="muted">{a.writes}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="page page-preview">
        <EditorContent editor={editor} />
      </div>
    </>
  )
}
