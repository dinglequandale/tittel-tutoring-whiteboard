// Pure, dependency-free, DOM-free rules for "Balance" — the two-pile version of
// Nim. Imported by BOTH server/ (authoritative) and client/ (BalanceGame, for
// the optimistic UI + the tutor-only strategy overlay). Same discipline as
// shared/games/nim.ts / lockers.ts / pizza.ts: no browser or Node-only APIs, so
// `tsx` and Vite can both load it unchanged.
//
// Two piles of stones. On your turn you take any number (>= 1) from ONE pile.
// Normal play: whoever takes the last stone overall wins. The winning strategy
// is to leave the two piles equal, then mirror every move — the losing
// positions are exactly the equal ones, and the invariant handed back and forth
// is the difference |a - b|. That strategy IS the lesson; it drives the
// tutor-only overlay (`optimalBalanceMove`), so it must be exactly right.
//
// Naming note: the spec sketches the turn field as `toMove`, but the whole
// registry's wire protocol authorizes moves by reading a conventional
// `turn: 0 | 1` off the state (see server/index.ts's currentPlayerUserId). We
// use `turn` so that gate works — renaming it would silently make every move
// unauthorized.

export interface BalanceOptions {
  /** Starting size of pile 0 (Gabriel's-side column). */
  a: number
  /** Starting size of pile 1. */
  b: number
  /** Misère: taking the last stone LOSES instead of wins (off by default). */
  misere: boolean
}

export interface BalanceState {
  /** The two pile sizes. `piles[pile]` is the count remaining in that pile. */
  piles: [number, number]
  turn: 0 | 1
  /** True once both piles are empty (see `winner`). Redundant with
   *  `winner !== null`, but the spec lists it and it reads clearly at call sites. */
  over: boolean
  winner: 0 | 1 | null
  misere: boolean
  log: { player: 0 | 1; pile: 0 | 1; count: number }[]
}

/** A move names the pile and how many stones (`count` = the spec's `k`) to take. */
export interface BalanceMove {
  pile: 0 | 1
  count: number
}

/** Clamp so a malformed/out-of-range option never produces an unplayable board. */
function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(max, Math.max(min, v))
}

export function createBalance(options: BalanceOptions): BalanceState {
  const a = clampInt(options?.a, 1, 20, 5)
  const b = clampInt(options?.b, 1, 20, 8)
  return {
    piles: [a, b],
    turn: 0,
    over: false,
    winner: null,
    misere: !!options?.misere,
    log: [],
  }
}

export type ApplyBalanceMoveResult = { ok: true; state: BalanceState } | { ok: false; error: string }

/**
 * Validates and applies a move. Never mutates `state` — same purity discipline
 * as the other rules modules: the server holds the previous state and only
 * swaps in the returned one on success, so an in-place mutation here would
 * corrupt state even on a REJECTED move (a plausible-looking wrong result, not
 * a crash — the exact trap interactive-answers.md records).
 */
export function applyBalanceMove(state: BalanceState, playerIdx: 0 | 1, move: BalanceMove): ApplyBalanceMoveResult {
  if (state.over || state.winner !== null) return { ok: false, error: 'game already over' }
  if (playerIdx !== state.turn) return { ok: false, error: 'not your turn' }

  const pile = move?.pile
  if (pile !== 0 && pile !== 1) return { ok: false, error: 'must pick pile 0 or 1' }

  const count = move?.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
    return { ok: false, error: 'must take at least 1 stone' }
  }
  if (count > state.piles[pile]) {
    return { ok: false, error: `cannot take more than the ${state.piles[pile]} in that pile` }
  }

  const piles: [number, number] = [state.piles[0], state.piles[1]]
  piles[pile] -= count

  const nextTurn: 0 | 1 = playerIdx === 0 ? 1 : 0
  const emptied = piles[0] === 0 && piles[1] === 0
  // Normal play: the player who takes the last stone wins. Misère: they lose,
  // so the win goes to the player now facing two empty piles.
  const winner: 0 | 1 | null = emptied ? (state.misere ? nextTurn : playerIdx) : null

  const nextState: BalanceState = {
    piles,
    turn: nextTurn,
    over: emptied,
    winner,
    misere: state.misere,
    log: [...state.log, { player: playerIdx, pile, count }],
  }
  return { ok: true, state: nextState }
}

/**
 * The winning move from the current position, or `null` when the position is
 * lost against perfect play (so the tutor can deliberately leave a boy sitting
 * in a losing spot and let him feel WHY it's lost). Drives the tutor-only
 * strategy overlay — rendered on the host's screen only, never sent to guests.
 *
 * Normal play: equalize the piles. `a == b` is exactly the set of losing
 * positions, so from an unequal position the unique winning move reduces the
 * larger pile down to the smaller. From an equal position there is no winning
 * move at all.
 *
 * Misère: the equalize rule breaks down in the endgame (when piles are tiny),
 * so we fall back to an exhaustive memoized minimax over the (small) pile
 * sizes — correct by construction rather than by a hand-rolled parity rule.
 */
export function optimalBalanceMove(state: BalanceState): BalanceMove | null {
  if (state.over || state.winner !== null) return null
  const [a, b] = state.piles

  if (!state.misere) {
    if (a === b) return null // a losing (P-)position — no winning move exists
    return a > b ? { pile: 0, count: a - b } : { pile: 1, count: b - a }
  }

  // Misère: search for a move that hands the opponent a losing position.
  const memo = new Map<string, boolean>()
  for (let k = 1; k <= a; k++) {
    if (misereLoss(a - k, b, memo)) return { pile: 0, count: k }
  }
  for (let k = 1; k <= b; k++) {
    if (misereLoss(a, b - k, memo)) return { pile: 1, count: k }
  }
  return null
}

/**
 * True when the player TO MOVE from `(a, b)` loses under misère perfect play.
 * Memoized on the unordered pair (the game is symmetric in the two piles).
 *
 * Base case `(0, 0)`: the player to move has no stones to take, which means the
 * opponent just took the last stone — and under misère that opponent LOSES, so
 * the player to move has already won. Hence `(0, 0)` is NOT a loss for the
 * mover (the mirror image of normal play, where an empty board IS a loss).
 */
function misereLoss(a: number, b: number, memo: Map<string, boolean>): boolean {
  if (a === 0 && b === 0) return false
  const key = a <= b ? `${a},${b}` : `${b},${a}`
  const cached = memo.get(key)
  if (cached !== undefined) return cached

  // A position is a loss iff EVERY move leads to a win for the opponent; it's a
  // win iff SOME move hands the opponent a loss.
  let loss = true
  for (let k = 1; k <= a && loss; k++) {
    if (misereLoss(a - k, b, memo)) loss = false
  }
  for (let k = 1; k <= b && loss; k++) {
    if (misereLoss(a, b - k, memo)) loss = false
  }
  memo.set(key, loss)
  return loss
}
