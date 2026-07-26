// Pure, dependency-free, DOM-free rules for "Water Jugs" — a SIMULTANEOUS race,
// not a turn-based game. Imported by BOTH server/ (authoritative) and client/
// (WaterGame, for the optimistic UI + the tutor-only BFS hint). Same discipline
// as shared/games/nim.ts / balance.ts: no browser or Node-only APIs, so `tsx`
// and Vite can both load it unchanged.
//
// Each of the two players gets their OWN pair of jugs (a small one and a big
// one, e.g. 3 L and 5 L) and races to measure out the goal. The classic
// operations: FILL a jug to the brim from the tap, EMPTY a jug, or POUR one jug
// into the other until the source is empty or the destination is full. An
// "amount you've produced" is any reading currently showing — either jug alone,
// or the two jugs together.
//
// TWO win modes, unified through `required` (the set of amounts you must
// produce) and each player's `found` (the subset they've produced so far):
//   - single-target (default): required = [target]. First to produce exactly
//     `target` liters wins — with 3/5, goal 8 = fill both (a 2-move "aha"); drop
//     it to 4 for the hard Die-Hard classic.
//   - collect-all (option `collectAll`): required = every amount reachable in
//     1..target. Race to produce them ALL — the fastest to tick off 1, 2, 3, …
//     up to the goal wins. Once produced, an amount stays collected even if it's
//     later poured away. With coprime jugs (like 3 & 5) every value 1..(a+b) is
//     reachable, so 1..8 is always completable.
//
// THE KEY STRUCTURAL DIFFERENCE from every other game in the registry: this is a
// race, so there is no "whose turn is it". The registry's server gate authorizes
// play messages by reading a conventional `turn` off the state; `turn: 0 | 1`
// means "only that player may move". We instead set `turn: -1`, the convention
// the server reads as "simultaneous — either of the two chosen players may move
// their OWN side at any time" (see server/index.ts's canPlay). Each player's
// move only ever touches state.jugs[playerIdx], so the two races never collide.

export type WaterOp = 'fill' | 'empty' | 'pour'
export type JugId = 'small' | 'big'

export interface WaterOptions {
  /** Capacity of the small jug in liters (the classic puzzle's 3). */
  smallCap: number
  /** Capacity of the big jug in liters (the classic puzzle's 5). */
  bigCap: number
  /** The goal amount. In single-target mode you measure exactly this; in
   *  collect-all mode it's the top of the 1..target range you race to fill in. */
  target: number
  /** Race to produce EVERY amount from 1 up to `target`, rather than just the
   *  single `target`. Off by default. */
  collectAll: boolean
}

/** One player's private pair of jugs, their move count, and which required
 *  amounts they've produced so far. */
export interface JugPair {
  small: number
  big: number
  /** How many legal operations this player has performed — the "efficiency"
   *  score shown after a win (fewer = tidier), and how "quickest" is judged. */
  ops: number
  /** The subset of `required` this player has produced (sorted, since it's
   *  filtered out of the already-sorted `required`). */
  found: number[]
}

/** A move names the operation and the jug it applies to. For `pour`, `jug` is
 *  the SOURCE jug; the water goes into the other one. */
export interface WaterMove {
  op: WaterOp
  jug: JugId
}

export interface WaterState {
  /** -1 = simultaneous play. The server reads this as "either chosen player may
   *  move their own side" (see server/index.ts canPlay). NOT a 0 | 1 turn. */
  turn: -1
  smallCap: number
  bigCap: number
  target: number
  /** True when racing to collect every amount 1..target (drives UI labeling). */
  collectAll: boolean
  /** The amounts a player must produce to win: [target] in single mode, or every
   *  reachable amount in 1..target in collect-all mode. Sorted ascending. */
  required: number[]
  /** Per-player jugs: jugs[0] belongs to players[0], jugs[1] to players[1]. */
  jugs: [JugPair, JugPair]
  /** The first player to produce every required amount. Ends the race for both. */
  winner: 0 | 1 | null
}

/** Every legal operation, in a fixed order — shared by applyMove's neighbor
 *  generation and the two BFS helpers below. */
const ALL_MOVES: WaterMove[] = [
  { op: 'fill', jug: 'small' },
  { op: 'fill', jug: 'big' },
  { op: 'empty', jug: 'small' },
  { op: 'empty', jug: 'big' },
  { op: 'pour', jug: 'small' },
  { op: 'pour', jug: 'big' },
]

/** Clamp so a malformed/out-of-range option never produces an unplayable board. */
function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(max, Math.max(min, v))
}

/** Apply a fill/empty/pour to one jug pair, returning the new amounts. Pure. */
function step(pair: { small: number; big: number }, smallCap: number, bigCap: number, move: WaterMove): { small: number; big: number } {
  let { small, big } = pair
  if (move.op === 'fill') {
    if (move.jug === 'small') small = smallCap
    else big = bigCap
  } else if (move.op === 'empty') {
    if (move.jug === 'small') small = 0
    else big = 0
  } else {
    // pour from `move.jug` (source) into the other until source empties or dest fills
    if (move.jug === 'small') {
      const amount = Math.min(small, bigCap - big)
      small -= amount
      big += amount
    } else {
      const amount = Math.min(big, smallCap - small)
      big -= amount
      small += amount
    }
  }
  return { small, big }
}

/**
 * Every amount in 1..target that can ever be shown (as either jug alone or the
 * two-jug total) starting from empty jugs. A BFS over the small state space of
 * (small, big) amounts. This is what collect-all mode asks you to produce, so it
 * can never demand an amount the jugs physically can't make — the race is always
 * winnable no matter what caps a tutor picks. Sorted ascending.
 */
function reachableValues(smallCap: number, bigCap: number, target: number): number[] {
  const values = new Set<number>()
  const mark = (s: number, b: number) => {
    for (const v of [s, b, s + b]) if (v >= 1 && v <= target) values.add(v)
  }
  const key = (s: number, b: number) => s * (bigCap + 1) + b
  const visited = new Set<number>([key(0, 0)])
  const queue: { small: number; big: number }[] = [{ small: 0, big: 0 }]
  mark(0, 0)
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const move of ALL_MOVES) {
      const { small, big } = step(cur, smallCap, bigCap, move)
      if (small === cur.small && big === cur.big) continue
      const k = key(small, big)
      if (visited.has(k)) continue
      visited.add(k)
      mark(small, big)
      queue.push({ small, big })
    }
  }
  return [...values].sort((a, b) => a - b)
}

export function createWater(options: WaterOptions): WaterState {
  const a = clampInt(options?.smallCap, 1, 20, 3)
  const b = clampInt(options?.bigCap, 1, 20, 5)
  // Keep small <= big so the labels ("small jug" / "big jug") stay honest even
  // if a tutor enters them the other way round.
  const smallCap = Math.min(a, b)
  const bigCap = Math.max(a, b)
  const target = clampInt(options?.target, 1, smallCap + bigCap, Math.min(8, smallCap + bigCap))
  const collectAll = !!options?.collectAll
  const reach = reachableValues(smallCap, bigCap, target)
  // Collect mode races to make every reachable amount 1..target; single mode
  // just needs `target`. (`reach` is non-empty for any target >= 1, but guard
  // anyway so a degenerate config can't yield a required-less instant win.)
  const required = collectAll ? (reach.length > 0 ? reach : [target]) : [target]
  const fresh = (): JugPair => ({ small: 0, big: 0, ops: 0, found: [] })
  return { turn: -1, smallCap, bigCap, target, collectAll, required, jugs: [fresh(), fresh()], winner: null }
}

export type ApplyWaterMoveResult = { ok: true; state: WaterState } | { ok: false; error: string }

/**
 * Validates and applies a move. Never mutates `state` — same purity discipline
 * as the other rules modules: the server holds the previous state and only swaps
 * in the returned one on success. A move that changes nothing (filling a full
 * jug, emptying an empty one, pouring with an empty source or full destination)
 * is REJECTED, so the ops count stays an honest measure of real progress.
 */
export function applyWaterMove(state: WaterState, playerIdx: 0 | 1, move: WaterMove): ApplyWaterMoveResult {
  if (state.winner !== null) return { ok: false, error: 'race already won' }
  if (playerIdx !== 0 && playerIdx !== 1) return { ok: false, error: 'bad player' }

  const op = move?.op
  if (op !== 'fill' && op !== 'empty' && op !== 'pour') return { ok: false, error: 'unknown operation' }
  const jug = move?.jug
  if (jug !== 'small' && jug !== 'big') return { ok: false, error: 'must name the small or big jug' }

  const me = state.jugs[playerIdx]
  const { small, big } = step(me, state.smallCap, state.bigCap, { op, jug })

  if (small === me.small && big === me.big) return { ok: false, error: 'that does nothing' }

  // `found` = the subset of `required` this player has produced: everything they
  // already had, PLUS any required amount showing after this move (a single jug
  // or the two-jug total). Filtering out of the sorted `required` keeps it
  // sorted, and "already had" means a collected amount survives being poured off.
  const found = state.required.filter(
    (v) => me.found.includes(v) || v === small || v === big || v === small + big,
  )
  const updated: JugPair = { small, big, ops: me.ops + 1, found }
  const jugs: [JugPair, JugPair] = playerIdx === 0 ? [updated, state.jugs[1]] : [state.jugs[0], updated]
  const winner: 0 | 1 | null = found.length === state.required.length ? playerIdx : null
  return { ok: true, state: { ...state, jugs, winner } }
}

/**
 * The next operation on a SHORTEST path from a player's current jugs to a state
 * that produces a required amount they haven't collected yet, or `null` once
 * they've collected them all. A breadth-first search over the (tiny) state space
 * — correct by construction rather than a hand-rolled rule. In single-target
 * mode this is just "shortest path to `target`"; in collect-all mode it points
 * at the nearest still-missing amount. Drives the tutor-only hint chip, rendered
 * on the host's screen only and never sent to guests (guests receive the same
 * game-state, so the guard is render-time, per games-spec.md).
 */
export function optimalWaterMove(state: WaterState, playerIdx: 0 | 1): WaterMove | null {
  const me = state.jugs[playerIdx]
  const { smallCap, bigCap } = state
  const needs = state.required.filter((v) => !me.found.includes(v))
  if (needs.length === 0) return null
  const producesNeed = (s: number, b: number) => needs.some((v) => v === s || v === b || v === s + b)

  const key = (s: number, b: number) => s * (bigCap + 1) + b
  const visited = new Set<number>([key(me.small, me.big)])
  const queue: { small: number; big: number; first: WaterMove | null }[] = [
    { small: me.small, big: me.big, first: null },
  ]

  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const move of ALL_MOVES) {
      const { small, big } = step({ small: cur.small, big: cur.big }, smallCap, bigCap, move)
      if (small === cur.small && big === cur.big) continue // no-op edge
      const k = key(small, big)
      if (visited.has(k)) continue
      const first = cur.first ?? move
      if (producesNeed(small, big)) return first
      visited.add(k)
      queue.push({ small, big, first })
    }
  }
  return null
}
