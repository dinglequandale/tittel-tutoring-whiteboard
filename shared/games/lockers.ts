// Pure, dependency-free, DOM-free rules for the classic "100 lockers"
// problem. Imported by BOTH server/ (authoritative) and client/ (LockersGame,
// for the completion reveal). Same discipline as shared/games/nim.ts — no
// browser or Node-only APIs, so `tsx` and Vite can both load it unchanged.
//
// This isn't adversarial like Nim: there's no winner, just a demo of what
// happens after every student's pass. It still fits the registry's turn-based
// two-seat wire protocol by having the two picked participants alternate
// running consecutive students' passes — see the client component for why
// that's a deliberate, lightly-gamified choice rather than a compromise.

export interface LockersOptions {
  lockerCount: number
}

export interface LockersState {
  lockerCount: number
  /** open[i] is whether locker (i+1) is open. Length is always lockerCount. */
  open: boolean[]
  /** touched[i] is how many times locker (i+1) has been toggled so far —
   *  authoritative (not derived client-side) so every viewer's optional
   *  visit-count overlay agrees. Once every student has gone, touched[i]
   *  equals the divisor count of (i+1), which is why open[i] (an ODD divisor
   *  count) lines up exactly with the perfect squares. */
  touched: number[]
  turn: 0 | 1
  /** 1-indexed student whose pass runs next. > lockerCount once every
   *  student has gone (see `done`). */
  nextStudent: number
  done: boolean
  log: { player: 0 | 1; fromStudent: number; toStudent: number }[]
}

/** Runs `count` consecutive students' passes (student `nextStudent` through
 *  `nextStudent + count - 1`) in a single move, so the current player can
 *  either single-step ("one student at a time") or fast-forward. */
export interface LockersMove {
  count: number
}

/** Clamp so a malformed/out-of-range option never produces an unplayable board. */
function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(max, Math.max(min, v))
}

export function createLockers(options: LockersOptions): LockersState {
  const lockerCount = clampInt(options?.lockerCount, 4, 200, 100)
  return {
    lockerCount,
    open: Array(lockerCount).fill(false),
    touched: Array(lockerCount).fill(0),
    turn: 0,
    nextStudent: 1,
    done: false,
    log: [],
  }
}

export type ApplyLockersMoveResult = { ok: true; state: LockersState } | { ok: false; error: string }

/**
 * Validates and applies a move. Never mutates `state` — same purity
 * discipline as applyNimMove, for the same reason: an in-place mutation here
 * would corrupt state even on a REJECTED move, since the server holds the
 * previous state and only swaps in the returned one on success.
 */
export function applyLockersMove(state: LockersState, playerIdx: 0 | 1, move: LockersMove): ApplyLockersMoveResult {
  if (state.done) return { ok: false, error: 'every student has already gone' }
  if (playerIdx !== state.turn) return { ok: false, error: 'not your turn' }

  const remaining = state.lockerCount - state.nextStudent + 1
  const raw = move?.count
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    return { ok: false, error: 'count must be a positive integer' }
  }
  const count = Math.min(raw, remaining)

  const open = [...state.open]
  const touched = [...state.touched]
  const fromStudent = state.nextStudent
  const toStudent = fromStudent + count - 1
  for (let student = fromStudent; student <= toStudent; student++) {
    for (let locker = student; locker <= state.lockerCount; locker += student) {
      open[locker - 1] = !open[locker - 1]
      touched[locker - 1] += 1
    }
  }

  const nextStudent = toStudent + 1
  const done = nextStudent > state.lockerCount
  const nextTurn: 0 | 1 = playerIdx === 0 ? 1 : 0

  const nextState: LockersState = {
    lockerCount: state.lockerCount,
    open,
    touched,
    turn: nextTurn,
    nextStudent,
    done,
    log: [...state.log, { player: playerIdx, fromStudent, toStudent }],
  }
  return { ok: true, state: nextState }
}

/** The reveal: a locker ends up open iff its number has an odd count of
 *  divisors, i.e. is a perfect square — this drives the client's "aha" banner
 *  once `done`. */
export function isPerfectSquare(n: number): boolean {
  const r = Math.round(Math.sqrt(n))
  return r * r === n
}
