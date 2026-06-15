import { TLSocketRoom } from '@tldraw/sync-core'
import type { WebSocket as WsSocket } from 'ws'

// Rooms are 100% in-memory and volatile. When the last drawing session leaves,
// we wait a short grace period (to survive refreshes/flaky networks) and then
// drop the room and everything in it — no database, nothing persisted to disk.
const GRACE_MS = 30_000

type AssetBlob = { data: Buffer; contentType: string }

export type ControlClient = { socket: WsSocket; role: 'host' | 'guest' }

export interface Room {
  id: string
  socketRoom: TLSocketRoom<any, void>
  /** Pasted/dropped images, keyed by asset id. */
  assets: Map<string, AssetBlob>
  /** Control-channel sockets carrying camera + calculator relay (not tldraw sync). */
  controls: Set<ControlClient>
  /** The tutor's last broadcast camera, replayed to students who join late. */
  lastCamera: unknown | null
  /** Whether the tutor's live Desmos calculator is currently open for everyone. */
  calcOpen: boolean
  /** The tutor's last calculator state, replayed to students who join late. */
  lastCalcState: unknown | null
  /** Whether all students may edit the shared calculator (tutor-toggled). */
  studentsCanEdit: boolean
  closeTimer: ReturnType<typeof setTimeout> | null
}

const rooms = new Map<string, Room>()

export function getOrCreateRoom(id: string): Room {
  const existing = rooms.get(id)
  if (existing) {
    // Someone came (back) — cancel any pending teardown.
    if (existing.closeTimer) {
      clearTimeout(existing.closeTimer)
      existing.closeTimer = null
    }
    return existing
  }

  const room: Room = {
    id,
    assets: new Map(),
    controls: new Set(),
    lastCamera: null,
    calcOpen: false,
    lastCalcState: null,
    studentsCanEdit: false,
    closeTimer: null,
    // Set just below; typed non-null for ergonomic access.
    socketRoom: undefined as unknown as TLSocketRoom<any, void>,
  }

  room.socketRoom = new TLSocketRoom<any, void>({
    onSessionRemoved(_room, args) {
      if (args.numSessionsRemaining === 0) scheduleClose(room)
    },
  })

  rooms.set(id, room)
  return room
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id)
}

function scheduleClose(room: Room) {
  if (room.closeTimer) return
  room.closeTimer = setTimeout(() => closeRoom(room), GRACE_MS)
}

function closeRoom(room: Room) {
  rooms.delete(room.id)
  room.assets.clear()
  for (const client of room.controls) {
    try {
      client.socket.close()
    } catch {
      /* already gone */
    }
  }
  room.controls.clear()
  try {
    room.socketRoom.close()
  } catch {
    /* already closed */
  }
}
