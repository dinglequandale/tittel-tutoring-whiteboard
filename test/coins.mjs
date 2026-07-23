// Headless unit test for the pure "Coins on a Round Table" rules in
// shared/games/coins.ts.
//
// Run with:  node test/coins.mjs
import {
  createCoins,
  applyCoinsMove,
  optimalCoinsMove,
  isPlayable,
  playablePoints,
  isFreeformLegal,
  placedCoins,
} from '../shared/games/coins.ts'

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const EPS = 1e-6
function sameCoord(c, x, y) {
  return c && Math.abs(c.x - x) < EPS && Math.abs(c.y - y) < EPS
}

// ---- createCoins ------------------------------------------------------------
{
  const s = createCoins({ rectangle: false, centerBlocked: false, across: 6 })
  check('createCoins defaults to a circular table', s.shape === 'circle')
  check('createCoins generates candidate points', s.points.length > 6)
  check('createCoins starts at turn 0', s.turn === 0)
  check('createCoins starts empty and not over', s.occupied.length === 0 && s.over === false)
  check('centerIndex points at the exact center', Math.abs(s.points[s.centerIndex].x - 0.5) < EPS && Math.abs(s.points[s.centerIndex].y - 0.5) < EPS)
  check('spacing equals one coin diameter (points 2·radius apart)', Math.abs(1 / 6 - 2 * s.radius) < EPS)
}
check('createCoins clamps across below range up to 4', createCoins({ across: 1 }).radius === 1 / 4 / 2)
check('createCoins clamps across above range down to 9', createCoins({ across: 99 }).radius === 1 / 9 / 2)

// ---- geometry: every coin sits fully on the table ---------------------------
for (const rectangle of [false, true]) {
  const s = createCoins({ rectangle, centerBlocked: false, across: 6 })
  const r = s.radius
  const allInside = s.points.every((p) => {
    if (rectangle) return Math.abs(p.x - 0.5) <= 0.5 - r + EPS && Math.abs(p.y - 0.5) <= 0.33 - r + EPS
    return Math.hypot(p.x - 0.5, p.y - 0.5) <= 0.5 - r + EPS
  })
  check(`${rectangle ? 'rectangle' : 'circle'}: every candidate coin lies fully inside the table`, allInside)
}

// ---- non-overlap: any two distinct candidate points are >= 2r apart --------
{
  const s = createCoins({ across: 6 })
  const r = s.radius
  let minD = Infinity
  for (let i = 0; i < s.points.length; i++) {
    for (let j = i + 1; j < s.points.length; j++) {
      minD = Math.min(minD, Math.hypot(s.points[i].x - s.points[j].x, s.points[i].y - s.points[j].y))
    }
  }
  check('closest two candidate points are exactly a coin-diameter apart (never overlap)', minD >= 2 * r - EPS)
}

// ---- 180° symmetry: mirror is a total, self-inverse map; center is fixed ----
{
  const s = createCoins({ across: 6 })
  let ok = true
  for (let i = 0; i < s.points.length; i++) {
    const m = s.mirror[i]
    if (m < 0) { ok = false; break }
    // points[m] must be the 180° image of points[i] about the center.
    if (Math.abs(s.points[m].x - (1 - s.points[i].x)) > EPS || Math.abs(s.points[m].y - (1 - s.points[i].y)) > EPS) { ok = false; break }
    if (s.mirror[m] !== i) { ok = false; break } // involution
  }
  check('mirror is total, exact, and an involution', ok)
  check('the center is its own mirror', s.mirror[s.centerIndex] === s.centerIndex)
  check('candidate count is odd (center + mirror pairs)', s.points.length % 2 === 1)
}

// ---- legality ----------------------------------------------------------------
{
  const s = createCoins({ across: 6 })
  check('a fresh point is playable', isPlayable(s, 0))
  check('an out-of-range index is not playable', !isPlayable(s, s.points.length))
  const r = applyCoinsMove(s, 0, { point: 0 })
  check('a legal placement is accepted', r.ok && r.state.occupied.length === 1)
  check('turn flips after a placement', r.ok && r.state.turn === 1)
  check('placing on an occupied point is rejected', applyCoinsMove(r.state, 1, { point: 0 }).ok === false)
  check('wrong turn is rejected', applyCoinsMove(s, 1, { point: 1 }).ok === false)
  check('a non-integer point is rejected', applyCoinsMove(s, 0, { point: 1.5 }).ok === false)
}
{
  const s = createCoins({ centerBlocked: true, across: 6 })
  check('the blocked center is not playable', !isPlayable(s, s.centerIndex))
  check('placing on the blocked center is rejected', applyCoinsMove(s, 0, { point: s.centerIndex }).ok === false)
  check('the blocked center is excluded from playablePoints', !playablePoints(s).includes(s.centerIndex))
}

// ---- purity ------------------------------------------------------------------
{
  const s = createCoins({ across: 6 })
  const before = JSON.stringify(s)
  const r = applyCoinsMove(s, 0, { point: 0 })
  check('purity: input unchanged after a successful move', JSON.stringify(s) === before)
  check('purity: returned state is a new object', r.state !== s)
}

// ---- the theorem: the game always lasts exactly (playable count) moves, so
// the winner is decided purely by parity — and blocking the center (which
// removes one point) flips that parity, i.e. flips the winner. --------------
function playToEnd(s, order) {
  let turn = 0
  let moves = 0
  for (const pt of order) {
    if (!isPlayable(s, pt)) continue
    const r = applyCoinsMove(s, turn, { point: pt })
    if (!r.ok) throw new Error('unexpected illegal move filling the board')
    s = r.state
    moves++
    if (s.winner !== null) break
    turn = turn === 0 ? 1 : 0
  }
  return { state: s, moves }
}
for (const centerBlocked of [false, true]) {
  const s = createCoins({ centerBlocked, across: 6 })
  const order = playablePoints(s) // any order fills the whole board — every free point is always legal
  const count = order.length
  const { state, moves } = playToEnd(s, order)
  check(`${centerBlocked ? 'blocked' : 'open'} center: the board fills completely`, moves === count && state.winner !== null)
  // Player 0 places moves 1,3,5…; the last placer is (count-1) % 2.
  const expectedWinner = (count - 1) % 2
  check(`${centerBlocked ? 'blocked' : 'open'} center: winner is the last placer (parity ${expectedWinner})`, state.winner === expectedWinner)
}
{
  // Same board, blocking the center flips who wins.
  const open = createCoins({ centerBlocked: false, across: 6 })
  const blocked = createCoins({ centerBlocked: true, across: 6 })
  const wOpen = playToEnd(open, playablePoints(open)).state.winner
  const wBlocked = playToEnd(blocked, playablePoints(blocked)).state.winner
  check('blocking the center flips the winner', wOpen !== wBlocked)
}

// ---- the mirror strategy the tutor overlay demonstrates (lattice) -----------
{
  const s = createCoins({ across: 6 })
  const c = s.points[s.centerIndex]
  const opening = optimalCoinsMove(s)
  check('opening hint is to take the center', opening && opening.kind === 'center' && sameCoord(opening, c.x, c.y))

  // Center taken, opponent plays some non-center point q → hint mirrors q.
  const afterCenter = applyCoinsMove(s, 0, { point: s.centerIndex }).state
  const q = playablePoints(afterCenter)[0]
  const afterQ = applyCoinsMove(afterCenter, 1, { point: q }).state
  const mq = s.points[s.mirror[q]]
  const mirror = optimalCoinsMove(afterQ)
  check('after an opponent coin, hint is its 180° mirror', mirror && mirror.kind === 'mirror' && sameCoord(mirror, mq.x, mq.y))
  const mi = afterQ.points.findIndex((p) => sameCoord(p, mirror.x, mirror.y))
  check('the mirror point is actually playable', isPlayable(afterQ, mi))
}
{
  // With the center blocked there is no winning FIRST move to point at.
  const s = createCoins({ centerBlocked: true, across: 6 })
  check('blocked-center opening has no hint', optimalCoinsMove(s) === null)
}
{
  // If a player takes the center, its mirror is itself (now occupied) — the
  // opponent has no mirror reply, which is exactly why the center is winning.
  const s = createCoins({ across: 6 })
  const afterCenter = applyCoinsMove(s, 0, { point: s.centerIndex }).state
  check('no mirror exists for the center coin itself', optimalCoinsMove(afterCenter) === null)
}

// ---- freeform mode: the real game -------------------------------------------
{
  const s = createCoins({ freeform: true, across: 6 })
  check('freeform: mode is freeform', s.mode === 'freeform')
  check('freeform: no lattice points', s.points.length === 0 && s.centerIndex === -1)
  check('freeform: starts empty and not over', s.placed.length === 0 && s.over === false)
  check('freeform: center-block is ignored (measure zero)', createCoins({ freeform: true, centerBlocked: true }).centerBlocked === false)

  // Placement legality: inside the table and non-overlapping.
  check('freeform: a coin at the center is legal', isFreeformLegal(s, 0.5, 0.5))
  check('freeform: a coin off the table edge is illegal', !isFreeformLegal(s, 0.99, 0.5))
  const r = applyCoinsMove(s, 0, { x: 0.5, y: 0.5 })
  check('freeform: a legal placement is accepted', r.ok && r.state.placed.length === 1)
  check('freeform: turn flips, game not over', r.ok && r.state.turn === 1 && r.state.over === false)
  check('freeform: overlapping the just-placed coin is illegal', !isFreeformLegal(r.state, 0.5 + s.radius, 0.5))
  check('freeform: a coin exactly a diameter away is legal (tangent)', isFreeformLegal(r.state, 0.5 + 2 * s.radius, 0.5))
  check('freeform: an overlapping placement is rejected', applyCoinsMove(r.state, 1, { x: 0.5 + s.radius, y: 0.5 }).ok === false)
  check('freeform: a non-numeric placement is rejected', applyCoinsMove(s, 0, { x: 'a', y: 0.5 }).ok === false)
}
{
  // Concede: the player to move is stuck, so they lose and the other wins.
  const s = createCoins({ freeform: true, across: 6 })
  const afterOne = applyCoinsMove(s, 0, { x: 0.5, y: 0.5 }).state // player 0 placed, now player 1 to move
  const r = applyCoinsMove(afterOne, 1, { concede: true })
  check('freeform: conceding ends the game', r.ok && r.state.over && r.state.winner !== null)
  check('freeform: the stuck (to-move) player loses; the last placer wins', r.state.winner === 0)
}
{
  // The mirror hint works in freeform too, as coordinates.
  const s = createCoins({ freeform: true, across: 6 })
  const opening = optimalCoinsMove(s)
  check('freeform: opening hint is the exact center', opening && opening.kind === 'center' && sameCoord(opening, 0.5, 0.5))
  const afterCenter = applyCoinsMove(s, 0, { x: 0.5, y: 0.5 }).state
  // A point well clear of the center coin (>= one diameter away), so both it and
  // its mirror image are legal placements.
  const afterQ = applyCoinsMove(afterCenter, 1, { x: 0.7, y: 0.5 }).state
  const mirror = optimalCoinsMove(afterQ)
  check('freeform: after an opponent coin, hint is its exact 180° image', mirror && mirror.kind === 'mirror' && sameCoord(mirror, 0.3, 0.5))
  check('freeform: the mirror spot is a legal placement', mirror && isFreeformLegal(afterQ, mirror.x, mirror.y))
}
{
  // placedCoins reports explicit coords + alternating owners in both modes.
  const s = createCoins({ freeform: true, across: 6 })
  let st = applyCoinsMove(s, 0, { x: 0.5, y: 0.5 }).state
  st = applyCoinsMove(st, 1, { x: 0.7, y: 0.5 }).state
  const list = placedCoins(st)
  check('placedCoins: reports each coin with an alternating owner', list.length === 2 && list[0].by === 0 && list[1].by === 1)
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
