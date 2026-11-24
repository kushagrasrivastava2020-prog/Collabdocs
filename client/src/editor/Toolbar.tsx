import { useEditorState, type Editor } from '@tiptap/react'
import { Icon, type IconName } from '../components/Icon'

interface Props {
  editor: Editor
  canEdit: boolean
  canComment: boolean
  onComment: () => void
}

export function Toolbar({ editor, canEdit, canComment, onComment }: Props) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive('heading', { level: 1 })
        ? 'h1'
        : e.isActive('heading', { level: 2 })
          ? 'h2'
          : e.isActive('heading', { level: 3 })
            ? 'h3'
            : 'p',
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      highlight: e.isActive('highlight'),
      link: e.isActive('link'),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      taskList: e.isActive('taskList'),
      blockquote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
    }),
  })

  const chain = () => editor.chain().focus()

  const btn = (icon: IconName, label: string, active: boolean, run: () => void, shortcut?: string) => (
    <button
      type="button"
      className={`tb-btn ${active ? 'active' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      disabled={!canEdit}
    >
      <Icon name={icon} size={17} />
    </button>
  )

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = prompt('Link URL', prev ?? 'https://')
    if (url === null) return
    if (url.trim() === '') chain().extendMarkRange('link').unsetLink().run()
    else if (/^(https?:|mailto:)/i.test(url.trim())) chain().extendMarkRange('link').setLink({ href: url.trim() }).run()
    else alert('Only http(s) and mailto links are allowed.')
  }

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      {canEdit && (
        <>
          {btn('undo', 'Undo', false, () => chain().undo().run(), 'Ctrl+Z')}
          {btn('redo', 'Redo', false, () => chain().redo().run(), 'Ctrl+Shift+Z')}
          <span className="tb-sep" />
          <select
            className="tb-select"
            value={s.block}
            aria-label="Text style"
            onChange={(e) => {
              const v = e.target.value
              if (v === 'p') chain().setParagraph().run()
              else
                chain()
                  .setHeading({ level: Number(v[1]) as 1 | 2 | 3 })
                  .run()
            }}
          >
            <option value="p">Normal text</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
          </select>
          <span className="tb-sep" />
          {btn('bold', 'Bold', s.bold, () => chain().toggleBold().run(), 'Ctrl+B')}
          {btn('italic', 'Italic', s.italic, () => chain().toggleItalic().run(), 'Ctrl+I')}
          {btn('underline', 'Underline', s.underline, () => chain().toggleUnderline().run(), 'Ctrl+U')}
          {btn('strike', 'Strikethrough', s.strike, () => chain().toggleStrike().run())}
          {btn('highlight', 'Highlight', s.highlight, () => chain().toggleHighlight().run())}
          {btn('code', 'Inline code', s.code, () => chain().toggleCode().run())}
          {btn('link', 'Link', s.link, setLink)}
          <span className="tb-sep" />
          {btn('bulletList', 'Bulleted list', s.bulletList, () => chain().toggleBulletList().run())}
          {btn('orderedList', 'Numbered list', s.orderedList, () => chain().toggleOrderedList().run())}
          {btn('taskList', 'Checklist', s.taskList, () => chain().toggleTaskList().run())}
          {btn('quote', 'Quote', s.blockquote, () => chain().toggleBlockquote().run())}
          {btn('codeBlock', 'Code block', s.codeBlock, () => chain().toggleCodeBlock().run())}
          {btn('rule', 'Divider', false, () => chain().setHorizontalRule().run())}
          <span className="tb-sep" />
        </>
      )}
      {!canEdit && <span className="tb-note">{canComment ? 'You can comment on this document' : 'View only'}</span>}
      {canComment && (
        <button
          type="button"
          className="tb-btn tb-btn-text"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onComment}
          title="Comment on selection (Ctrl+Alt+M)"
        >
          <Icon name="comment" size={17} /> Comment
        </button>
      )}
    </div>
  )
}
