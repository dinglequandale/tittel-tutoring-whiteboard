// Headless unit test for the pure Pizza Cutting Problem rules in
// shared/games/pizza.ts.
//
// Run with:  node test/pizza.mjs
import { createPizza, applyPizzaMove, piecesForCuts, chordEndpoints } from '../shared/games/pizza.ts'

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

function pizza(maxCuts) {
  return createPizza({ maxCuts })
}

// ---- createPizza ------------------------------------------------------------
{
  const s = pizza(8)
  check('createPizza starts with no cuts', s.cuts.length === 0)
  check('createPizza starts at turn 0', s.turn === 0)
  check('createPizza starts nextCut at 1', s.nextCut === 1)
  check('createPizza starts not done', s.done === false)
  check('createPizza starts at 1 piece (uncut)', s.pieces === 1)
  check('createPizza starts with empty log', s.log.length === 0)
}
check('createPizza clamps maxCuts below range up to 1', createPizza({ maxCuts: 0 }).maxCuts === 1)
check('createPizza clamps maxCuts above range down to 12', createPizza({ maxCuts: 999 }).maxCuts === 12)

// ---- piecesForCuts: the lazy caterer's sequence -----------------------------
{
  const expected = [1, 2, 4, 7, 11, 16, 22, 29, 37, 46, 56, 67, 79]
  expected.forEach((want, n) => check(`piecesForCuts(${n}) === ${want}`, piecesForCuts(n) === want))
}

// ---- applyPizzaMove: legality ------------------------------------------------
{
  const s = pizza(10)
  const r = applyPizzaMove(s, 0, { count: 0 })
  check('rejects count 0', r.ok === false)
}
{
  const s = pizza(10)
  const r = applyPizzaMove(s, 0, { count: -1 })
  check('rejects negative count', r.ok === false)
}
{
  const s = pizza(10)
  const r = applyPizzaMove(s, 0, { count: 1.5 })
  check('rejects non-integer count', r.ok === false)
}
{
  const s = pizza(10)
  const r = applyPizzaMove(s, 0, {})
  check('rejects a missing count', r.ok === false)
}
{
  const s = pizza(10)
  const r = applyPizzaMove(s, 0, { count: 1 })
  check('accepts a legal single-step move', r.ok === true)
}
{
  const s = pizza(10)
  const r = applyPizzaMove(s, 0, { count: 999 })
  check('a count larger than what remains is clamped, not rejected', r.ok === true && r.state.done === true)
}

// ---- applyPizzaMove: turn enforcement ----------------------------------------
{
  const s = pizza(10) // turn: 0
  const r = applyPizzaMove(s, 1, { count: 1 })
  check('wrong playerIdx (not their turn) is rejected', r.ok === false)
}
{
  const s = pizza(10)
  const r1 = applyPizzaMove(s, 0, { count: 1 })
  const r2 = applyPizzaMove(r1.state, 0, { count: 1 }) // still player 0, but turn flipped to 1
  check('same player moving twice in a row is rejected', r2.ok === false)
}
{
  const s = pizza(10)
  const r1 = applyPizzaMove(s, 0, { count: 1 })
  check('turn flips after a move', r1.state.turn === 1)
}

// ---- applyPizzaMove: rejected once done --------------------------------------
{
  let s = pizza(3)
  s = applyPizzaMove(s, 0, { count: 3 }).state
  check('making every remaining cut marks the board done', s.done === true)
  const r = applyPizzaMove(s, s.turn, { count: 1 })
  check('a move after done is rejected', r.ok === false)
}

// ---- purity: applyPizzaMove never mutates its input state -------------------
{
  const s = pizza(10)
  const before = JSON.parse(JSON.stringify(s))
  const r = applyPizzaMove(s, 0, { count: 3 })
  check('purity: input state object unchanged after a successful move', JSON.stringify(s) === JSON.stringify(before))
  check('purity: returned state is a different object', r.state !== s)
}
{
  const s = pizza(10)
  const before = JSON.parse(JSON.stringify(s))
  applyPizzaMove(s, 1, { count: 1 }) // illegal: not player 1's turn
  check('purity: input state unchanged after a REJECTED move too', JSON.stringify(s) === JSON.stringify(before))
}

// ---- nextCut bookkeeping and pieces tracking ---------------------------------
{
  let s = pizza(10)
  s = applyPizzaMove(s, 0, { count: 3 }).state // cuts 1..3 made
  check('nextCut advances by count', s.nextCut === 4)
  check('pieces matches piecesForCuts after a batch', s.pieces === piecesForCuts(3))
  s = applyPizzaMove(s, 1, { count: 5 }).state // cuts 4..8 made
  check('nextCut keeps advancing across moves', s.nextCut === 9)
  check('pieces keeps matching piecesForCuts across moves', s.pieces === piecesForCuts(8))
}

// ---- the full theorem: after every cut, running through the real
// applyPizzaMove one cut at a time keeps pieces in lockstep with the
// closed-form sequence, for a range of board sizes. --------------------------
for (const maxCuts of [1, 2, 3, 4, 8, 12]) {
  let s = createPizza({ maxCuts })
  let turn = 0
  let ok = true
  while (!s.done) {
    const r = applyPizzaMove(s, turn, { count: 1 })
    if (!r.ok) {
      ok = false
      break
    }
    s = r.state
    check(`maxCuts=${maxCuts}: pieces after ${s.cuts.length} cut(s) matches the formula`, s.pieces === piecesForCuts(s.cuts.length))
    turn = turn === 0 ? 1 : 0
  }
  check(`maxCuts=${maxCuts}: single-step moves stayed legal until done`, ok)
  check(`maxCuts=${maxCuts}: finished with maxCuts cuts made`, s.cuts.length === maxCuts)
}

// ---- fast-forwarding in one big move matches stepping one at a time --------
{
  const maxCuts = 10
  let stepwise = createPizza({ maxCuts })
  let turn = 0
  while (!stepwise.done) {
    stepwise = applyPizzaMove(stepwise, turn, { count: 1 }).state
    turn = turn === 0 ? 1 : 0
  }
  let jumped = createPizza({ maxCuts })
  jumped = applyPizzaMove(jumped, 0, { count: maxCuts }).state
  check(
    'running one big move for all cuts matches stepping through them one at a time',
    JSON.stringify(stepwise.cuts) === JSON.stringify(jumped.cuts),
  )
  check('both reach the same final piece count', stepwise.pieces === jumped.pieces)
  check('a single big move also finishes done', jumped.done === true)
}

// ---- general position: every cut's angle and offset are distinct from every
// earlier one, across the full range this demo supports — the precondition
// the closed-form piece count above relies on. --------------------------------
{
  let s = createPizza({ maxCuts: 12 })
  let turn = 0
  while (!s.done) {
    s = applyPizzaMove(s, turn, { count: 1 }).state
    turn = turn === 0 ? 1 : 0
  }
  const angles = s.cuts.map((c) => c.angleDeg)
  const offsets = s.cuts.map((c) => c.offset)
  check('no two cuts share an angle (mod 180)', new Set(angles.map((a) => a.toFixed(6))).size === angles.length)
  check('no two cuts share an offset', new Set(offsets.map((o) => o.toFixed(6))).size === offsets.length)
  check('every offset stays comfortably inside the circle (|offset| < 1)', offsets.every((o) => Math.abs(o) < 1))
}

// ---- chordEndpoints -----------------------------------------------------------
{
  const radius = 100
  const endpoints = chordEndpoints({ angleDeg: 0, offset: 0 }, radius)
  check('a cut through center spans the full diameter', endpoints !== null && Math.abs(endpoints.x2 - endpoints.x1) === 2 * radius)
}
{
  const radius = 100
  const c = { angleDeg: 37, offset: 0.4 }
  const endpoints = chordEndpoints(c, radius)
  check('chordEndpoints returns a chord for a normal offset', endpoints !== null)
  if (endpoints) {
    const d1 = Math.hypot(endpoints.x1, endpoints.y1)
    const d2 = Math.hypot(endpoints.x2, endpoints.y2)
    check('endpoint 1 lies on the circle', Math.abs(d1 - radius) < 1e-9)
    check('endpoint 2 lies on the circle', Math.abs(d2 - radius) < 1e-9)
  }
}
{
  const endpoints = chordEndpoints({ angleDeg: 0, offset: 1.5 }, 100)
  check('an out-of-range offset returns null rather than NaN coordinates', endpoints === null)
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
