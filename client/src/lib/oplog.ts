import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'

export interface LogEntry {
  seq: number
  at: number
  userId: string
  userName: string
  userColor: string
  update: Uint8Array
}

const MAX_ENTRIES = 20_000

/** Fetch the document's whole append-only op log (paged binary frames, see server /oplog). */
export async function fetchOpLog(docId: string, onProgress?: (n: number) => void): Promise<LogEntry[]> {
  const out: LogEntry[] = []
  let after = 0
  for (;;) {
    const res = await fetch(`/api/docs/${docId}/oplog?after=${after}&limit=2000`, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`Could not load history (${res.status})`)
    const dec = decoding.createDecoder(new Uint8Array(await res.arrayBuffer()))
    const n = decoding.readVarUint(dec)
    for (let i = 0; i < n; i++) {
      out.push({
        seq: decoding.readVarUint(dec),
        at: decoding.readFloat64(dec),
        userId: decoding.readVarString(dec),
        userName: decoding.readVarString(dec),
        userColor: decoding.readVarString(dec),
        update: decoding.readVarUint8Array(dec),
      })
    }
    onProgress?.(out.length)
    if (res.headers.get('X-Has-More') !== '1' || n === 0 || out.length >= MAX_ENTRIES) return out
    after = out[out.length - 1]!.seq
  }
}

const CHECKPOINT_EVERY = 100

/**
 * Materialises the document at any point in its history. Moving forward applies log entries
 * incrementally; moving backward restarts from the nearest checkpoint (taken every 100 entries
 * on the way forward), so scrubbing stays fast even for long histories.
 */
export class LogPlayer {
  private doc = new Y.Doc()
  private position = 0
  private checkpoints = new Map<number, Uint8Array>([[0, Y.encodeStateAsUpdate(new Y.Doc())]])

  constructor(readonly entries: LogEntry[]) {}

  /** Document state after applying the first `n` entries. */
  seek(n: number): Y.Doc {
    n = Math.max(0, Math.min(n, this.entries.length))
    if (n < this.position) {
      let base = Math.floor(n / CHECKPOINT_EVERY) * CHECKPOINT_EVERY
      while (!this.checkpoints.has(base)) base -= CHECKPOINT_EVERY
      this.doc.destroy()
      this.doc = new Y.Doc()
      Y.applyUpdate(this.doc, this.checkpoints.get(base)!)
      this.position = base
    }
    while (this.position < n) {
      Y.applyUpdate(this.doc, this.entries[this.position]!.update)
      this.position++
      if (this.position % CHECKPOINT_EVERY === 0 && !this.checkpoints.has(this.position)) {
        this.checkpoints.set(this.position, Y.encodeStateAsUpdate(this.doc))
      }
    }
    return this.doc
  }

  destroy() {
    this.doc.destroy()
  }
}
