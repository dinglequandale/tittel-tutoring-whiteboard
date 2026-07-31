// Headless unit test for the pure "Water Jugs" race rules in
// shared/games/water.ts.
//
// Run with:  node test/water.mjs
import { createWater, applyWaterMove, optimalWaterMove } from '../shared/games/water.ts'

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

function board(j) {
  return { small: j.small ?? 0, big: j.big ?? 0, stash: j.stash ?? 0, ops: j.ops ?? 0, found: j.found ?? [] }
}

/** Build a bare state so tests can set exact jug amounts createWater never would.
 *  Defaults to single-target mode (required = [target]); pass `required` for a
 *  collect-all board, and `opts` for `{ stash, collaborative }`. */
function pos(a, b, target, jug0 = {}, jug1 = {}, required = [target], opts = {}) {
  return {
    turn: -1,
    smallCap: a,
    bigCap: b,
    target,
    collectAll: required.length > 1,
    collaborative: !!opts.collaborative,
    stash: !!opts.stash,
    required,
    jugs: [board(jug0), board(jug1)],
    winner: null,
  }
}

// ---- createWater ------------------------------------------------------------
{
  const s = createWater({ smallCap: 3, bigCap: 5, target: 8 })
  check('createWater keeps the caps', s.smallCap === 3 && s.bigCap === 5)
  check('createWater keeps the target', s.target === 8)
  check('createWater is simultaneous (turn -1)', s.turn === -1)
  check('createWater starts both jugs empty', s.jugs[0].small === 0 && s.jugs[1].big === 0)
  check('createWater starts with no winner', s.winner === null)
}
check('createWater orders caps small<=big', (() => {
  const s = createWater({ smallCap: 7, bigCap: 2, target: 5 })
  return s.smallCap === 2 && s.bigCap === 7
})())
check('createWater clamps target down to small+big', createWater({ smallCap: 3, bigCap: 5, target: 99 }).target === 8)
check('createWater defaults a garbage target to min(8, cap sum)', createWater({ smallCap: 3, bigCap: 5, target: 'x' }).target === 8)

// ---- fill / empty / pour mechanics ------------------------------------------
{
  const r = applyWaterMove(pos(3, 5, 4), 0, { op: 'fill', jug: 'big' })
  check('fill big fills to capacity', r.ok && r.state.jugs[0].big === 5)
  check('fill increments the mover ops', r.ok && r.state.jugs[0].ops === 1)
  check('fill leaves the OTHER player untouched', r.ok && r.state.jugs[1].big === 0 && r.state.jugs[1].ops === 0)
}
{
  // Classic Die-Hard step: 5-full poured into empty 3 → (3, 2).
  const r = applyWaterMove(pos(3, 5, 4, { small: 0, big: 5 }), 0, { op: 'pour', jug: 'big' })
  check('pour big→small fills small and leaves the remainder', r.ok && r.state.jugs[0].small === 3 && r.state.jugs[0].big === 2)
}
{
  // Pour small→big stops when the destination is full.
  const r = applyWaterMove(pos(3, 5, 4, { small: 3, big: 4 }), 0, { op: 'pour', jug: 'small' })
  check('pour small→big stops at destination capacity', r.ok && r.state.jugs[0].small === 2 && r.state.jugs[0].big === 5)
}
{
  const r = applyWaterMove(pos(3, 5, 4, { small: 3, big: 0 }), 0, { op: 'empty', jug: 'small' })
  check('empty small zeroes it', r.ok && r.state.jugs[0].small === 0)
}

// ---- no-op rejection --------------------------------------------------------
check('filling a full jug is rejected', applyWaterMove(pos(3, 5, 4, { small: 3, big: 0 }), 0, { op: 'fill', jug: 'small' }).ok === false)
check('emptying an empty jug is rejected', applyWaterMove(pos(3, 5, 4), 0, { op: 'empty', jug: 'big' }).ok === false)
check('pour with an empty source is rejected', applyWaterMove(pos(3, 5, 4), 0, { op: 'pour', jug: 'small' }).ok === false)
check('pour into a full destination is rejected', applyWaterMove(pos(3, 5, 4, { small: 3, big: 5 }), 0, { op: 'pour', jug: 'small' }).ok === false)
check('unknown op rejected', applyWaterMove(pos(3, 5, 4), 0, { op: 'slosh', jug: 'small' }).ok === false)
check('bad jug rejected', applyWaterMove(pos(3, 5, 4), 0, { op: 'fill', jug: 'huge' }).ok === false)

// ---- win detection ----------------------------------------------------------
{
  // target 8 with 3/5: only both-full reaches it. Fill small on a (0,5) state.
  const r = applyWaterMove(pos(3, 5, 8, { small: 0, big: 5 }), 0, { op: 'fill', jug: 'small' })
  check('reaching the target as a TOTAL wins', r.ok && r.state.winner === 0)
}
{
  // target 4 in ONE jug: (2,5) pour big→small → (3,4), so big holds exactly 4.
  const r = applyWaterMove(pos(3, 5, 4, { small: 2, big: 5 }), 0, { op: 'pour', jug: 'big' })
  check('reaching the target in ONE jug wins', r.ok && r.state.jugs[0].big === 4 && r.state.winner === 0)
}
{
  // Player 1 races to a single-jug target of 5 (fill big).
  const r = applyWaterMove(pos(3, 5, 5, { small: 0, big: 0 }, { small: 0, big: 0 }), 1, { op: 'fill', jug: 'big' })
  check('player 1 can win independently', r.ok && r.state.winner === 1)
}
check('a move after the race is won is rejected', applyWaterMove({ ...pos(3, 5, 8), winner: 0 }, 1, { op: 'fill', jug: 'big' }).ok === false)

// ---- both players move independently (no shared turn) -----------------------
{
  let s = pos(3, 5, 8)
  const a = applyWaterMove(s, 0, { op: 'fill', jug: 'small' })
  check('player 0 moves from a fresh race', a.ok)
  const b = applyWaterMove(a.state, 1, { op: 'fill', jug: 'big' })
  check('player 1 also moves — no turn blocks them', b.ok && b.state.jugs[1].big === 5)
  check('each move touched only its own side', b.state.jugs[0].small === 3 && b.state.jugs[0].big === 0)
}

// ---- purity -----------------------------------------------------------------
{
  const s = pos(3, 5, 8)
  const before = JSON.stringify(s)
  const r = applyWaterMove(s, 0, { op: 'fill', jug: 'big' })
  check('purity: input unchanged after a successful move', JSON.stringify(s) === before)
  check('purity: returned state is a new object', r.state !== s)
  check('purity: the untouched player object is unchanged', r.state.jugs[1] === s.jugs[1] || JSON.stringify(r.state.jugs[1]) === JSON.stringify(s.jugs[1]))
}
{
  const s = pos(3, 5, 8, { small: 3, big: 0 })
  const before = JSON.stringify(s)
  applyWaterMove(s, 0, { op: 'fill', jug: 'small' }) // no-op, rejected
  check('purity: input unchanged after a REJECTED move too', JSON.stringify(s) === before)
}

// ---- optimalWaterMove: BFS shortest path ------------------------------------
check('optimal returns null once all required amounts are collected', optimalWaterMove(pos(3, 5, 8, { small: 3, big: 5, found: [8] }), 0) === null)

// Following the hint from empty state must actually reach every reachable goal,
// and do so in the fewest moves (cross-checked below by an independent BFS).
function bfsDistance(smallCap, bigCap, target) {
  const isGoal = (s, b) => s === target || b === target || s + b === target
  const key = (s, b) => s * (bigCap + 1) + b
  const start = key(0, 0)
  if (isGoal(0, 0)) return 0
  const dist = new Map([[start, 0]])
  const q = [[0, 0]]
  while (q.length) {
    const [s, b] = q.shift()
    const d = dist.get(key(s, b))
    const nexts = [
      [smallCap, b], [s, bigCap], [0, b], [s, 0],
      [s - Math.min(s, bigCap - b), b + Math.min(s, bigCap - b)],
      [s + Math.min(b, smallCap - s), b - Math.min(b, smallCap - s)],
    ]
    for (const [ns, nb] of nexts) {
      if (ns === s && nb === b) continue
      const k = key(ns, nb)
      if (dist.has(k)) continue
      if (isGoal(ns, nb)) return d + 1
      dist.set(k, d + 1)
      q.push([ns, nb])
    }
  }
  return Infinity
}

// Drive the game by always following optimalWaterMove; it must reach the goal in
// exactly the BFS distance for a spread of caps/targets.
for (const [sc, bc, target] of [[3, 5, 8], [3, 5, 4], [3, 5, 1], [3, 5, 7], [5, 7, 6], [2, 5, 4]]) {
  const want = bfsDistance(sc, bc, target)
  let s = pos(sc, bc, target)
  let steps = 0
  let reachedIn = -1
  while (steps < 60) {
    const move = optimalWaterMove(s, 0)
    if (move === null) break // shouldn't happen before winning for these targets
    const r = applyWaterMove(s, 0, move)
    if (!r.ok) { reachedIn = -2; break }
    steps++
    if (r.state.winner === 0) { reachedIn = steps; break }
    s = r.state
  }
  check(`optimal reaches ${target} L (caps ${sc}/${bc}) in the BFS-minimal ${want} moves`, reachedIn === want)
}

// ---- collect-all mode -------------------------------------------------------
{
  const s = createWater({ smallCap: 3, bigCap: 5, target: 8, collectAll: true })
  check('collect: required is every amount 1..8 for coprime 3/5', JSON.stringify(s.required) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]))
  check('collect: collectAll flag set', s.collectAll === true)
  check('collect: found starts empty', s.jugs[0].found.length === 0)
}
{
  // With even/even caps (2/4) the odd amounts are unreachable — collect mode must
  // only require the amounts the jugs can actually make, so the race stays winnable.
  const s = createWater({ smallCap: 2, bigCap: 4, target: 4, collectAll: true })
  check('collect: unreachable odd amounts are excluded (2/4 → no 1 or 3)', !s.required.includes(1) && !s.required.includes(3))
  check('collect: reachable even amounts are required (2/4 → 2 and 4)', s.required.includes(2) && s.required.includes(4))
}
{
  // Producing an amount collects it, and it stays collected after being poured off.
  let s = createWater({ smallCap: 3, bigCap: 5, target: 8, collectAll: true })
  s = applyWaterMove(s, 0, { op: 'fill', jug: 'small' }).state // small = 3
  check('collect: producing 3 collects it', s.jugs[0].found.includes(3))
  check('collect: not won after collecting just one amount', s.winner === null)
  s = applyWaterMove(s, 0, { op: 'empty', jug: 'small' }).state // small = 0
  check('collect: 3 stays collected after pouring it away', s.jugs[0].found.includes(3))
}
{
  // Following the hint must eventually collect ALL required amounts and win.
  let s = createWater({ smallCap: 3, bigCap: 5, target: 8, collectAll: true })
  let steps = 0
  while (steps < 300) {
    const move = optimalWaterMove(s, 0)
    if (move === null) break
    const r = applyWaterMove(s, 0, move)
    if (!r.ok) break
    steps++
    if (r.state.winner === 0) { s = r.state; break }
    s = r.state
  }
  check('collect: hint-driven play collects all 1..8 and wins', s.winner === 0 && s.jugs[0].found.length === s.required.length)
}
{
  // The two racers collect independently — one winning doesn't touch the other's
  // progress, and player 1 can be the winner.
  let s = createWater({ smallCap: 3, bigCap: 5, target: 3, collectAll: true }) // required: reachable in 1..3
  let steps = 0
  while (steps < 100) {
    const move = optimalWaterMove(s, 1)
    if (move === null) break
    const r = applyWaterMove(s, 1, move)
    if (!r.ok) break
    steps++
    if (r.state.winner === 1) { s = r.state; break }
    s = r.state
  }
  check('collect: player 1 can win, player 0 untouched', s.winner === 1 && s.jugs[0].found.length === 0)
}

// ---- collaborative mode -----------------------------------------------------
{
  const s = createWater({ smallCap: 3, bigCap: 5, target: 8, collaborative: true })
  check('collab: flag set', s.collaborative === true)
  check('collab: still simultaneous (turn -1)', s.turn === -1)
}
{
  // The tutor may send under EITHER seat — both land on the one shared board.
  const s = pos(3, 5, 8, {}, {}, [8], { collaborative: true })
  const a = applyWaterMove(s, 1, { op: 'fill', jug: 'big' })
  check('collab: a seat-1 move lands on the shared board', a.ok && a.state.jugs[0].big === 5)
  check('collab: the second board stays untouched', a.ok && a.state.jugs[1].big === 0 && a.state.jugs[1].ops === 0)
  const b = applyWaterMove(a.state, 0, { op: 'fill', jug: 'small' })
  check('collab: moves from both seats accumulate on the same board', b.ok && b.state.jugs[0].small === 3 && b.state.jugs[0].ops === 2)
  check('collab: solving it wins as board 0 whoever sent the move', b.state.winner === 0)
}
check(
  'collab: the hint reads the shared board no matter which seat is asked',
  (() => {
    const s = pos(3, 5, 8, { small: 0, big: 5 }, {}, [8], { collaborative: true })
    const a = optimalWaterMove(s, 0)
    const b = optimalWaterMove(s, 1)
    return JSON.stringify(a) === JSON.stringify(b) && a.op === 'fill' && a.jug === 'small'
  })(),
)

// ---- the infinite reservoir -------------------------------------------------
{
  const s = createWater({ smallCap: 3, bigCap: 5, target: 12, stash: true })
  check('stash: flag set', s.stash === true)
  check('stash: a goal past small+big is allowed', s.target === 12)
  check('stash: boards start with an empty reservoir', s.jugs[0].stash === 0)
  check('stash: off by default', createWater({ smallCap: 3, bigCap: 5, target: 8 }).stash === false)
  check('stash: without it the goal is still clamped to small+big', createWater({ smallCap: 3, bigCap: 5, target: 12 }).target === 8)
  check('stash: the goal is capped at MAX_STASH_TARGET', createWater({ smallCap: 3, bigCap: 5, target: 999, stash: true }).target === 30)
}
{
  const opts = { stash: true }
  const r = applyWaterMove(pos(3, 5, 12, { small: 3 }, {}, [12], opts), 0, { op: 'pour', jug: 'small', to: 'stash' })
  check('stash: pouring a jug in moves ALL of it (no capacity to fill)', r.ok && r.state.jugs[0].small === 0 && r.state.jugs[0].stash === 3)
}
{
  const opts = { stash: true }
  const r = applyWaterMove(pos(3, 5, 12, { stash: 9 }, {}, [12], opts), 0, { op: 'pour', jug: 'stash', to: 'big' })
  check('stash: drawing out fills the destination to the brim', r.ok && r.state.jugs[0].big === 5 && r.state.jugs[0].stash === 4)
}
{
  const opts = { stash: true }
  const r = applyWaterMove(pos(3, 5, 12, { stash: 2 }, {}, [12], opts), 0, { op: 'pour', jug: 'stash', to: 'small' })
  check('stash: drawing less than a jugful leaves a partial amount', r.ok && r.state.jugs[0].small === 2 && r.state.jugs[0].stash === 0)
}
{
  const opts = { stash: true }
  const r = applyWaterMove(pos(3, 5, 12, { stash: 4 }, {}, [12], opts), 0, { op: 'empty', jug: 'stash' })
  check('stash: it can be dumped out', r.ok && r.state.jugs[0].stash === 0)
}
{
  const opts = { stash: true }
  // 4 stashed + a full big jug + a full small jug = 12, the point of the option:
  // an amount two 3/5 jugs could never show between them.
  const r = applyWaterMove(pos(3, 5, 12, { small: 0, big: 5, stash: 4 }, {}, [12], opts), 0, { op: 'fill', jug: 'small' })
  check('stash: the goal counts jugs + reservoir together', r.ok && r.state.winner === 0)
}
check(
  'stash: filling it from the tap is rejected (it would never end)',
  applyWaterMove(pos(3, 5, 12, {}, {}, [12], { stash: true }), 0, { op: 'fill', jug: 'stash' }).ok === false,
)
check(
  'stash: pouring out of it with no destination is rejected',
  applyWaterMove(pos(3, 5, 12, { stash: 5 }, {}, [12], { stash: true }), 0, { op: 'pour', jug: 'stash' }).ok === false,
)
check(
  'stash: reservoir moves are rejected when the option is off',
  applyWaterMove(pos(3, 5, 8, { small: 3 }), 0, { op: 'pour', jug: 'small', to: 'stash' }).ok === false,
)
check(
  'stash: an unknown destination is rejected',
  applyWaterMove(pos(3, 5, 8, { small: 3 }), 0, { op: 'pour', jug: 'small', to: 'bucket' }).ok === false,
)
{
  const s = pos(3, 5, 12, { small: 3, stash: 4 }, {}, [12], { stash: true })
  const before = JSON.stringify(s)
  applyWaterMove(s, 0, { op: 'pour', jug: 'small', to: 'stash' })
  check('stash: purity — a reservoir move leaves the input untouched', JSON.stringify(s) === before)
}
{
  // Coprime caps + a reservoir = every positive integer, which is the whole
  // pedagogical point: 1..12 is all reachable even though the jugs hold 8.
  const s = createWater({ smallCap: 3, bigCap: 5, target: 12, stash: true, collectAll: true })
  check(
    'stash: collect-all requires every amount 1..12 with coprime 3/5',
    JSON.stringify(s.required) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  )
}
{
  // A shared factor still bounds it — 2/4 can only ever show even amounts, with
  // or without somewhere to stash them.
  const s = createWater({ smallCap: 2, bigCap: 4, target: 10, stash: true, collectAll: true })
  check('stash: a shared factor keeps the odds unreachable (2/4)', JSON.stringify(s.required) === JSON.stringify([2, 4, 6, 8, 10]))
  check('stash: an impossible single goal falls back to the nearest reachable one', createWater({ smallCap: 2, bigCap: 4, target: 7, stash: true }).target === 6)
}
check(
  'an impossible goal falls back to the nearest reachable one without a reservoir too',
  createWater({ smallCap: 2, bigCap: 4, target: 3 }).target === 2,
)
{
  // Hint-driven play must actually solve a reservoir board — for a goal beyond
  // small+big, and for the full 1..12 collection.
  for (const collectAll of [false, true]) {
    let s = createWater({ smallCap: 3, bigCap: 5, target: 12, stash: true, collectAll })
    let steps = 0
    while (steps < 600) {
      const move = optimalWaterMove(s, 0)
      if (move === null) break
      const r = applyWaterMove(s, 0, move)
      if (!r.ok) break
      steps++
      s = r.state
      if (s.winner === 0) break
    }
    check(`stash: hint-driven play solves the 12 L board (collectAll ${collectAll})`, s.winner === 0)
  }
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
