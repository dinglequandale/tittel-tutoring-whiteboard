// Pure, dependency-free, DOM-free rules for "Coins on a Round Table". Imported
// by BOTH server/ (authoritative) and client/ (CoinsGame). Same discipline as
// the other rules modules: no browser or Node-only APIs, so `tsx` and Vite can
// both load it unchanged.
//
// Players alternate placing a coin on the table, no overlaps, nothing hanging
// off the edge. Whoever places the LAST coin wins. The first player wins (on any
// table with a center of symmetry) by taking the exact center, then mirroring
// every opponent coin through it — the mirror is always legal because the table
// and the already-placed coins stay symmetric, so the first player always has a
// reply and never runs out first.
//
// TWO MODES, because that strategy argument only has teeth when the number of
// coins that end up on the table is NOT fixed:
//
//   • 'freeform' — the REAL game. A coin may be dropped anywhere it fits
//     (center >= r from every boundary, >= 2r from every other center). Placing
//     is a finite, decidable check; but "no legal spot remains" is a genuinely
//     hard packing question (saturated packings come in different sizes), so the
//     game does NOT auto-end — the current player (or the tutor as referee)
//     declares themselves stuck via a `concede` move, and loses. This is the
//     version where the mirror strategy actually forces the win.
//
//   • 'lattice' — a decidable DEMO. Placements snap to a triangular lattice
//     spaced one coin-diameter apart, so every empty point is always legal and
//     the board always fills completely. Handy for "no moves left" ending
//     cleanly and for drawing the exact mirror — but note the outcome is then
//     pure parity of the point count (blocking the center flips it), with no
//     real strategy. Kept as an illustration, not the game.
//
// Coordinates are normalized to the unit square [0,1]x[0,1], center (0.5, 0.5);
// the client scales them into its own SVG.

export interface CoinsOptions {
  /** true = the real, strategic continuous game; false = the lattice demo. */
  freeform: boolean
  /** false = circular table (default); true = rectangular (homework variant). */
  rectangle: boolean
  /** Lattice only: blocks the center point, flipping the (parity) win to P2.
   *  Meaningless in freeform (a single point has measure zero) and ignored there. */
  centerBlocked: boolean
  /** How many coin-diameters span the table width — sets the coin size in both
   *  modes, and the number of candidate points in lattice mode. */
  across: number
}

export interface CoinPos {
  x: number
  y: number
}

export interface CoinsState {
  mode: 'lattice' | 'freeform'
  shape: 'circle' | 'rectangle'
  centerBlocked: boolean
  /** Coin radius, in normalized units. */
  radius: number
  // --- lattice-only structural data (points: [], centerIndex: -1 in freeform) ---
  points: CoinPos[]
  mirror: number[]
  centerIndex: number
  /** lattice: candidate-point indices that hold a coin, in placement order. */
  occupied: number[]
  // --- freeform-only placed coins, in placement order (empty in lattice) ---
  placed: CoinPos[]
  turn: 0 | 1
  over: boolean
  winner: 0 | 1 | null
  log: { player: 0 | 1; x: number; y: number }[]
}

/** A move is a lattice placement (point index), a freeform placement (coords),
 *  or a concession ("I can't place a coin" — freeform's tutor/player-driven end). */
export type CoinsMove = { point: number } | { x: number; y: number } | { concede: true }

const RECT_HALF_H = 0.33
const CIRCLE_RADIUS = 0.5
const SQRT3_OVER_2 = Math.sqrt(3) / 2
const EPS = 1e-6

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(max, Math.max(min, v))
}

/** Is a coin centered at (x, y) fully inside the table (center at least `r`
 *  from every boundary)? */
export function insideTable(x: number, y: number, r: number, shape: 'circle' | 'rectangle'): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  if (shape === 'circle') {
    return Math.hypot(x - 0.5, y - 0.5) <= CIRCLE_RADIUS - r + EPS
  }
  return Math.abs(x - 0.5) <= CIRCLE_RADIUS - r + EPS && Math.abs(y - 0.5) <= RECT_HALF_H - r + EPS
}

/** Freeform legality: fully on the table AND its center at least 2r from every
 *  coin already down (i.e. no overlap). Shared by the server (authoritative)
 *  and the client (live preview + illegal-spot feedback) — one source of truth. */
export function isFreeformLegal(state: CoinsState, x: number, y: number): boolean {
  if (!insideTable(x, y, state.radius, state.shape)) return false
  const min = 2 * state.radius
  for (const c of state.placed) {
    if (Math.hypot(x - c.x, y - c.y) < min - EPS) return false
  }
  return true
}

export function createCoins(options: CoinsOptions): CoinsState {
  const shape: 'circle' | 'rectangle' = options?.rectangle ? 'rectangle' : 'circle'
  const across = clampInt(options?.across, 4, 9, 6)
  const radius = 1 / across / 2

  const base = {
    shape,
    radius,
    occupied: [] as number[],
    placed: [] as CoinPos[],
    turn: 0 as 0 | 1,
    over: false,
    winner: null as 0 | 1 | null,
    log: [] as { player: 0 | 1; x: number; y: number }[],
  }

  if (options?.freeform) {
    // The real game: no lattice, no center-block (measure zero in a continuum).
    return { mode: 'freeform', centerBlocked: false, points: [], mirror: [], centerIndex: -1, ...base }
  }

  // Lattice demo. Triangular lattice generated by v1 = (d, 0), v2 = (d/2, d·√3/2)
  // through the center — 180°-symmetric, so filtering by a centrally-symmetric
  // table keeps it symmetric and the mirror map is total.
  const d = 1 / across
  const span = across + 2
  const points: CoinPos[] = []
  for (let m = -span; m <= span; m++) {
    for (let n = -span; n <= span; n++) {
      const x = 0.5 + n * d + m * (d / 2)
      const y = 0.5 + m * d * SQRT3_OVER_2
      if (insideTable(x, y, radius, shape)) points.push({ x, y })
    }
  }
  const centerIndex = points.findIndex((p) => Math.abs(p.x - 0.5) < EPS && Math.abs(p.y - 0.5) < EPS)
  const mirror = points.map((p) =>
    points.findIndex((q) => Math.abs(q.x - (1 - p.x)) < EPS && Math.abs(q.y - (1 - p.y)) < EPS),
  )

  return {
    mode: 'lattice',
    centerBlocked: !!options?.centerBlocked,
    points,
    mirror,
    centerIndex,
    ...base,
  }
}

/** Every coin currently on the table, as explicit coords + which seat placed it
 *  (placement order alternates seats), for uniform rendering across both modes. */
export function placedCoins(state: CoinsState): { x: number; y: number; by: 0 | 1 }[] {
  if (state.mode === 'freeform') {
    return state.placed.map((c, i) => ({ x: c.x, y: c.y, by: (i % 2) as 0 | 1 }))
  }
  return state.occupied.map((idx, i) => ({ x: state.points[idx].x, y: state.points[idx].y, by: (i % 2) as 0 | 1 }))
}

/** Lattice only: is candidate point `i` a legal place to drop a coin right now? */
export function isPlayable(state: CoinsState, i: number): boolean {
  if (state.mode !== 'lattice') return false
  if (i < 0 || i >= state.points.length) return false
  if (state.centerBlocked && i === state.centerIndex) return false
  return !state.occupied.includes(i)
}

/** Lattice only: every point index still open — the finite "moves left" set. */
export function playablePoints(state: CoinsState): number[] {
  const out: number[] = []
  for (let i = 0; i < state.points.length; i++) if (isPlayable(state, i)) out.push(i)
  return out
}

export type ApplyCoinsMoveResult = { ok: true; state: CoinsState } | { ok: false; error: string }

/**
 * Validates and applies a move. Never mutates `state` (the server swaps in the
 * returned state only on success, so an in-place mutation would corrupt state
 * on a rejected move too).
 */
export function applyCoinsMove(state: CoinsState, playerIdx: 0 | 1, move: CoinsMove): ApplyCoinsMoveResult {
  if (state.over || state.winner !== null) return { ok: false, error: 'game already over' }
  if (playerIdx !== state.turn) return { ok: false, error: 'not your turn' }

  // "I can't place a coin." The player to move is stuck, so they lose and the
  // other player (who placed the last coin) wins. Freeform's human-adjudicated
  // ending; harmless if ever sent in lattice.
  if ((move as { concede?: unknown })?.concede === true) {
    return {
      ok: true,
      state: { ...state, over: true, turn: (playerIdx === 0 ? 1 : 0) as 0 | 1, winner: (playerIdx === 0 ? 1 : 0) as 0 | 1 },
    }
  }

  if (state.mode === 'freeform') {
    const m = move as { x?: unknown; y?: unknown }
    if (typeof m.x !== 'number' || typeof m.y !== 'number') return { ok: false, error: 'no point chosen' }
    if (!isFreeformLegal(state, m.x, m.y)) return { ok: false, error: 'illegal placement (off table or overlapping)' }
    const placed = [...state.placed, { x: m.x, y: m.y }]
    // Freeform never auto-ends: "no legal spot remains" is not decidable here,
    // so only a concede move ends the game.
    return {
      ok: true,
      state: {
        ...state,
        placed,
        turn: (playerIdx === 0 ? 1 : 0) as 0 | 1,
        log: [...state.log, { player: playerIdx, x: m.x, y: m.y }],
      },
    }
  }

  // Lattice placement.
  const point = (move as { point?: unknown }).point
  if (typeof point !== 'number' || !Number.isInteger(point)) return { ok: false, error: 'no point chosen' }
  if (point < 0 || point >= state.points.length) return { ok: false, error: 'point off the table' }
  if (state.centerBlocked && point === state.centerIndex) return { ok: false, error: 'the center is blocked' }
  if (state.occupied.includes(point)) return { ok: false, error: 'a coin is already there' }

  const occupied = [...state.occupied, point]
  const occSet = new Set(occupied)
  let remaining = 0
  for (let i = 0; i < state.points.length; i++) {
    if (i === state.centerIndex && state.centerBlocked) continue
    if (!occSet.has(i)) remaining++
  }
  const over = remaining === 0
  const p = state.points[point]

  return {
    ok: true,
    state: {
      ...state,
      occupied,
      turn: (playerIdx === 0 ? 1 : 0) as 0 | 1,
      over,
      winner: over ? playerIdx : null,
      log: [...state.log, { player: playerIdx, x: p.x, y: p.y }],
    },
  }
}

/**
 * The winning move the tutor's mirror overlay should highlight (host-only,
 * never sent to guests), as normalized coords, or `null` when there's none:
 *
 * - Opening (no coins yet): take the center — the winning first move. Lattice
 *   with the center blocked has no winning first move (P2 wins by mirroring),
 *   so this returns null.
 * - Otherwise: the 180° image of the opponent's last coin — "copy through the
 *   center." Null if that image isn't a legal placement (which only happens
 *   once someone grabbed the center and broke the symmetry — exactly why taking
 *   it first is winning).
 */
export function optimalCoinsMove(state: CoinsState): { x: number; y: number; kind: 'center' | 'mirror' } | null {
  if (state.over || state.winner !== null) return null

  if (state.mode === 'freeform') {
    if (state.placed.length === 0) return { x: 0.5, y: 0.5, kind: 'center' }
    const last = state.placed[state.placed.length - 1]
    const mx = 1 - last.x
    const my = 1 - last.y
    return isFreeformLegal(state, mx, my) ? { x: mx, y: my, kind: 'mirror' } : null
  }

  // Lattice.
  if (state.occupied.length === 0) {
    if (state.centerBlocked) return null
    return isPlayable(state, state.centerIndex)
      ? { x: state.points[state.centerIndex].x, y: state.points[state.centerIndex].y, kind: 'center' }
      : null
  }
  const last = state.occupied[state.occupied.length - 1]
  const image = state.mirror[last]
  if (image >= 0 && isPlayable(state, image)) {
    return { x: state.points[image].x, y: state.points[image].y, kind: 'mirror' }
  }
  return null
}
