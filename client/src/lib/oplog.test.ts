import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { LogPlayer, type LogEntry } from './oplog'

function history(n: number) {
  const doc = new Y.Doc()
  const entries: LogEntry[] = []
  const texts: string[] = ['']
  doc.on('update', (update: Uint8Array) =>
    entries.push({ seq: entries.length + 1, at: 0, userId: 'u', userName: 'U', userColor: '#000', update }),
  )
  const t = doc.getText('t')
  for (let i = 0; i < n; i++) {
    if (i % 7 === 6) t.delete(0, 1)
    else t.insert(t.length, String(i % 10))
    texts.push(t.toString())
  }
  return { entries, texts }
}

describe('LogPlayer (time travel over the op log)', () => {
  it('reproduces the exact state after every write, scrubbing forward and backward', () => {
    const { entries, texts } = history(350)
    const player = new LogPlayer(entries)
    const at = (n: number) => player.seek(n).getText('t').toString()
    // Forward, then random jumps backward and forward across checkpoints.
    expect(at(350)).toBe(texts[350])
    for (const n of [0, 1, 99, 100, 101, 250, 3, 349, 200, 350, 57]) expect(at(n)).toBe(texts[n])
    player.destroy()
  })

  it('clamps out-of-range positions', () => {
    const { entries, texts } = history(10)
    const player = new LogPlayer(entries)
    expect(player.seek(-5).getText('t').toString()).toBe('')
    expect(player.seek(999).getText('t').toString()).toBe(texts[10])
  })
})
