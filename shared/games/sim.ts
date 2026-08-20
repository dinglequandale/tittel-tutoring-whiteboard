// Pure, dependency-free, DOM-free rules for "Don't Make a Triangle" (the game
// Sim). Imported by BOTH server/ (authoritative) and client/ (SimGame, for the
// board + the tutor-only "these moves lose on the spot" overlay). Same
// discipline as shared/games/nim.ts: no browser or Node-only APIs, so `tsx` and
// Vite can both load it unchanged.
//
// `dots` points sit on a circle and every PAIR of them is joined by a segment
// (6 dots -> 15 segments). Players alternate coloring one uncolored segment in
// their own color, and you LOSE the moment three of your own segments close a
// triangle. Misère only — see the registry entry for why normal play would be
// degenerate.
//
// The lesson is R(3,3) = 6: at 6 dots every possible 2-coloring of all 15
// segments contains a monochromatic triangle, so a draw is impossible; at 5
// dots the pentagon/pentagram coloring draws. That makes the DRAW a first-class
// outcome here, not an edge case — which is why terminality rides on `done`
// rather than on `winner !== null` (a draw is terminal with nobody winning),
// matching the Lockers and Pizza pattern. test/sim.mjs brute-forces all 2^15
// colorings to pin the theorem down.

export interface SimOptions {
  dots: number
}

export interface SimState {
  dots: number
  /** One slot per edge in `edgePairs(dots)` order. 0 = red, 1 = blue, null = uncolored. */
  edges: (0 | 1 | null)[]
  turn: 0 | 1
  /** The player who did NOT complete a triangle, or null on a draw or mid-game. */
  winner: 0 | 1 | null
  /** Terminal flag. `done && winner === null` is precisely a draw. */
  done: boolean
  /** Edge indices (ascending) of the triangle that ended the game, for the UI to flash. */
  losingTriangle: [number, number, number] | null
  log: { player: 0 | 1; edge: number }[]
}

/** A move names one segment by its index into `edgePairs(state.dots)`. */
export interface SimMove {
  edge: number
}

/** Legal `dots` range. Kept in sync BY HAND with the registry's `dots` stepper
 *  (client/src/games/registry.ts imports only TYPES from rules modules, never
 *  values, or a game's chunk would leak into the registry's). */
export const MIN_DOTS = 4
export const MAX_DOTS = 8

/** Clamp so a malformed/out-of-range option never produces an unplayable board. */
function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(max, Math.max(min, v))
}

/**
 * All unordered pairs [a, b] with a < b, in lexicographic order. `dots = 6`
 * gives 15 pairs: [0,1], [0,2], ... [0,5], [1,2], ... [4,5].
 *
 * A move names a segment by its INDEX into this array, so the client and the
 * server must derive the same ordering from `dots` alone — hence one exported
 * helper both sides call rather than two copies of the same loop that could
 * drift apart and silently color the wrong segment.
 */
export function edgePairs(dots: number): [number, number][] {
  const pairs: [number, number][] = []
  for (let a = 0; a < dots; a++) {
    for (let b = a + 1; b < dots; b++) pairs.push([a, b])
  }
  return pairs
}

/**
 * The inverse lookup: the index of segment (a, b) in `edgePairs(dots)`, in O(1).
 * Endpoint order doesn't matter. Returns -1 if an endpoint is out of range or
 * both name the same dot.
 *
 * Closed form rather than a scan: the rows of `edgePairs` have lengths
 * (n-1), (n-2), ..., so row `lo` starts at sum_{i<lo}(n-1-i) = lo*n - lo*(lo+1)/2.
 */
export function edgeIndex(dots: number, a: number, b: number): number {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  if (lo < 0 || hi >= dots || lo === hi) return -1
  return lo * dots - (lo * (lo + 1)) / 2 + (hi - lo - 1)
}

/** Number of segments on a `dots`-dot board: C(dots, 2). */
export function edgeCount(dots: number): number {
  return (dots * (dots - 1)) / 2
}

export function createSim(options: SimOptions): SimState {
  const dots = clampInt(options?.dots, MIN_DOTS, MAX_DOTS, 6)
  return {
    dots,
    edges: new Array<0 | 1 | null>(edgeCount(dots)).fill(null),
    turn: 0,
    winner: null,
    done: false,
    losingTriangle: null,
    log: [],
  }
}

/**
 * If segment (a, b) colored `color` closes a monochromatic triangle, return
 * that triangle's three edge indices (ascending); otherwise null.
 *
 * O(dots), not O(dots^3): only the just-colored edge can create a NEW triangle,
 * so we walk the third vertex `v` and ask whether both (a, v) and (b, v)
 * already carry the same color. The (a, b) slot itself is never read, so this
 * works equally well before or after that slot is filled in.
 */
function triangleThrough(
  edges: readonly (0 | 1 | null)[],
  dots: number,
  a: number,
  b: number,
  color: 0 | 1,
): [number, number, number] | null {
  const ab = edgeIndex(dots, a, b)
  for (let v = 0; v < dots; v++) {
    if (v === a || v === b) continue
    const av = edgeIndex(dots, a, v)
    const bv = edgeIndex(dots, b, v)
    if (edges[av] === color && edges[bv] === color) {
      const tri = [ab, av, bv].sort((x, y) => x - y)
      return [tri[0], tri[1], tri[2]]
    }
  }
  return null
}

export type ApplySimMoveResult = { ok: true; state: SimState } | { ok: false; error: string }

/**
 * Validates and applies a move. Never mutates `state` — same purity discipline
 * as every other rules module here: the server holds the previous state and
 * only swaps in the returned one on success, so an in-place mutation would
 * corrupt the board even on a REJECTED move (a plausible-looking wrong result,
 * not a crash — the exact trap interactive-answers.md records).
 */
export function applySimMove(state: SimState, playerIdx: 0 | 1, move: SimMove): ApplySimMoveResult {
  if (state.done) return { ok: false, error: 'game already over' }
  if (playerIdx !== state.turn) return { ok: false, error: 'not your turn' }

  const edge = move?.edge
  if (typeof edge !== 'number' || !Number.isInteger(edge) || edge < 0 || edge >= state.edges.length) {
    return { ok: false, error: 'no such segment' }
  }
  if (state.edges[edge] !== null) return { ok: false, error: 'that segment is already colored' }

  const edges = state.edges.slice()
  edges[edge] = playerIdx

  const [a, b] = edgePairs(state.dots)[edge]
  const losingTriangle = triangleThrough(edges, state.dots, a, b, playerIdx)

  // Misère: closing a triangle in your OWN color is the losing act, so the win
  // goes to the other player. Failing that, the game ends only once the board
  // is full with no monochromatic triangle anywhere — a genuine draw, terminal
  // with `winner === null`. That outcome is impossible at 6 dots (R(3,3) = 6)
  // and very much possible at 5, which is the whole point of the lesson.
  const opponent: 0 | 1 = playerIdx === 0 ? 1 : 0
  const full = edges.every((c) => c !== null)

  const nextState: SimState = {
    dots: state.dots,
    edges,
    turn: opponent,
    winner: losingTriangle !== null ? opponent : null,
    done: losingTriangle !== null || full,
    losingTriangle,
    log: [...state.log, { player: playerIdx, edge }],
  }
  return { ok: true, state: nextState }
}

/**
 * The uncolored segments that would immediately complete a triangle for
 * `state.turn` — i.e. the moves that lose on the spot.
 *
 * Deliberately NOT the exact `optimal*Move` every other game in this library
 * ships. Sim is solved (the second player wins at 6 dots with perfect play) but
 * its tree is far too large for the kind of exact, trustworthy hint the others
 * give, and a merely plausible hint would be worse than none: here the strategy
 * IS the lesson. This much is exact and cheap, so it's what the tutor-only
 * overlay renders instead.
 */
export function suicideEdges(state: SimState): number[] {
  if (state.done) return []
  const pairs = edgePairs(state.dots)
  const out: number[] = []
  for (let i = 0; i < state.edges.length; i++) {
    if (state.edges[i] !== null) continue
    const [a, b] = pairs[i]
    if (triangleThrough(state.edges, state.dots, a, b, state.turn) !== null) out.push(i)
  }
  return out
}

/**
 * Every monochromatic triangle on an arbitrary coloring, as edge-index triples.
 * A played-out game has at most one (play stops the instant a triangle
 * appears), but the R(3,3) brute force in test/sim.mjs has to ask the question
 * of all 2^15 colorings, including boards no game could reach.
 */
export function monochromaticTriangles(
  dots: number,
  edges: readonly (0 | 1 | null)[],
): [number, number, number][] {
  const found: [number, number, number][] = []
  for (let a = 0; a < dots; a++) {
    for (let b = a + 1; b < dots; b++) {
      const ab = edgeIndex(dots, a, b)
      const color = edges[ab]
      if (color !== 0 && color !== 1) continue
      for (let c = b + 1; c < dots; c++) {
        const ac = edgeIndex(dots, a, c)
        const bc = edgeIndex(dots, b, c)
        if (edges[ac] === color && edges[bc] === color) found.push([ab, ac, bc])
      }
    }
  }
  return found
}
