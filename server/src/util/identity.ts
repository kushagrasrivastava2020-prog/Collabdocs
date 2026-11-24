import crypto from 'node:crypto'

/** Colour palette for user avatars and remote cursors (chosen for contrast on white). */
export const PALETTE = [
  '#e11d48',
  '#db2777',
  '#c026d3',
  '#9333ea',
  '#7c3aed',
  '#4f46e5',
  '#2563eb',
  '#0284c7',
  '#0891b2',
  '#0d9488',
  '#059669',
  '#16a34a',
  '#65a30d',
  '#ca8a04',
  '#d97706',
  '#ea580c',
]

export function colorFor(seed: string): string {
  const h = crypto.createHash('sha1').update(seed).digest()
  return PALETTE[h[0]! % PALETTE.length]!
}

const ADJECTIVES = ['Swift', 'Quiet', 'Bright', 'Clever', 'Gentle', 'Bold', 'Calm', 'Witty', 'Lucky', 'Brave']
const ANIMALS = ['Otter', 'Falcon', 'Panda', 'Lynx', 'Heron', 'Koala', 'Badger', 'Gecko', 'Ibis', 'Narwhal']

export function guestName(): string {
  const a = ADJECTIVES[crypto.randomInt(ADJECTIVES.length)]
  const b = ANIMALS[crypto.randomInt(ANIMALS.length)]
  return `${a} ${b}`
}

export const newId = () => crypto.randomUUID()

/** URL-safe random token for share links. */
export const newToken = () => crypto.randomBytes(18).toString('base64url')
