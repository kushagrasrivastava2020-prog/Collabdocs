import { useEffect, useRef, type ReactNode } from 'react'
import { Link } from 'react-router'
import { initials } from '../lib/format'
import { Icon } from './Icon'
import { useAuth } from '../auth'

export function Avatar({ name, color, size = 28, title }: { name: string; color: string; size?: number; title?: string }) {
  return (
    <span className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.4 }} title={title ?? name}>
      {initials(name)}
    </span>
  )
}

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="CollabDocs home">
      <span className="logo-mark">
        <Icon name="doc" size={18} />
      </span>
      <span className="logo-text">CollabDocs</span>
    </Link>
  )
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    ref.current?.querySelector<HTMLElement>('input, select, button')?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

export function UserMenu() {
  const { user, logout } = useAuth()
  if (!user) return null
  return (
    <div className="user-menu">
      <Avatar name={user.name} color={user.color} size={30} title={`${user.name}${user.isGuest ? ' (guest)' : ''}`} />
      <span className="user-name">{user.name}</span>
      <button className="icon-btn" onClick={() => void logout()} title="Sign out" aria-label="Sign out">
        <Icon name="logout" size={17} />
      </button>
    </div>
  )
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="center-screen">
      <div className="spinner" aria-hidden="true" />
      <p className="muted">{label}</p>
    </div>
  )
}
