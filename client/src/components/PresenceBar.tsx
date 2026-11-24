import { useEffect, useState } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import { Avatar } from './common'
import { ROLE_LABEL, type Role } from '../api'

interface Present {
  id: string
  name: string
  color: string
  role?: Role
  tabs: number
}

/** Unique users currently in the document (several tabs of one user collapse into one avatar). */
export function usePresence(awareness: Awareness, selfId: string): Present[] {
  const [people, setPeople] = useState<Present[]>([])
  useEffect(() => {
    const compute = () => {
      const byUser = new Map<string, Present>()
      awareness.getStates().forEach((state, clientId) => {
        const u = state.user as { id?: string; name?: string; color?: string; role?: Role } | undefined
        if (!u?.name || clientId === awareness.clientID) return
        const id = u.id ?? String(clientId)
        const existing = byUser.get(id)
        if (existing) existing.tabs++
        else byUser.set(id, { id, name: u.name, color: u.color ?? '#64748b', role: u.role, tabs: 1 })
      })
      // Other people, plus "you" when the same account is open in another tab or device.
      setPeople([...byUser.values()])
    }
    compute()
    awareness.on('change', compute)
    return () => awareness.off('change', compute)
  }, [awareness, selfId])
  return people
}

export function PresenceBar({ awareness, selfId }: { awareness: Awareness; selfId: string }) {
  const people = usePresence(awareness, selfId)
  if (!people.length) return <span className="presence-empty muted small">Only you</span>
  const shown = people.slice(0, 5)
  return (
    <div className="presence" aria-label={`${people.length} other ${people.length === 1 ? 'person' : 'people'} here`}>
      {shown.map((p) => (
        <span key={p.id} className="presence-item" style={{ borderColor: p.color }}>
          <Avatar
            name={p.name}
            color={p.color}
            size={30}
            title={`${p.name}${p.id === selfId ? ' (you, another tab)' : ''}${p.role ? ` · ${ROLE_LABEL[p.role]}` : ''}`}
          />
        </span>
      ))}
      {people.length > shown.length && <span className="presence-more">+{people.length - shown.length}</span>}
    </div>
  )
}
