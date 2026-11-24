import * as Y from 'yjs'
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap'
import type { CommentAnchor } from '../api'
import { fromBase64, toBase64 } from '../lib/format'

/**
 * Comments are anchored with Yjs *relative positions* (an item id inside the CRDT rather than
 * an integer offset), so a highlight stays attached to the same characters no matter how many
 * concurrent edits happen before it.
 */

export interface CommentRange {
  id: string
  anchor: CommentAnchor
  active: boolean
}

export const commentsPluginKey = new PluginKey<DecorationSet>('commentHighlights')

function syncState(state: EditorState) {
  const ys = ySyncPluginKey.getState(state)
  return ys?.binding ? ys : null
}

export function resolveAnchor(state: EditorState, anchor: CommentAnchor): { from: number; to: number } | null {
  const ys = syncState(state)
  if (!ys) return null
  try {
    const from = relativePositionToAbsolutePosition(ys.doc, ys.type, Y.decodeRelativePosition(fromBase64(anchor.from)), ys.binding.mapping)
    const to = relativePositionToAbsolutePosition(ys.doc, ys.type, Y.decodeRelativePosition(fromBase64(anchor.to)), ys.binding.mapping)
    if (from == null || to == null || to <= from) return null
    return { from, to }
  } catch {
    return null
  }
}

export function createAnchor(editor: Editor, from: number, to: number): CommentAnchor | null {
  const ys = syncState(editor.state)
  if (!ys || to <= from) return null
  const rel = (pos: number) => toBase64(Y.encodeRelativePosition(absolutePositionToRelativePosition(pos, ys.type, ys.binding.mapping)))
  return { from: rel(from), to: rel(to), quote: editor.state.doc.textBetween(from, to, ' ').slice(0, 300) }
}

/**
 * The text the user selected. Read-only editors (viewers / commenters) are not contenteditable,
 * so fall back to the DOM selection and map it into the document.
 */
export function selectedRange(editor: Editor): { from: number; to: number } | null {
  const { from, to } = editor.state.selection
  if (to > from) return { from, to }
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  const dom = editor.view.dom
  if (!dom.contains(range.startContainer) || !dom.contains(range.endContainer)) return null
  try {
    const a = editor.view.posAtDOM(range.startContainer, range.startOffset)
    const b = editor.view.posAtDOM(range.endContainer, range.endOffset)
    return a < b ? { from: a, to: b } : b < a ? { from: b, to: a } : null
  } catch {
    return null
  }
}

function build(state: EditorState, ranges: CommentRange[]): DecorationSet {
  const decos: Decoration[] = []
  for (const r of ranges) {
    const pos = resolveAnchor(state, r.anchor)
    if (!pos) continue
    decos.push(
      Decoration.inline(pos.from, pos.to, {
        class: r.active ? 'comment-mark comment-mark-active' : 'comment-mark',
        'data-comment-id': r.id,
      }),
    )
  }
  return DecorationSet.create(state.doc, decos)
}

export const CommentHighlights = Extension.create<{ onClickComment: (id: string) => void }, { ranges: CommentRange[] }>({
  name: 'commentHighlights',

  addOptions() {
    return { onClickComment: () => {} }
  },

  addStorage() {
    return { ranges: [] }
  },

  addProseMirrorPlugins() {
    const storage = this.storage
    const options = this.options
    return [
      new Plugin<DecorationSet>({
        key: commentsPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set, _old, state) {
            // Remote changes (and the initial render) rebuild the mapping: resolve anchors again.
            if (tr.getMeta(commentsPluginKey) || tr.getMeta(ySyncPluginKey)) return build(state, storage.ranges)
            return tr.docChanged ? set.map(tr.mapping, tr.doc) : set
          },
        },
        props: {
          decorations: (state) => commentsPluginKey.getState(state),
          handleClick: (_view, _pos, event) => {
            const el = (event.target as HTMLElement).closest?.('[data-comment-id]')
            if (el) options.onClickComment(el.getAttribute('data-comment-id')!)
            return false
          },
        },
      }),
    ]
  },
})

/** Push a new set of comment ranges into the editor and redraw highlights. */
export function setCommentRanges(editor: Editor, ranges: CommentRange[]) {
  const storage = (editor.storage as unknown as Record<string, { ranges: CommentRange[] }>).commentHighlights
  if (!storage) return
  storage.ranges = ranges
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(commentsPluginKey, true))
}
