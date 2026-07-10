// Pure, dependency-free, DOM-free rules for the single-pile subtraction game
// ("the 21 game" / Nim). Imported by BOTH server/ (authoritative) and, later,
// client/ (optimistic UI + the tutor-only hint). Keep this file free of any
// browser or Node-only APIs so it can be loaded by Vite and by `tsx` unchanged
// — see shared/grade.ts for the same discipline in this codebase.
//
// The server is the only place a move is ever accepted. Nothing here reaches
// into a Room or a socket; it just computes the next state or rejects a move.

export interface NimOptions {
  pile: number
  maxTake: number
  misere: boolean
}

export interface NimState {
  /** Remaining token ids, e.g. 't0'...'t20'. Order is insertion order (t0 first). */
  tokens: string[]
  /** Removed ids, in the order they were taken (oldest first). */
  taken: string[]
  turn: 0 | 1
  maxTake: number
  misere: boolean
  winner: 0 | 1 | null
  log: { player: 0 | 1; count: number }[]
}

/** A move names the exact tokens the player dragged out, so the visuals stay honest. */
export interface NimMove {
  tokenIds: string[]
}

/** Clamp so a malformed/out-of-range option never produces an unplayable pile. */
function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(max, Math.max(min, v))
}

export function createNim(options: NimOptions): NimState {
  const pile = clampInt(options.pile, 1, 60, 21)
  const maxTake = clampInt(options.maxTake, 1, 5, 3)
  const tokens: string[] = []
  for (let i = 0; i < pile; i++) tokens.push(`t${i}`)
  return {
    tokens,
    taken: [],
    turn: 0,
    maxTake,
    misere: !!options.misere,
    winner: null,
    log: [],
  }
}

export type ApplyNimMoveResult = { ok: true; state: NimState } | { ok: false; error: string }

/**
 * Validates and applies a move. Never mutates `state` — callers (the server)
 * hold the previous state in a Room and swap in the returned one, so an
 * accidental in-place mutation here would corrupt state on a REJECTED move
 * too (this is exactly the kind of bug that yields a plausible-looking wrong
 * result rather than a crash — see interactive-answers.md).
 */
export function applyNimMove(state: NimState, playerIdx: 0 | 1, move: NimMove): ApplyNimMoveResult {
  if (state.winner !== null) return { ok: false, error: 'game already has a winner' }
  if (playerIdx !== state.turn) return { ok: false, error: 'not your turn' }

  const tokenIds = move?.tokenIds
  if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
    return { ok: false, error: 'no tokens selected' }
  }
  if (tokenIds.length > state.maxTake) {
    return { ok: false, error: `cannot take more than ${state.maxTake}` }
  }
  // Distinct check via Set size, not a nested loop — tokenIds is at most maxTake (<=5).
  if (new Set(tokenIds).size !== tokenIds.length) {
    return { ok: false, error: 'duplicate token ids' }
  }
  const pile = new Set(state.tokens)
  for (const id of tokenIds) {
    if (typeof id !== 'string' || !pile.has(id)) {
      return { ok: false, error: 'token not in pile' }
    }
  }

  const taking = new Set(tokenIds)
  const remaining = state.tokens.filter((id) => !taking.has(id))
  const nextTurn: 0 | 1 = playerIdx === 0 ? 1 : 0
  // Normal play: the player who takes the last token wins. Misère: they lose,
  // so the win goes to whoever is left facing an empty pile.
  const winner: 0 | 1 | null = remaining.length === 0 ? (state.misere ? nextTurn : playerIdx) : null

  const nextState: NimState = {
    tokens: remaining,
    taken: [...state.taken, ...tokenIds],
    turn: nextTurn,
    maxTake: state.maxTake,
    misere: state.misere,
    winner,
    log: [...state.log, { player: playerIdx, count: tokenIds.length }],
  }
  return { ok: true, state: nextState }
}

/**
 * The count that wins from `state.tokens.length`, or `null` when the position
 * is lost against perfect play (any move a player makes here still loses if
 * the opponent replies optimally). Drives the tutor-only hint chip — this
 * strategy IS the lesson, so it must be exactly right, not just "a" legal move.
 *
 * Normal play: leave a multiple of (maxTake+1) for the opponent.
 * Misère: leave a multiple of (maxTake+1), PLUS one — the parity flips because
 * the player forced to take the last token loses instead of wins.
 */
export function optimalNimMove(state: NimState): number | null {
  const n = state.tokens.length
  const m = state.maxTake + 1

  if (state.misere) {
    // Forced to take the (only) last token and lose — no move avoids it.
    if (n === 1) return null
    const r = (n - 1) % m
    return r === 0 ? null : r
  }

  const r = n % m
  return r === 0 ? null : r
}
