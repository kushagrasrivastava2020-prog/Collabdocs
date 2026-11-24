#!/usr/bin/env node
// Seed two demo accounts and a shared document, handy for trying collaboration locally.
//   node seed.mjs [--server http://localhost:4000]
// Demo credentials (local development only):
//   ada@collabdocs.test   / demo-password-1   (owner)
//   grace@collabdocs.test / demo-password-2   (editor via share link)
import { api } from './lib.mjs'

const i = process.argv.indexOf('--server')
const base = i >= 0 ? process.argv[i + 1] : 'http://localhost:4000'

const ACCOUNTS = [
  { email: 'ada@collabdocs.test', name: 'Ada Lovelace', password: 'demo-password-1' },
  { email: 'grace@collabdocs.test', name: 'Grace Hopper', password: 'demo-password-2' },
]

async function session(a) {
  try {
    return await api(base, '/api/auth/signup', { method: 'POST', body: a })
  } catch {
    return api(base, '/api/auth/login', { method: 'POST', body: { email: a.email, password: a.password } })
  }
}

const [ada, grace] = await Promise.all(ACCOUNTS.map(session))
const { document } = await api(base, '/api/docs', { method: 'POST', token: ada.token, body: { title: 'Welcome to CollabDocs' } })
const { link } = await api(base, `/api/docs/${document.id}/links`, { method: 'POST', token: ada.token, body: { role: 'editor' } })
await api(base, `/api/share/${link.token}/accept`, { method: 'POST', token: grace.token })
console.log(`Seeded "${document.title}" (${document.id}) owned by ${ada.user.name}, shared with ${grace.user.name} as editor.`)
console.log('Sign in with the accounts listed at the top of loadtest/seed.mjs.')
