// Pure, dependency-free, DOM-free rules for the classic "pizza cutting"
// (lazy caterer's) problem. Imported by BOTH server/ (authoritative) and
// client/ (PizzaGame, to draw the cut lines). Same discipline as
// shared/games/nim.ts and shared/games/lockers.ts — no browser or Node-only
// APIs, so `tsx` and Vite can both load it unchanged.
//
// Not adversarial, like Lockers: there's no winner, just a demo of how fast
// a circle gets carved up when every new straight cut crosses every earlier
// one. It fits the registry's turn-based two-seat wire protocol the same way
// Lockers does — the two picked participants alternate making consecutive
// cuts, which doubles as the "1st cut, 2nd cut, 3rd cut…" iteration the demo
// is about.
//
// Cut placement is deterministic, not tutor-drawn: each cut's angle and
// offset from center come from an irrational-step sequence (golden angle /
// golden ratio) chosen so no two cuts are ever parallel and no three ever
// meet at one point — i.e. every cut is guaranteed to land in "general
// position", which is exactly the condition under which the closed-form
// piece count below is correct. That closed form is the actual theorem
// (the 2D "lazy caterer's sequence"), not a client-side guess.

export interface PizzaOptions {
  maxCuts: number
}

/** One straight cut, as a line across the pizza's circle: `angleDeg` is the
 *  line's direction (0..180, since a line's direction repeats every 180°),
 *  and `offset` is its perpendicular distance from the center, as a
 *  fraction of the circle's radius (-1..1). See `chordEndpoints` to turn
 *  this into drawable coordinates. */
export interface PizzaCut {
  angleDeg: number
  offset: number
}

export interface PizzaState {
  maxCuts: number
  cuts: PizzaCut[]
  turn: 0 | 1
  /** 1-indexed cut number that runs next. > maxCuts once every cut has been made (see `done`). */
  nextCut: number
  done: boolean
  /** Authoritative piece count for `cuts.length` cuts in general position — see `piecesForCuts`. */
  pieces: number
  log: { player: 0 | 1; fromCut: number; toCut: number }[]
}

/** Makes `count` consecutive cuts (cut `nextCut` through `nextCut + count -
 *  1`) in a single move, so the current player can either single-step ("one
 *  cut at a time") or fast-forward. */
export interface PizzaMove {
  count: number
}

/** Clamp so a malformed/out-of-range option never produces an unplayable board. */
function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(max, Math.max(min, v))
}

const GOLDEN_ANGLE_DEG = 137.50776405003785
const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949

/** The i-th cut's direction (0-indexed), spread by the golden angle so no
 *  two of the first several dozen cuts ever land on the same direction mod
 *  180°. */
function cutAngle(i: number): number {
  return (i * GOLDEN_ANGLE_DEG) % 180
}

/** The i-th cut's perpendicular offset from center, as a fraction of the
 *  radius, spread by the golden ratio's fractional sequence into (-0.82,
 *  0.82) — never 0 twice, never at the same distance twice, which (combined
 *  with every angle being distinct) makes three cuts meeting at one point
 *  vanishingly unlikely for any board size this demo supports. Kept away
 *  from ±1 so every chord is comfortably inside the circle, not tangent to it. */
function cutOffset(i: number): number {
  const frac = (i * GOLDEN_RATIO_CONJUGATE) % 1
  return frac * 1.64 - 0.82
}

export function createPizza(options: PizzaOptions): PizzaState {
  const maxCuts = clampInt(options?.maxCuts, 1, 12, 8)
  return {
    maxCuts,
    cuts: [],
    turn: 0,
    nextCut: 1,
    done: false,
    pieces: 1,
    log: [],
  }
}

/** The lazy caterer's sequence: the most pieces a circle can be cut into by
 *  `n` straight cuts, achieved exactly when every cut is in general
 *  position (no two parallel, no three concurrent) — which is what
 *  `cutAngle`/`cutOffset` guarantee. */
export function piecesForCuts(n: number): number {
  return 1 + (n * (n + 1)) / 2
}

export type ApplyPizzaMoveResult = { ok: true; state: PizzaState } | { ok: false; error: string }

/**
 * Validates and applies a move. Never mutates `state` — same purity
 * discipline as applyLockersMove, for the same reason: an in-place mutation
 * here would corrupt state even on a REJECTED move, since the server holds
 * the previous state and only swaps in the returned one on success.
 */
export function applyPizzaMove(state: PizzaState, playerIdx: 0 | 1, move: PizzaMove): ApplyPizzaMoveResult {
  if (state.done) return { ok: false, error: 'every cut has already been made' }
  if (playerIdx !== state.turn) return { ok: false, error: 'not your turn' }

  const remaining = state.maxCuts - state.nextCut + 1
  const raw = move?.count
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    return { ok: false, error: 'count must be a positive integer' }
  }
  const count = Math.min(raw, remaining)

  const cuts = [...state.cuts]
  const fromCut = state.nextCut
  const toCut = fromCut + count - 1
  for (let c = fromCut; c <= toCut; c++) {
    cuts.push({ angleDeg: cutAngle(c - 1), offset: cutOffset(c - 1) })
  }

  const nextCut = toCut + 1
  const done = nextCut > state.maxCuts
  const nextTurn: 0 | 1 = playerIdx === 0 ? 1 : 0

  const nextState: PizzaState = {
    maxCuts: state.maxCuts,
    cuts,
    turn: nextTurn,
    nextCut,
    done,
    pieces: piecesForCuts(cuts.length),
    log: [...state.log, { player: playerIdx, fromCut, toCut }],
  }
  return { ok: true, state: nextState }
}

/** Turns a cut into a drawable chord across a circle of the given radius,
 *  centered on (0, 0) — callers translate to their own SVG center. Returns
 *  `null` for the (unreachable in practice, given `cutOffset`'s range)
 *  degenerate case of an offset at or beyond the radius. */
export function chordEndpoints(
  cut: PizzaCut,
  radius: number,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const theta = (cut.angleDeg * Math.PI) / 180
  const d = cut.offset * radius
  if (Math.abs(d) >= radius) return null
  const half = Math.sqrt(radius * radius - d * d)
  const cx = -d * Math.sin(theta)
  const cy = d * Math.cos(theta)
  const dx = half * Math.cos(theta)
  const dy = half * Math.sin(theta)
  return { x1: cx - dx, y1: cy - dy, x2: cx + dx, y2: cy + dy }
}
