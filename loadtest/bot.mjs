#!/usr/bin/env node
// Demo bot: joins a document through a share link as a guest user, shows up in presence,
// and types a few lines (if its role allows). Great for demoing collaboration solo.
//
//   node bot.mjs <share-link-or-token> [--server http://localhost:4000] [--lines 3] [--stay 15]
import { api, appendParagraph, connectDoc, sleep, textOf } from './lib.mjs'

const args = process.argv.slice(2)
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : d
}
const link = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'))
if (!link) {
  console.error('usage: node bot.mjs <share-link-or-token> [--server http://localhost:4000] [--lines 3] [--stay 15]')
  process.exit(1)
}
const base = opt('server', 'http://localhost:4000')
const wsBase = base.replace(/^http/, 'ws') + '/ws'
const token = link.split('/join/').pop()
const lines = Number(opt('lines', 3))
const stay = Number(opt('stay', 15))

const { token: auth, user } = await api(base, '/api/auth/guest', { method: 'POST' })
const { documentId, role } = await api(base, `/api/share/${token}/accept`, { method: 'POST', token: auth })
console.log(`joined as "${user.name}" with role ${role}`)

const controls = []
const client = connectDoc({
  wsBase,
  docId: documentId,
  token: auth,
  user: { name: 'ignored-by-server' },
  onControl: (c) => controls.push(c),
})
await client.ready
console.log(`synced: ${textOf(client.doc).split('\n').length} blocks`)

client.awareness.setLocalStateField('cursor', null)
for (let i = 0; i < lines; i++) {
  await sleep(700)
  appendParagraph(client.doc, `${user.name} (bot) was here - line ${i + 1}`)
}
await sleep(1500)

// Verify against the server's view by opening a second, fresh connection.
const check = connectDoc({ wsBase, docId: documentId, token: auth })
await check.ready
const persisted = textOf(check.doc).includes(`${user.name} (bot) was here`)
console.log(`bot edits visible to a fresh client: ${persisted} (expected ${role === 'editor' || role === 'owner'})`)
check.close()

const others = [...client.awareness.getStates().entries()].filter(([id]) => id !== client.doc.clientID).map(([, s]) => s.user?.name)
console.log(`others present: ${others.join(', ') || 'none'}`)
console.log(`staying ${stay}s so you can see the bot in the presence bar…`)
await sleep(stay * 1000)
client.close()
process.exit(0)
