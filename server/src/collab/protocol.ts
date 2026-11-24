import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

/**
 * Client <-> server message types. 0-3 are the standard y-websocket protocol, so the stock
 * `y-websocket` WebsocketProvider works unmodified; 100+ are CollabDocs extensions that the
 * client registers via `provider.messageHandlers`.
 */
export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_AUTH = 2
export const MSG_QUERY_AWARENESS = 3
/** server -> client: state vector of what has been durably written to the op log. */
export const MSG_SAVED = 100
/** server -> client: JSON control event (title changed, comments changed, access changed...). */
export const MSG_CONTROL = 101

/** WebSocket close codes. 4400-4499 tell y-websocket not to reconnect. */
export const CLOSE_UNAUTHENTICATED = 4401
export const CLOSE_FORBIDDEN = 4403
export const CLOSE_NOT_FOUND = 4404
export const CLOSE_SLOW_CONSUMER = 4508
export const CLOSE_RATE_LIMITED = 4529
/** 1012 = "service restart": clients reconnect (through the load balancer, to a live instance). */
export const CLOSE_RESTART = 1012

export type ControlEvent =
  | { type: 'title'; title: string }
  | { type: 'comments' }
  | { type: 'access'; userId?: string }
  | { type: 'versions' }
  | { type: 'restored'; versionId: string; by: string }
  | { type: 'deleted' }

/** Inter-instance (Redis) envelope kinds. */
export const BUS_UPDATE = 0
export const BUS_AWARENESS = 1
/** "I just loaded this room, here is my state vector: send me what I am missing." */
export const BUS_SYNC_REQUEST = 2
export const BUS_CONTROL = 3

export const docChannel = (docId: string) => `collabdocs:doc:${docId}`

export function encodeEnvelope(instanceId: string, kind: number, payload: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarString(enc, instanceId)
  encoding.writeVarUint(enc, kind)
  encoding.writeVarUint8Array(enc, payload)
  return encoding.toUint8Array(enc)
}

export function decodeEnvelope(msg: Uint8Array): { origin: string; kind: number; payload: Uint8Array } {
  const dec = decoding.createDecoder(msg)
  return {
    origin: decoding.readVarString(dec),
    kind: decoding.readVarUint(dec),
    payload: decoding.readVarUint8Array(dec),
  }
}

export function encodeMessage(type: number, write: (enc: encoding.Encoder) => void): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, type)
  write(enc)
  return encoding.toUint8Array(enc)
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
export const encodeJson = (v: unknown) => textEncoder.encode(JSON.stringify(v))
export const decodeJson = <T>(b: Uint8Array): T => JSON.parse(textDecoder.decode(b)) as T
