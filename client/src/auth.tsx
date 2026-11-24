import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError, type User } from './api'
import { clearLocalDocuments } from './lib/collab'

interface AuthValue {
  user: User | null
  loading: boolean
  login(email: string, password: string): Promise<void>
  signup(email: string, name: string, password: string): Promise<void>
  guest(): Promise<void>
  logout(): Promise<void>
  rename(name: string): Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch((e) => {
        if (!(e instanceof ApiError) || e.status !== 401) console.warn(e)
        setUser(null)
      })
      .finally(() => setLoading(false))
  }, [])

  const login = useCallback(async (email: string, password: string) => setUser((await api.login(email, password)).user), [])
  const signup = useCallback(
    async (email: string, name: string, password: string) => setUser((await api.signup(email, name, password)).user),
    [],
  )
  const guest = useCallback(async () => setUser((await api.guest()).user), [])
  const logout = useCallback(async () => {
    await api.logout().catch(() => {})
    await clearLocalDocuments()
    setUser(null)
  }, [])
  const rename = useCallback(async (name: string) => setUser((await api.updateProfile(name)).user), [])

  const value = useMemo(
    () => ({ user, loading, login, signup, guest, logout, rename }),
    [user, loading, login, signup, guest, logout, rename],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const v = useContext(AuthContext)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
