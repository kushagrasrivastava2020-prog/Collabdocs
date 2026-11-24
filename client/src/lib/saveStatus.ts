export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export type SaveState =
  { kind: 'connecting' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'offline'; unsaved: boolean } | { kind: 'readonly' }

export interface SaveInputs {
  status: ConnectionStatus
  canEdit: boolean
  /** This replica's own client id and its current clock. */
  clientId: number
  localClock: number
  /** Last state vector the server confirmed as durably persisted (null = none yet). */
  acked: Map<number, number> | null
  /** True from (re)connect until the first ack: offline edits from a previous session may still be in flight. */
  awaitingInitialAck: boolean
}

/**
 * The server acknowledges each op-log write with the state vector it covers. Our own edits
 * are all saved once the acked clock for our client id has caught up with our local clock.
 */
export function computeSaveState(i: SaveInputs): SaveState {
  if (!i.canEdit) return { kind: 'readonly' }
  const ackedClock = i.acked?.get(i.clientId) ?? 0
  const unsaved = i.localClock > ackedClock
  if (i.status === 'disconnected') return { kind: 'offline', unsaved: unsaved || i.awaitingInitialAck }
  if (i.status === 'connecting') return { kind: 'connecting' }
  if (i.awaitingInitialAck || unsaved) return { kind: 'saving' }
  return { kind: 'saved' }
}

export function saveLabel(s: SaveState): string {
  switch (s.kind) {
    case 'connecting':
      return 'Connecting…'
    case 'saving':
      return 'Saving…'
    case 'saved':
      return 'All changes saved'
    case 'offline':
      return s.unsaved ? 'Offline · edits kept on this device' : 'Offline'
    case 'readonly':
      return ''
  }
}
