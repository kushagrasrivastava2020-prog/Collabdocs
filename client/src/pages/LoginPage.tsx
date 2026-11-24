import { useState, type FormEvent } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { useAuth } from '../auth'
import { Icon } from '../components/Icon'

export function LoginPage() {
  const { user, login, signup, guest } = useAuth()
  const [params] = useSearchParams()
  const next = params.get('next')?.startsWith('/') ? params.get('next')! : '/'
  const [mode, setMode] = useState<'login' | 'signup'>(params.get('mode') === 'signup' ? 'signup' : 'login')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (user) return <Navigate to={next} replace />

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(() => (mode === 'login' ? login(email, password) : signup(email, name, password)))
  }

  return (
    <div className="auth-page">
      <div className="auth-hero">
        <div className="logo logo-large">
          <span className="logo-mark">
            <Icon name="doc" size={22} />
          </span>
          <span className="logo-text">CollabDocs</span>
        </div>
        <h1>Write together, in real time.</h1>
        <ul className="feature-list">
          <li>
            <Icon name="share" /> Live cursors and presence for everyone in the document
          </li>
          <li>
            <Icon name="wifiOff" /> Keep editing offline: changes merge automatically on reconnect
          </li>
          <li>
            <Icon name="history" /> Version history with one-click restore
          </li>
          <li>
            <Icon name="comment" /> Share links with view, comment or edit access
          </li>
        </ul>
        <p className="muted small">Conflict-free merging powered by the Yjs CRDT.</p>
      </div>

      <div className="auth-card">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Sign in
          </button>
          <button
            role="tab"
            aria-selected={mode === 'signup'}
            className={mode === 'signup' ? 'active' : ''}
            onClick={() => setMode('signup')}
          >
            Create account
          </button>
        </div>
        <form onSubmit={submit} className="form">
          {mode === 'signup' && (
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'signup' ? 8 : undefined}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <div className="divider">
          <span>or</span>
        </div>
        <button className="btn btn-block" disabled={busy} onClick={() => void run(guest)}>
          Try it instantly as a guest
        </button>
      </div>
    </div>
  )
}
