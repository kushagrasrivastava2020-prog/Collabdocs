import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Highlight from '@tiptap/extension-highlight'

/** Schema shared by the live editor and the read-only version preview. */
export function baseExtensions({ collaborative }: { collaborative: boolean }) {
  return [
    StarterKit.configure({
      // Yjs provides undo/redo (scoped to the local user's own changes) when collaborating.
      undoRedo: collaborative ? false : undefined,
      // TrailingNode makes *every client* append an empty paragraph whenever the last block isn't
      // one. In a shared document those appends race, pile up, and create indistinguishable empty
      // paragraphs that the ProseMirror<->Yjs diff can map to the wrong CRDT element under
      // concurrent edits. Never auto-insert content from N clients at once.
      trailingNode: collaborative ? false : undefined,
      link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'] },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Highlight,
    Placeholder.configure({ placeholder: 'Start typing… everyone here sees it as you write.' }),
  ]
}
