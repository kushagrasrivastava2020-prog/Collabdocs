import { describe, expect, it } from 'vitest'
import { computeSaveState, saveLabel, type SaveInputs } from './saveStatus'

const base: SaveInputs = {
  status: 'connected',
  canEdit: true,
  clientId: 7,
  localClock: 10,
  acked: new Map([[7, 10]]),
  awaitingInitialAck: false,
}

describe('computeSaveState', () => {
  it('is saved when the server acked our latest clock', () => {
    expect(computeSaveState(base)).toEqual({ kind: 'saved' })
  })

  it('is saving while our clock is ahead of the ack', () => {
    expect(computeSaveState({ ...base, localClock: 11 })).toEqual({ kind: 'saving' })
    expect(computeSaveState({ ...base, acked: null })).toEqual({ kind: 'saving' })
  })

  it('ignores other clients in the ack (their edits are not ours to save)', () => {
    expect(
      computeSaveState({
        ...base,
        acked: new Map([
          [7, 10],
          [8, 2],
        ]),
      }),
    ).toEqual({ kind: 'saved' })
  })

  it('waits for the first ack after reconnecting', () => {
    expect(computeSaveState({ ...base, awaitingInitialAck: true })).toEqual({ kind: 'saving' })
  })

  it('reports offline, flagging unsaved local edits', () => {
    expect(computeSaveState({ ...base, status: 'disconnected' })).toEqual({ kind: 'offline', unsaved: false })
    const s = computeSaveState({ ...base, status: 'disconnected', localClock: 12 })
    expect(s).toEqual({ kind: 'offline', unsaved: true })
    expect(saveLabel(s)).toMatch(/kept on this device/)
  })

  it('is read-only for viewers and commenters', () => {
    expect(computeSaveState({ ...base, canEdit: false, localClock: 99 })).toEqual({ kind: 'readonly' })
  })
})
