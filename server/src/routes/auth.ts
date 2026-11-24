import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import type { Ctx } from '../context.js'
import { COOKIE_NAME, findUser, requireUser, sessionCookie, signToken } from '../auth/index.js'
import { HttpError } from '../util/http.js'
import { colorFor, guestName, newId } from '../util/identity.js'

const signupSchema = z.object({
  email: z.email().max(200),
  name: z.string().trim().min(1).max(60),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
})
const loginSchema = z.object({ email: z.string().max(200), password: z.string().max(200) })
const profileSchema = z.object({ name: z.string().trim().min(1).max(60) })
const dummyHash = bcrypt.hash('not-a-real-password', 10)

export function authRouter(ctx: Ctx) {
  const r = Router()
  const { db, config } = ctx

  if (config.authRateLimit > 0) {
    r.use(
      ['/login', '/signup', '/guest'],
      rateLimit({ windowMs: 15 * 60 * 1000, limit: config.authRateLimit, standardHeaders: 'draft-8', legacyHeaders: false }),
    )
  }

  const issue = (res: import('express').Response, userId: string) => {
    const token = signToken(userId, config.jwtSecret)
    sessionCookie(res, token, config.cookieSecure)
    return token
  }

  r.post('/signup', async (req, res) => {
    const body = signupSchema.parse(req.body)
    const email = body.email.toLowerCase()
    const exists = await db.query(`SELECT 1 FROM users WHERE email = $1`, [email])
    if (exists.rows.length) throw new HttpError(409, 'An account with that email already exists', 'email_taken')
    const id = newId()
    const hash = await bcrypt.hash(body.password, 10)
    await db.query(`INSERT INTO users (id, email, name, password_hash, color) VALUES ($1, $2, $3, $4, $5)`, [
      id,
      email,
      body.name,
      hash,
      colorFor(id),
    ])
    const token = issue(res, id)
    res.status(201).json({ user: await findUser(db, id), token })
  })

  r.post('/login', async (req, res) => {
    const body = loginSchema.parse(req.body)
    const row = (
      await db.query<{ id: string; password_hash: string }>(`SELECT id, password_hash FROM users WHERE email = $1 AND NOT is_guest`, [
        body.email.toLowerCase(),
      ])
    ).rows[0]
    // Compare against a dummy hash when the user doesn't exist to keep timing uniform.
    const ok = await bcrypt.compare(body.password, row?.password_hash ?? (await dummyHash))
    if (!row || !ok) throw new HttpError(401, 'Incorrect email or password', 'bad_credentials')
    const token = issue(res, row.id)
    res.json({ user: await findUser(db, row.id), token })
  })

  /** One-click demo account: no email or password needed. */
  r.post('/guest', async (_req, res) => {
    const id = newId()
    await db.query(`INSERT INTO users (id, email, name, password_hash, color, is_guest) VALUES ($1, $2, $3, $4, $5, true)`, [
      id,
      `guest-${id}@guest.collabdocs`,
      guestName(),
      `!guest:${crypto.randomBytes(16).toString('hex')}`,
      colorFor(id),
    ])
    const token = issue(res, id)
    res.status(201).json({ user: await findUser(db, id), token })
  })

  r.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' })
    res.status(204).end()
  })

  r.get('/me', requireUser(db, config.jwtSecret), (req, res) => {
    res.json({ user: req.user })
  })

  r.patch('/me', requireUser(db, config.jwtSecret), async (req, res) => {
    const body = profileSchema.parse(req.body)
    await db.query(`UPDATE users SET name = $2 WHERE id = $1`, [req.user!.id, body.name])
    res.json({ user: await findUser(db, req.user!.id) })
  })

  return r
}
