import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const changeHighlightKey = new PluginKey<DecorationSet>('changeHighlight')

/** Meta payload: the range that changed in the new document, in the author's colour. */
export interface ChangeMeta {
  from: number
  to: number
  color: string
}

/**
 * Flashes what the latest replayed write changed: inserted text is tinted, a pure deletion
 * shows a small marker where the text used to be.
 */
export const ChangeHighlight = Extension.create({
  name: 'changeHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: changeHighlightKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(changeHighlightKey) as ChangeMeta | null | undefined
            if (meta === undefined) return set.map(tr.mapping, tr.doc)
            if (meta === null) return DecorationSet.empty
            const size = tr.doc.content.size
            const from = Math.max(0, Math.min(meta.from, size))
            const to = Math.max(from, Math.min(meta.to, size))
            if (to > from) {
              return DecorationSet.create(tr.doc, [
                Decoration.inline(from, to, { class: 'replay-change', style: `--author: ${meta.color}` }),
              ])
            }
            const marker = document.createElement('span')
            marker.className = 'replay-deletion'
            marker.style.setProperty('--author', meta.color)
            return DecorationSet.create(tr.doc, [Decoration.widget(from, marker, { side: 0 })])
          },
        },
        props: { decorations: (state) => changeHighlightKey.getState(state) },
      }),
    ]
  },
})
