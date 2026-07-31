// Pure, dependency-free, DOM-free rules for "Water Jugs". Imported by BOTH
// server/ (authoritative) and client/ (WaterGame, for the optimistic UI + the
// tutor-only BFS hint). Same discipline as shared/games/nim.ts / balance.ts: no
// browser or Node-only APIs, so `tsx` and Vite can both load it unchanged.
//
// A player's board is a small jug and a big one (e.g. 3 L and 5 L) plus, when
// the tutor switches it on, an infinite RESERVOIR to park water in. The classic
// operations: FILL a jug to the brim from the tap, EMPTY a vessel, or POUR one
// vessel into another until the source is empty or the destination is full. An
// "amount you've produced" is any reading currently showing — any vessel alone,
// or any combination of them added together.
//
// TWO PLAY MODES (option `collaborative`):
//   - race (default): each of the two chosen players gets their OWN board and
//     they race, simultaneously. See the `turn: -1` note below.
//   - collaborative: ONE board that the TUTOR drives while the class calls out
//     the moves — students spectate the same jugs live. Every move lands on
//     jugs[0] no matter who sent it (see applyWaterMove), so the two seats the
//     setup screen still asks for are just identities the host may play under;
//     the second board stays untouched and unrendered.
//
// TWO WIN MODES, unified through `required` (the set of amounts you must
// produce) and each player's `found` (the subset produced so far):
//   - single-target (default): required = [target]. Produce exactly `target`
//     liters — with 3/5, goal 8 = fill both (a 2-move "aha"); drop it to 4 for
//     the hard Die-Hard classic.
//   - collect-all (option `collectAll`): required = every amount reachable in
//     1..target. Produce them ALL — 1, 2, 3, … up to the goal. Once produced, an
//     amount stays collected even if it's later poured away.
//
// THE RESERVOIR (option `stash`) is what lifts the ceiling. Two jugs alone can
// never show more than smallCap + bigCap at once, so that's where `target` is
// clamped. Pour into an unlimited third vessel and you can keep going: with
// COPRIME caps you can produce any positive integer at all (make 1 L in a jug,
// stash it, repeat — or stash whole jugfuls and top up), which is exactly the
// point the reservoir exists to make. There is no tap on it (FILL of the
// reservoir is rejected — it would never terminate); water only ever gets there
// by being poured out of a jug, and can be drawn back out into either jug.
//
// THE KEY STRUCTURAL DIFFERENCE from most of the registry: the race mode has no
// "whose turn is it". The server gate authorizes play messages by reading a
// conventional `turn` off the state; `turn: 0 | 1` means "only that player may
// move". We instead set `turn: -1`, the convention the server reads as
// "simultaneous — either of the two chosen players may move at any time" (see
// server/index.ts's canPlay). In race mode each player's move only ever touches
// state.jugs[playerIdx], so the two races never collide; in collaborative mode
// every authorized move lands on the one shared board.

export type WaterOp = 'fill' | 'empty' | 'pour'
export type JugId = 'small' | 'big'
/** A vessel a move can name: either real jug, or the infinite reservoir (only
 *  when the `stash` option is on — otherwise every move naming it is rejected). */
export type VesselId = JugId | 'stash'

/** Ceiling on `target` once the reservoir is in play: without it the goal can't
 *  exceed smallCap + bigCap, with it the only limit is how long a class's
 *  patience holds. Kept in sync by hand with the registry's `target` stepper
 *  range — the registry deliberately imports no VALUES from this module, so
 *  that its chunk stays free of the rules (see registry.ts's header). */
export const MAX_STASH_TARGET = 30

export interface WaterOptions {
  /** Capacity of the small jug in liters (the classic puzzle's 3). */
  smallCap: number
  /** Capacity of the big jug in liters (the classic puzzle's 5). */
  bigCap: number
  /** The goal amount. In single-target mode you measure exactly this; in
   *  collect-all mode it's the top of the 1..target range you fill in. */
  target: number
  /** Produce EVERY amount from 1 up to `target`, rather than just the single
   *  `target`. Off by default. */
  collectAll: boolean
  /** One shared board the tutor drives while students suggest moves, instead of
   *  a two-board race. Off by default. */
  collaborative: boolean
  /** Add the infinite reservoir, so amounts past smallCap + bigCap are on the
   *  table. Off by default. */
  stash: boolean
}

/** What one board is holding right now. `stash` stays 0 for the whole game when
 *  the reservoir option is off. */
export interface Amounts {
  small: number
  big: number
  stash: number
}

/** One board: its vessels, its move count, and which required amounts it has
 *  produced so far. */
export interface JugPair extends Amounts {
  /** How many legal operations have been performed here — the "efficiency"
   *  score shown after a win (fewer = tidier), and how "quickest" is judged. */
  ops: number
  /** The subset of `required` produced so far (sorted, since it's filtered out
   *  of the already-sorted `required`). */
  found: number[]
}

/** A move names the operation and the vessel it applies to. For `pour`, `jug` is
 *  the SOURCE; `to` is the destination, defaulting to the other jug when the
 *  source is a jug (so the pre-reservoir two-jug wire format still works) and
 *  required when the source is the reservoir. */
export interface WaterMove {
  op: WaterOp
  jug: VesselId
  to?: VesselId
}

export interface WaterState {
  /** -1 = simultaneous play. The server reads this as "either chosen player may
   *  move" (see server/index.ts canPlay). NOT a 0 | 1 turn. */
  turn: -1
  smallCap: number
  bigCap: number
  target: number
  /** True when producing every amount 1..target (drives UI labeling). */
  collectAll: boolean
  /** True when everyone shares jugs[0] and the tutor does the pouring. */
  collaborative: boolean
  /** True when the infinite reservoir is in play. */
  stash: boolean
  /** The amounts that must be produced to win: [target] in single mode, or every
   *  reachable amount in 1..target in collect-all mode. Sorted ascending. */
  required: number[]
  /** Per-player boards: jugs[0] belongs to players[0], jugs[1] to players[1]. In
   *  collaborative mode only jugs[0] is ever used. */
  jugs: [JugPair, JugPair]
  /** The first player to produce every required amount (always 0 in
   *  collaborative mode — the class solved it). Ends the game for everyone. */
  winner: 0 | 1 | null
}

/** Every legal operation on a two-jug board, in a fixed order — shared by the
 *  two BFS helpers below. */
const ALL_MOVES: WaterMove[] = [
  { op: 'fill', jug: 'small' },
  { op: 'fill', jug: 'big' },
  { op: 'empty', jug: 'small' },
  { op: 'empty', jug: 'big' },
  { op: 'pour', jug: 'small' },
  { op: 'pour', jug: 'big' },
]

/** …plus the reservoir's operations. No `fill` for it: there is no tap on an
 *  unlimited vessel. Pours to and from it are spelled out with explicit `to`. */
const STASH_MOVES: WaterMove[] = [
  { op: 'empty', jug: 'stash' },
  { op: 'pour', jug: 'small', to: 'stash' },
  { op: 'pour', jug: 'big', to: 'stash' },
  { op: 'pour', jug: 'stash', to: 'small' },
  { op: 'pour', jug: 'stash', to: 'big' },
]

function movesFor(stash: boolean): WaterMove[] {
  return stash ? [...ALL_MOVES, ...STASH_MOVES] : ALL_MOVES
}

/** Clamp so a malformed/out-of-range option never produces an unplayable board. */
function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(max, Math.max(min, v))
}

function amountIn(cur: Amounts, vessel: VesselId): number {
  return vessel === 'small' ? cur.small : vessel === 'big' ? cur.big : cur.stash
}

function withVessel(cur: Amounts, vessel: VesselId, value: number): Amounts {
  if (vessel === 'small') return { ...cur, small: value }
  if (vessel === 'big') return { ...cur, big: value }
  return { ...cur, stash: value }
}

/** The reservoir's "capacity" is infinite, which makes the pour arithmetic below
 *  fall out for free: Math.min(have, Infinity) = pour everything. */
function capacityOf(vessel: VesselId, smallCap: number, bigCap: number): number {
  return vessel === 'small' ? smallCap : vessel === 'big' ? bigCap : Infinity
}

/** Where a pour goes: the other jug by default (the original two-jug wire
 *  format), or wherever `to` says. A reservoir pour must say. */
function pourDest(move: WaterMove): VesselId | null {
  if (move.to !== undefined) return move.to
  if (move.jug === 'small') return 'big'
  if (move.jug === 'big') return 'small'
  return null
}

/** Apply a fill/empty/pour to one board, returning the new amounts. Pure, and
 *  total: anything that would change nothing (including an impossible pour)
 *  comes back as the input, which is what applyMove reads as "that does
 *  nothing" and the BFS helpers skip as a no-op edge. */
function step(cur: Amounts, smallCap: number, bigCap: number, move: WaterMove): Amounts {
  if (move.op === 'fill') {
    // No tap on the reservoir — filling an unlimited vessel never terminates.
    if (move.jug === 'stash') return cur
    return move.jug === 'small' ? { ...cur, small: smallCap } : { ...cur, big: bigCap }
  }
  if (move.op === 'empty') return withVessel(cur, move.jug, 0)

  const dest = pourDest(move)
  if (dest === null || dest === move.jug) return cur
  const have = amountIn(cur, move.jug)
  const room = capacityOf(dest, smallCap, bigCap) - amountIn(cur, dest)
  const amount = Math.min(have, room)
  if (amount <= 0) return cur
  return withVessel(withVessel(cur, move.jug, have - amount), dest, amountIn(cur, dest) + amount)
}

/** Every amount a board is showing right now: any vessel on its own, or any
 *  combination added together. (Without the reservoir this is exactly the
 *  original "either jug, or the two-jug total".) */
function readings(a: Amounts, stash: boolean): number[] {
  if (!stash) return [a.small, a.big, a.small + a.big]
  return [
    a.small,
    a.big,
    a.stash,
    a.small + a.big,
    a.small + a.stash,
    a.big + a.stash,
    a.small + a.big + a.stash,
  ]
}

const EMPTY: Amounts = { small: 0, big: 0, stash: 0 }

/**
 * Every amount in 1..target that can ever be shown, starting from empty
 * vessels. A BFS over the small state space of (small, big, stash) amounts.
 * This is what collect-all mode asks you to produce, so it can never demand an
 * amount the jugs physically can't make, and it's what keeps createWater from
 * setting an impossible single target. Sorted ascending.
 *
 * The reservoir makes the state space unbounded in principle, so the search
 * prunes any state holding more than `target + bigCap` in it. Nothing ≤ target
 * needs a bigger pile: water only leaves the reservoir by being poured into a
 * jug (at most bigCap of it at a time), so a taller stash can always be reached
 * by stashing less in the first place.
 */
function reachableValues(smallCap: number, bigCap: number, target: number, stash: boolean): number[] {
  const values = new Set<number>()
  const moves = movesFor(stash)
  const stashLimit = stash ? target + bigCap : 0
  const mark = (a: Amounts) => {
    for (const v of readings(a, stash)) if (v >= 1 && v <= target) values.add(v)
  }
  const key = (a: Amounts) => (a.small * (bigCap + 1) + a.big) * (stashLimit + 1) + a.stash
  const visited = new Set<number>([key(EMPTY)])
  const queue: Amounts[] = [EMPTY]
  mark(EMPTY)
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const move of moves) {
      const next = step(cur, smallCap, bigCap, move)
      if (next.small === cur.small && next.big === cur.big && next.stash === cur.stash) continue
      if (next.stash > stashLimit) continue
      const k = key(next)
      if (visited.has(k)) continue
      visited.add(k)
      mark(next)
      queue.push(next)
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
  const stash = !!options?.stash
  const collaborative = !!options?.collaborative
  const collectAll = !!options?.collectAll
  // Two jugs can never show more than their combined capacity at once; the
  // reservoir is what puts bigger amounts within reach, so it's what raises the
  // ceiling on the goal.
  const maxTarget = stash ? MAX_STASH_TARGET : smallCap + bigCap
  const wanted = clampInt(options?.target, 1, maxTarget, Math.min(8, maxTarget))
  const reach = reachableValues(smallCap, bigCap, wanted, stash)
  // A goal the vessels physically can't make (3 L out of a 2 L and a 4 L) would
  // be an unwinnable board, so drop to the largest amount they CAN make. With
  // coprime caps every amount is reachable, so this only ever fires when the
  // capacities share a factor.
  const target = reach.includes(wanted) ? wanted : reach.length > 0 ? reach[reach.length - 1] : wanted
  // Collect mode needs every reachable amount 1..target; single mode just the
  // one. (`reach` is non-empty for any sane config, but guard anyway so a
  // degenerate one can't yield a required-less instant win.)
  const required = collectAll ? (reach.length > 0 ? reach : [target]) : [target]
  const fresh = (): JugPair => ({ small: 0, big: 0, stash: 0, ops: 0, found: [] })
  return {
    turn: -1,
    smallCap,
    bigCap,
    target,
    collectAll,
    collaborative,
    stash,
    required,
    jugs: [fresh(), fresh()],
    winner: null,
  }
}

export type ApplyWaterMoveResult = { ok: true; state: WaterState } | { ok: false; error: string }

/**
 * Validates and applies a move. Never mutates `state` — same purity discipline
 * as the other rules modules: the server holds the previous state and only swaps
 * in the returned one on success. A move that changes nothing (filling a full
 * jug, emptying an empty one, pouring with an empty source or full destination,
 * filling the tap-less reservoir) is REJECTED, so the ops count stays an honest
 * measure of real progress.
 *
 * In COLLABORATIVE mode `playerIdx` is ignored and every move lands on the one
 * shared board: whichever of the two seats the tutor sends under (they're the
 * only one with controls), the class is pouring the same jugs.
 */
export function applyWaterMove(state: WaterState, playerIdx: 0 | 1, move: WaterMove): ApplyWaterMoveResult {
  if (state.winner !== null) return { ok: false, error: 'already solved' }
  if (playerIdx !== 0 && playerIdx !== 1) return { ok: false, error: 'bad player' }

  const op = move?.op
  if (op !== 'fill' && op !== 'empty' && op !== 'pour') return { ok: false, error: 'unknown operation' }
  const jug = move?.jug
  if (jug !== 'small' && jug !== 'big' && jug !== 'stash') return { ok: false, error: 'unknown vessel' }
  const to = move?.to
  if (to !== undefined && to !== 'small' && to !== 'big' && to !== 'stash') {
    return { ok: false, error: 'unknown destination' }
  }
  if (!state.stash && (jug === 'stash' || to === 'stash')) {
    return { ok: false, error: 'no reservoir in this game' }
  }
  if (op === 'pour' && jug === 'stash' && to === undefined) {
    return { ok: false, error: 'pouring out of the reservoir needs a destination' }
  }

  const idx: 0 | 1 = state.collaborative ? 0 : playerIdx
  const me = state.jugs[idx]
  const next = step(me, state.smallCap, state.bigCap, { op, jug, to })
  if (next.small === me.small && next.big === me.big && next.stash === me.stash) {
    return { ok: false, error: 'that does nothing' }
  }

  // `found` = the subset of `required` produced here: everything already had,
  // PLUS any required amount showing after this move. Filtering out of the
  // sorted `required` keeps it sorted, and "already had" means a collected
  // amount survives being poured off.
  const shown = readings(next, state.stash)
  const found = state.required.filter((v) => me.found.includes(v) || shown.includes(v))
  const updated: JugPair = { ...next, ops: me.ops + 1, found }
  const jugs: [JugPair, JugPair] = idx === 0 ? [updated, state.jugs[1]] : [state.jugs[0], updated]
  const winner: 0 | 1 | null = found.length === state.required.length ? idx : null
  return { ok: true, state: { ...state, jugs, winner } }
}

/**
 * The next operation on a SHORTEST path from a board's current amounts to one
 * that produces a required amount not yet collected, or `null` once they've all
 * been collected. A breadth-first search over the (tiny) state space — correct
 * by construction rather than a hand-rolled rule. In single-target mode this is
 * just "shortest path to `target`"; in collect-all mode it points at the nearest
 * still-missing amount. Drives the tutor-only hint chip, rendered on the host's
 * screen only and never sent to guests (guests receive the same game-state, so
 * the guard is render-time, per games-spec.md).
 *
 * The reservoir is bounded the same way reachableValues bounds it, allowing for
 * a board that has already stashed more than that.
 */
export function optimalWaterMove(state: WaterState, playerIdx: 0 | 1): WaterMove | null {
  const me = state.jugs[state.collaborative ? 0 : playerIdx]
  const { smallCap, bigCap, stash } = state
  const needs = state.required.filter((v) => !me.found.includes(v))
  if (needs.length === 0) return null
  const producesNeed = (a: Amounts) => {
    const shown = readings(a, stash)
    return needs.some((v) => shown.includes(v))
  }

  const moves = movesFor(stash)
  const stashLimit = stash ? Math.max(me.stash, state.target) + bigCap : 0
  const key = (a: Amounts) => (a.small * (bigCap + 1) + a.big) * (stashLimit + 1) + a.stash
  const start: Amounts = { small: me.small, big: me.big, stash: me.stash }
  const visited = new Set<number>([key(start)])
  const queue: { at: Amounts; first: WaterMove | null }[] = [{ at: start, first: null }]

  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const move of moves) {
      const next = step(cur.at, smallCap, bigCap, move)
      if (next.small === cur.at.small && next.big === cur.at.big && next.stash === cur.at.stash) continue
      if (next.stash > stashLimit) continue
      const k = key(next)
      if (visited.has(k)) continue
      const first = cur.first ?? move
      if (producesNeed(next)) return first
      visited.add(k)
      queue.push({ at: next, first })
    }
  }
  return null
}
