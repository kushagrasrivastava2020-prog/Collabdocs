import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence, clearDocument } from 'y-indexeddb'
import * as decoding from 'lib0/decoding'
import { computeSaveState, type ConnectionStatus, type SaveState } from './saveStatus'

/** Must match server/src/collab/protocol.ts */
const MSG_SAVED = 100
const MSG_CONTROL = 101

export type ControlEvent =
  | { type: 'title'; title: string }
  | { type: 'comments' }
  | { type: 'access'; userId?: string }
  | { type: 'versions' }
  | { type: 'restored'; versionId: string; by: string }
  | { type: 'deleted' }

export interface CollabState {
  status: ConnectionStatus
  synced: boolean
  /** Local IndexedDB replica loaded (content is available even offline). */
  localLoaded: boolean
  save: SaveState
  /** Set when the server closed the socket for good (4401 / 4403 / 4404). */
  fatal: { code: number; reason: string } | null
}

const IDB_INDEX_KEY = 'collabdocs:idb-docs'
const idbName = (docId: string) => `collabdocs:${docId}`

function rememberIdb(docId: string) {
  const set = new Set<string>(JSON.parse(localStorage.getItem(IDB_INDEX_KEY) ?? '[]'))
  set.add(docId)
  localStorage.setItem(IDB_INDEX_KEY, JSON.stringify([...set]))
}

/** Wipe every locally cached document (called on sign-out so a shared computer keeps nothing). */
export async function clearLocalDocuments() {
  const ids: string[] = JSON.parse(localStorage.getItem(IDB_INDEX_KEY) ?? '[]')
  await Promise.all(ids.map((id) => clearDocument(idbName(id)).catch(() => {})))
  localStorage.removeItem(IDB_INDEX_KEY)
}

/**
 * One open document: a Y.Doc replicated to
 *   - IndexedDB (y-indexeddb), so edits survive reloads and offline periods, and
 *   - the server (y-websocket), which relays to other clients and persists to the op log.
 * On reconnect, y-websocket's sync handshake exchanges state vectors and sends only the
 * missing updates in each direction - that is the whole offline-sync story.
 */
export class CollabSession {
  readonly doc = new Y.Doc()
  readonly provider: WebsocketProvider
  readonly idb: IndexeddbPersistence
  private acked: Map<number, number> | null = null
  private awaitingInitialAck = true
  private canEdit: boolean
  private listeners = new Set<() => void>()
  private controlListeners = new Set<(ev: ControlEvent) => void>()
  private snapshot: CollabState
  private pendingNotify: ReturnType<typeof setTimeout> | null = null
  private fatal: { code: number; reason: string } | null = null

  constructor(
    readonly docId: string,
    canEdit: boolean,
  ) {
    this.canEdit = canEdit
    rememberIdb(docId)
    this.idb = new IndexeddbPersistence(idbName(docId), this.doc)
    this.idb.once('synced', () => this.changed())

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    this.provider = new WebsocketProvider(wsUrl, docId, this.doc, {
      // Tabs sync through the server (which enforces permissions), not BroadcastChannel.
      disableBc: true,
      maxBackoffTime: 5000,
    })
    this.provider.messageHandlers[MSG_SAVED] = (_enc, dec) => {
      this.acked = Y.decodeStateVector(decoding.readVarUint8Array(dec))
      this.awaitingInitialAck = false
      this.changed()
    }
    this.provider.messageHandlers[MSG_CONTROL] = (_enc, dec) => {
      const ev = JSON.parse(decoding.readVarString(dec)) as ControlEvent
      for (const l of this.controlListeners) l(ev)
    }
    this.provider.on('status', ({ status }) => {
      if (status === 'connected') this.awaitingInitialAck = this.canEdit
      this.changed()
    })
    this.provider.on('sync', () => this.changed())
    this.provider.on('closed', (ev) => {
      this.fatal = ev
      this.changed()
    })
    this.doc.on('update', () => this.changed())
    this.snapshot = this.compute()
  }

  private compute(): CollabState {
    const status = this.provider.wsconnected ? 'connected' : this.provider.wsconnecting ? 'connecting' : 'disconnected'
    const localClock = Y.decodeStateVector(Y.encodeStateVector(this.doc)).get(this.doc.clientID) ?? 0
    return {
      status,
      synced: this.provider.synced,
      localLoaded: this.idb.synced,
      fatal: this.fatal,
      save: computeSaveState({
        status,
        canEdit: this.canEdit,
        clientId: this.doc.clientID,
        localClock,
        acked: this.acked,
        awaitingInitialAck: this.awaitingInitialAck,
      }),
    }
  }

  /**
   * Coalesce bursts of updates into one recompute. (A timer rather than requestAnimationFrame:
   * rAF is paused in background tabs, which would freeze the save/connection status.)
   */
  private changed() {
    if (this.pendingNotify) return
    this.pendingNotify = setTimeout(() => {
      this.pendingNotify = null
      this.snapshot = this.compute()
      for (const l of this.listeners) l()
    }, 30)
  }

  setCanEdit(canEdit: boolean) {
    this.canEdit = canEdit
    this.changed()
  }

  // useSyncExternalStore contract
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getState = () => this.snapshot

  onControl(l: (ev: ControlEvent) => void): () => void {
    this.controlListeners.add(l)
    return () => {
      this.controlListeners.delete(l)
    }
  }

  /** Simulate going offline (handy for demos: the network toggle in the doc menu). */
  setOnline(online: boolean) {
    if (online) this.provider.connect()
    else this.provider.disconnect()
    this.changed()
  }

  async forgetLocalCopy() {
    await this.idb.clearData().catch(() => {})
  }

  destroy() {
    if (this.pendingNotify) clearTimeout(this.pendingNotify)
    this.listeners.clear()
    this.controlListeners.clear()
    this.provider.destroy()
    void this.idb.destroy()
    this.doc.destroy()
  }
}
