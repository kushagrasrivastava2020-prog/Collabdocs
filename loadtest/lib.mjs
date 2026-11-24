// Minimal headless CollabDocs client: speaks the same y-websocket protocol as the browser.
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_SAVED = 100
export const MSG_CONTROL = 101

export async function api(base, path, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`)
  return data
}

/**
 * Connect a headless client to a document.
 * `ready` resolves once the initial sync (server's sync step 2) has been received.
 *
 * With `reconnect: true` it behaves like the browser provider: when the socket drops (e.g. the
 * server instance behind the load balancer dies) it reconnects with jittered exponential backoff
 * and resyncs. The Yjs handshake (state vectors both ways) recovers every edit made meanwhile,
 * in both directions. 44xx close codes are terminal, exactly as in y-websocket.
 */
export function connectDoc({ wsBase, docId, token, onUpdate, onSaved, onControl, user, reconnect = false, onDisconnect, onResync }) {
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  if (user) awareness.setLocalStateField('user', user)
  const url = `${wsBase}/${docId}?token=${encodeURIComponent(token)}`
  const client = {
    doc,
    awareness,
    ws: null,
    synced: false,
    connected: false,
    closed: null,
    destroyed: false,
    reconnects: 0,
    bytesIn: 0,
    messagesIn: 0,
  }

  const send = (buf) => client.ws?.readyState === WebSocket.OPEN && client.ws.send(buf)

  doc.on('update', (update, origin) => {
    if (origin === client) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeUpdate(enc, update)
    send(encoding.toUint8Array(enc))
  })
  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin === client) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_AWARENESS)
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]))
    send(encoding.toUint8Array(enc))
  })

  let resolveReady
  let rejectReady
  client.ready = new Promise((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })
  let attempt = 0
  let droppedAt = 0

  const open = () => {
    if (client.destroyed) return
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    client.ws = ws
    let syncedHere = false
    ws.on('open', () => {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.writeSyncStep1(enc, doc)
      send(encoding.toUint8Array(enc))
      if (awareness.getLocalState()) {
        const a = encoding.createEncoder()
        encoding.writeVarUint(a, MSG_AWARENESS)
        encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]))
        send(encoding.toUint8Array(a))
      }
    })
    ws.on('message', (data) => {
      const buf = new Uint8Array(data)
      client.bytesIn += buf.byteLength
      client.messagesIn++
      const dec = decoding.createDecoder(buf)
      const type = decoding.readVarUint(dec)
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, MSG_SYNC)
        const sub = syncProtocol.readSyncMessage(dec, enc, doc, client)
        if (encoding.length(enc) > 1) send(encoding.toUint8Array(enc))
        if (sub === syncProtocol.messageYjsSyncStep2 && !syncedHere) {
          syncedHere = true
          client.connected = true
          attempt = 0
          if (!client.synced) {
            client.synced = true
            resolveReady(client)
          } else {
            client.reconnects++
            onResync?.(performance.now() - droppedAt)
          }
        }
        if (sub !== syncProtocol.messageYjsSyncStep1) onUpdate?.(client)
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), client)
      } else if (type === MSG_SAVED) {
        onSaved?.(Y.decodeStateVector(decoding.readVarUint8Array(dec)))
      } else if (type === MSG_CONTROL) {
        onControl?.(JSON.parse(decoding.readVarString(dec)))
      }
    })
    ws.on('error', () => {}) // 'close' always follows
    ws.on('close', (code, reason) => {
      if (client.ws !== ws) return
      client.closed = { code, reason: reason.toString() }
      const wasConnected = client.connected
      client.connected = false
      if (client.destroyed) return
      const terminal = code >= 4400 && code < 4500
      if (!reconnect || terminal) {
        if (!client.synced) rejectReady(new Error(`closed before sync: ${code} ${reason}`))
        return
      }
      if (wasConnected) {
        droppedAt = performance.now()
        onDisconnect?.(code)
        // Like y-websocket: peers' presence is unknown until we resync.
        const others = [...awareness.getStates().keys()].filter((id) => id !== doc.clientID)
        awarenessProtocol.removeAwarenessStates(awareness, others, client)
      }
      const delay = Math.min(2000, 100 * 2 ** attempt++) * (0.5 + Math.random())
      setTimeout(open, delay)
    })
  }
  open()

  client.close = () => {
    client.destroyed = true
    awareness.destroy()
    client.ws?.close()
    doc.destroy()
  }
  return client
}

/** Append a paragraph to the ProseMirror/TipTap-shaped fragment. */
export function appendParagraph(doc, text) {
  const frag = doc.getXmlFragment('default')
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText(text)])
  frag.insert(frag.length, [p])
  return p
}

export function textOf(doc) {
  return doc
    .getXmlFragment('default')
    .toArray()
    .map((n) =>
      n instanceof Y.XmlElement
        ? n
            .toArray()
            .map((c) => (c instanceof Y.XmlText ? c.toString() : ''))
            .join('')
        : '',
    )
    .join('\n')
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
