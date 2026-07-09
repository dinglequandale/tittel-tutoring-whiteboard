import { TLSocketRoom } from '@tldraw/sync-core'
import type { WebSocket as WsSocket } from 'ws'
import type { QuestionKey, Submission } from '../shared/quiz.ts'

// Rooms are 100% in-memory and volatile. When the last drawing session leaves,
// we wait a short grace period (to survive refreshes/flaky networks) and then
// drop the room and everything in it — no database, nothing persisted to disk.
const GRACE_MS = 30_000

type AssetBlob = { data: Buffer; contentType: string }

export type ControlClient = {
  socket: WsSocket
  role: 'host' | 'guest'
  /** Rolling-window rate limit state for guest quiz messages (see GUEST_MSG_RATE). */
  quizRate: { windowStart: number; count: number }
}

export interface Room {
  id: string
  socketRoom: TLSocketRoom<any, void>
  /** Pasted/dropped images, keyed by asset id. */
  assets: Map<string, AssetBlob>
  /** Control-channel sockets carrying camera + calculator relay (not tldraw sync). */
  controls: Set<ControlClient>
  /** The tutor's last broadcast camera, replayed to students who join late. */
  lastCamera: unknown | null
  /** The tutor's current page id, replayed to students who join late (page-follow). */
  lastPage: string | null
  /** Whether the tutor's live Desmos calculator is currently open for everyone. */
  calcOpen: boolean
  /** The tutor's last calculator state, replayed to students who join late. */
  lastCalcState: unknown | null
  /** The tutor's last calculator position/size, replayed to students who join late. */
  lastCalcGeom: unknown | null
  /** Whether all students may edit the shared calculator (tutor-toggled). */
  studentsCanEdit: boolean
  /** Class size mode. 'large' adds the name gate + default-locked write access. */
  mode: 'small' | 'large'
  /** In large mode, the set of student userIds the tutor has granted write access. */
  writers: Set<string>
  /** Free reign: when on, students roam pages/zoom freely and use personal calcs. */
  freeReign: boolean
  /** Whether the timer widget is currently visible to students. */
  timerVisible: boolean
  /** The tutor's last broadcast timer state, replayed to students who join late. */
  lastTimerState: { remainingMs: number; sentAt: number; running: boolean } | null
  /** The tutor's last timer position, replayed to students who join late. */
  lastTimerPos: { x: number; y: number } | null
  /** Host-supplied answer keys for the current lesson, qid -> key. Never sent to guests. */
  quizKey: Map<string, QuestionKey>
  /** qid -> userId -> ms timestamp the student's client first rendered the question. */
  quizSeen: Map<string, Map<string, number>>
  /** qid -> userId -> that student's submission (grading is authoritative, server-side). */
  quizSubs: Map<string, Map<string, Submission>>
  /** Whether the tutor has pressed "Reveal answers" for the current key set. */
  quizRevealed: boolean
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
    lastPage: null,
    calcOpen: false,
    lastCalcState: null,
    lastCalcGeom: null,
    studentsCanEdit: false,
    mode: 'small',
    writers: new Set(),
    freeReign: false,
    timerVisible: false,
    lastTimerState: null,
    lastTimerPos: null,
    quizKey: new Map(),
    quizSeen: new Map(),
    quizSubs: new Map(),
    quizRevealed: false,
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
