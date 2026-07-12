// Headless unit test for the pure Locker Problem rules in
// shared/games/lockers.ts.
//
// Run with:  node test/lockers.mjs
import { createLockers, applyLockersMove, isPerfectSquare } from '../shared/games/lockers.ts'

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

function lockers(lockerCount) {
  return createLockers({ lockerCount })
}

// ---- createLockers ---------------------------------------------------------
{
  const s = lockers(10)
  check('createLockers starts every locker closed', s.open.every((o) => o === false))
  check('createLockers open has length === lockerCount', s.open.length === 10)
  check('createLockers starts every locker untouched', s.touched.every((t) => t === 0))
  check('createLockers touched has length === lockerCount', s.touched.length === 10)
  check('createLockers starts at turn 0', s.turn === 0)
  check('createLockers starts nextStudent at 1', s.nextStudent === 1)
  check('createLockers starts not done', s.done === false)
  check('createLockers starts with empty log', s.log.length === 0)
}
check('createLockers clamps lockerCount below range up to 4', createLockers({ lockerCount: 0 }).lockerCount === 4)
check('createLockers clamps lockerCount above range down to 200', createLockers({ lockerCount: 99999 }).lockerCount === 200)

// ---- applyLockersMove: legality --------------------------------------------
{
  const s = lockers(20)
  const r = applyLockersMove(s, 0, { count: 0 })
  check('rejects count 0', r.ok === false)
}
{
  const s = lockers(20)
  const r = applyLockersMove(s, 0, { count: -1 })
  check('rejects negative count', r.ok === false)
}
{
  const s = lockers(20)
  const r = applyLockersMove(s, 0, { count: 1.5 })
  check('rejects non-integer count', r.ok === false)
}
{
  const s = lockers(20)
  const r = applyLockersMove(s, 0, {})
  check('rejects a missing count', r.ok === false)
}
{
  const s = lockers(20)
  const r = applyLockersMove(s, 0, { count: 1 })
  check('accepts a legal single-step move', r.ok === true)
}
{
  const s = lockers(20)
  const r = applyLockersMove(s, 0, { count: 999 })
  check('a count larger than what remains is clamped, not rejected', r.ok === true && r.state.done === true)
}

// ---- applyLockersMove: turn enforcement ------------------------------------
{
  const s = lockers(20) // turn: 0
  const r = applyLockersMove(s, 1, { count: 1 })
  check('wrong playerIdx (not their turn) is rejected', r.ok === false)
}
{
  const s = lockers(20)
  const r1 = applyLockersMove(s, 0, { count: 1 })
  const r2 = applyLockersMove(r1.state, 0, { count: 1 }) // still player 0, but turn flipped to 1
  check('same player moving twice in a row is rejected', r2.ok === false)
}
{
  const s = lockers(20)
  const r1 = applyLockersMove(s, 0, { count: 1 })
  check('turn flips after a move', r1.state.turn === 1)
}

// ---- applyLockersMove: rejected once done ----------------------------------
{
  let s = lockers(4)
  s = applyLockersMove(s, 0, { count: 4 }).state
  check('running every remaining student marks the board done', s.done === true)
  const r = applyLockersMove(s, s.turn, { count: 1 })
  check('a move after done is rejected', r.ok === false)
}

// ---- purity: applyLockersMove never mutates its input state ----------------
{
  const s = lockers(15)
  const before = JSON.parse(JSON.stringify(s))
  const r = applyLockersMove(s, 0, { count: 3 })
  check('purity: input state object unchanged after a successful move', JSON.stringify(s) === JSON.stringify(before))
  check('purity: returned state is a different object', r.state !== s)
}
{
  const s = lockers(15)
  const before = JSON.parse(JSON.stringify(s))
  applyLockersMove(s, 1, { count: 1 }) // illegal: not player 1's turn
  check('purity: input state unchanged after a REJECTED move too', JSON.stringify(s) === JSON.stringify(before))
}

// ---- nextStudent bookkeeping ------------------------------------------------
{
  let s = lockers(20)
  s = applyLockersMove(s, 0, { count: 3 }).state // students 1..3 ran
  check('nextStudent advances by count', s.nextStudent === 4)
  s = applyLockersMove(s, 1, { count: 5 }).state // students 4..8 ran
  check('nextStudent keeps advancing across moves', s.nextStudent === 9)
}

// ---- toggling math: locker n is touched by exactly its divisors -----------
{
  let s = lockers(30)
  s = applyLockersMove(s, 0, { count: 1 }).state // student 1: opens every locker
  check('student 1 opens every locker', s.open.every((o) => o === true))
  s = applyLockersMove(s, 1, { count: 1 }).state // student 2: toggles every 2nd
  check('student 2 closes every even locker', s.open.every((o, i) => (((i + 1) % 2 === 0) ? o === false : o === true)))
  check('every locker touched once by student 1', s.touched.every((t, i) => t >= 1))
  check('even lockers touched twice (students 1 and 2)', s.touched.every((t, i) => (((i + 1) % 2 === 0) ? t === 2 : t === 1)))
}

// ---- touched[] bookkeeping: matches divisor count once every student ran --
function divisorCount(n) {
  let c = 0
  for (let d = 1; d <= n; d++) if (n % d === 0) c++
  return c
}
for (const lockerCount of [10, 30, 99]) {
  let s = createLockers({ lockerCount })
  let turn = 0
  while (!s.done) {
    s = applyLockersMove(s, turn, { count: 1 }).state
    turn = turn === 0 ? 1 : 0
  }
  const expectedTouched = s.touched.map((_, i) => divisorCount(i + 1))
  check(
    `lockerCount=${lockerCount}: final touched[] equals each locker's divisor count`,
    JSON.stringify(s.touched) === JSON.stringify(expectedTouched),
  )
  check(
    `lockerCount=${lockerCount}: open lockers are exactly those with an ODD touched count`,
    s.open.every((o, i) => o === (s.touched[i] % 2 === 1)),
  )
}

// ---- the actual theorem: after every student, open lockers are exactly the
// perfect squares — verified for a range of sizes by running the full
// simulation through the real applyLockersMove, not by re-deriving the
// closed-form claim. ------------------------------------------------------
for (const lockerCount of [1, 2, 3, 4, 9, 10, 16, 25, 30, 99, 100]) {
  let s = createLockers({ lockerCount })
  let turn = 0
  while (!s.done) {
    const r = applyLockersMove(s, turn, { count: 1 })
    if (!r.ok) {
      check(`lockerCount=${lockerCount}: single-step move stayed legal until done`, false)
      break
    }
    s = r.state
    turn = turn === 0 ? 1 : 0
  }
  const expectedOpen = s.open.map((_, i) => isPerfectSquare(i + 1))
  check(
    `lockerCount=${lockerCount}: final open lockers are exactly the perfect squares`,
    JSON.stringify(s.open) === JSON.stringify(expectedOpen),
  )
}

// ---- fast-forwarding in one big move matches stepping one at a time -------
{
  const lockerCount = 50
  let stepwise = createLockers({ lockerCount })
  let turn = 0
  while (!stepwise.done) {
    stepwise = applyLockersMove(stepwise, turn, { count: 1 }).state
    turn = turn === 0 ? 1 : 0
  }
  let jumped = createLockers({ lockerCount })
  jumped = applyLockersMove(jumped, 0, { count: lockerCount }).state
  check(
    'running one big move for all students matches stepping through them one at a time',
    JSON.stringify(stepwise.open) === JSON.stringify(jumped.open),
  )
  check('a single big move also finishes done', jumped.done === true)
}

// ---- isPerfectSquare --------------------------------------------------------
check('isPerfectSquare(1) is true', isPerfectSquare(1) === true)
check('isPerfectSquare(4) is true', isPerfectSquare(4) === true)
check('isPerfectSquare(9) is true', isPerfectSquare(9) === true)
check('isPerfectSquare(2) is false', isPerfectSquare(2) === false)
check('isPerfectSquare(99) is false', isPerfectSquare(99) === false)
check('isPerfectSquare(100) is true', isPerfectSquare(100) === true)

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
