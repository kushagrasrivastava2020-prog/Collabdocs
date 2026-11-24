import type { IncomingMessage } from 'node:http'
import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import type { Queryable } from '../db/index.js'
import { HttpError } from '../util/http.js'

export const COOKIE_NAME = 'cd_session'
const TOKEN_TTL_SECONDS = 7 * 24 * 3600

export interface AuthUser {
  id: string
  email: string
  name: string
  color: string
  isGuest: boolean
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}

export function signToken(userId: string, secret: string): string {
  return jwt.sign({ sub: userId }, secret, { expiresIn: TOKEN_TTL_SECONDS, algorithm: 'HS256' })
}

export function verifyToken(token: string, secret: string): string | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] })
    return typeof payload === 'object' && typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

/**
 * Browsers authenticate with an httpOnly cookie (sent automatically on the WebSocket upgrade
 * too). Scripts - tests, the load generator - may use `Authorization: Bearer` or `?token=`.
 */
export function tokenFromRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME]
  if (cookie) return cookie
  const url = new URL(req.url ?? '/', 'http://x')
  return url.searchParams.get('token')
}

export async function findUser(db: Queryable, id: string): Promise<AuthUser | null> {
  const r = await db.query<any>(`SELECT id, email, name, color, is_guest FROM users WHERE id = $1`, [id])
  const u = r.rows[0]
  return u ? { id: u.id, email: u.email, name: u.name, color: u.color, isGuest: u.is_guest } : null
}

export async function authenticate(db: Queryable, req: IncomingMessage, secret: string): Promise<AuthUser | null> {
  const token = tokenFromRequest(req)
  if (!token) return null
  const id = verifyToken(token, secret)
  return id ? findUser(db, id) : null
}

export function sessionCookie(res: Response, token: string, secure: boolean) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: '/',
  })
}

export function requireUser(db: Queryable, secret: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const user = await authenticate(db, req, secret)
    if (!user) return next(new HttpError(401, 'Please sign in', 'unauthenticated'))
    req.user = user
    next()
  }
}
