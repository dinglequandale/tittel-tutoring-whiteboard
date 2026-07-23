// Headless unit test for the pure "Balance" (two-pile Nim) rules in
// shared/games/balance.ts.
//
// Run with:  node test/balance.mjs
import { createBalance, applyBalanceMove, optimalBalanceMove } from '../shared/games/balance.ts'

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

/** Build a bare state directly, so tests can reach pile sizes (like 0) that
 *  createBalance's clamp would never produce. */
function pos(a, b, misere = false) {
  return { piles: [a, b], turn: 0, over: false, winner: null, misere, log: [] }
}

// ---- createBalance ----------------------------------------------------------
{
  const s = createBalance({ a: 5, b: 8, misere: false })
  check('createBalance uses the given pile sizes', s.piles[0] === 5 && s.piles[1] === 8)
  check('createBalance starts at turn 0', s.turn === 0)
  check('createBalance starts not over', s.over === false && s.winner === null)
  check('createBalance starts with empty log', s.log.length === 0)
}
check('createBalance clamps a below range up to 1', createBalance({ a: 0, b: 5, misere: false }).piles[0] === 1)
check('createBalance clamps b above range down to 20', createBalance({ a: 5, b: 999, misere: false }).piles[1] === 20)
check('createBalance defaults a garbage option', createBalance({ a: 'x', b: NaN, misere: false }).piles[0] === 5)

// ---- applyBalanceMove: legality ---------------------------------------------
check('rejects count 0', applyBalanceMove(pos(5, 8), 0, { pile: 0, count: 0 }).ok === false)
check('rejects negative count', applyBalanceMove(pos(5, 8), 0, { pile: 0, count: -2 }).ok === false)
check('rejects non-integer count', applyBalanceMove(pos(5, 8), 0, { pile: 0, count: 1.5 }).ok === false)
check('rejects taking more than the pile holds', applyBalanceMove(pos(5, 8), 0, { pile: 0, count: 6 }).ok === false)
check('rejects a bad pile index', applyBalanceMove(pos(5, 8), 0, { pile: 2, count: 1 }).ok === false)
check('rejects taking from an empty pile', applyBalanceMove(pos(0, 8), 0, { pile: 0, count: 1 }).ok === false)
check('accepts a legal move', applyBalanceMove(pos(5, 8), 0, { pile: 1, count: 3 }).ok === true)

// ---- applyBalanceMove: turn enforcement -------------------------------------
check('wrong playerIdx rejected', applyBalanceMove(pos(5, 8), 1, { pile: 0, count: 1 }).ok === false)
{
  const r1 = applyBalanceMove(pos(5, 8), 0, { pile: 0, count: 1 })
  check('turn flips after a move', r1.state.turn === 1)
  const r2 = applyBalanceMove(r1.state, 0, { pile: 0, count: 1 })
  check('same player moving twice is rejected', r2.ok === false)
}

// ---- win detection ----------------------------------------------------------
{
  // (0, 3): player 0 takes all 3 → empties both piles → player 0 wins (normal).
  const r = applyBalanceMove(pos(0, 3), 0, { pile: 1, count: 3 })
  check('taking the last stone wins (normal play)', r.ok && r.state.over && r.state.winner === 0)
}
{
  // Misère: taking the last stone LOSES, so the winner is the other player.
  const r = applyBalanceMove(pos(0, 3, true), 0, { pile: 1, count: 3 })
  check('taking the last stone loses (misère) — other player wins', r.ok && r.state.winner === 1)
}
check('a move after the game is over is rejected', applyBalanceMove({ ...pos(0, 0), over: true, winner: 0 }, 1, { pile: 0, count: 1 }).ok === false)

// ---- purity -----------------------------------------------------------------
{
  const s = pos(5, 8)
  const before = JSON.stringify(s)
  const r = applyBalanceMove(s, 0, { pile: 1, count: 3 })
  check('purity: input unchanged after a successful move', JSON.stringify(s) === before)
  check('purity: returned state is a new object', r.state !== s)
}
{
  const s = pos(5, 8)
  const before = JSON.stringify(s)
  applyBalanceMove(s, 1, { pile: 0, count: 1 }) // illegal
  check('purity: input unchanged after a REJECTED move too', JSON.stringify(s) === before)
}

// ---- optimalBalanceMove: normal play ----------------------------------------
{
  const m = optimalBalanceMove(pos(5, 8))
  check('normal: equalizes by reducing the larger pile', m && m.pile === 1 && m.count === 3)
  // Applying it leaves the piles equal (a losing position for the opponent).
  const after = applyBalanceMove(pos(5, 8), 0, m).state
  check('normal: the winning move leaves the piles equal', after.piles[0] === after.piles[1])
}
check('normal: equal piles have no winning move', optimalBalanceMove(pos(6, 6)) === null)
check('normal: reduces from the OTHER larger pile too', (() => {
  const m = optimalBalanceMove(pos(9, 4))
  return m && m.pile === 0 && m.count === 5
})())

// ---- cross-check against an independent minimax, normal AND misère ----------
// A position is "lost" for the player to move iff every move hands the
// opponent a win. Base case (0,0): under normal play the mover can't move and
// so loses; under misère the opponent just took the last stone and loses, so
// the mover has already won.
function moverLoses(a, b, misere, memo) {
  if (a === 0 && b === 0) return !misere
  const key = `${a <= b ? a : b},${a <= b ? b : a},${misere}`
  const cached = memo.get(key)
  if (cached !== undefined) return cached
  let loss = true
  for (let k = 1; k <= a && loss; k++) if (moverLoses(a - k, b, misere, memo)) loss = false
  for (let k = 1; k <= b && loss; k++) if (moverLoses(a, b - k, misere, memo)) loss = false
  memo.set(key, loss)
  return loss
}

for (const misere of [false, true]) {
  const memo = new Map()
  let allNullMatchesLoss = true
  let allMovesActuallyWin = true
  for (let a = 0; a <= 9; a++) {
    for (let b = 0; b <= 9; b++) {
      if (a === 0 && b === 0) continue
      const state = pos(a, b, misere)
      const move = optimalBalanceMove(state)
      const lost = moverLoses(a, b, misere, memo)
      // null (no winning move) must line up exactly with a lost position.
      if ((move === null) !== lost) allNullMatchesLoss = false
      // When a move is offered, playing it must hand the opponent a lost position.
      if (move !== null) {
        const after = applyBalanceMove(state, 0, move)
        if (!after.ok || !moverLoses(after.state.piles[0], after.state.piles[1], misere, memo)) {
          allMovesActuallyWin = false
        }
      }
    }
  }
  check(`${misere ? 'misère' : 'normal'}: "no winning move" matches lost positions exactly`, allNullMatchesLoss)
  check(`${misere ? 'misère' : 'normal'}: every suggested move actually wins`, allMovesActuallyWin)
}

// ---- a full optimal-vs-greedy game: the optimal follower wins from a
// winning start, for a range of starts (normal play). -----------------------
for (const [a, b] of [[5, 8], [3, 7], [1, 4], [9, 2], [10, 6]]) {
  let s = pos(a, b)
  let turn = 0
  let steps = 0
  while (s.winner === null && steps < 200) {
    let move
    if (turn === 0) {
      move = optimalBalanceMove(s) // player 0 plays perfectly (start is a win for them)
    } else {
      // player 1 plays a simple legal move: take 1 from a non-empty pile.
      const p = s.piles[0] > 0 ? 0 : 1
      move = { pile: p, count: 1 }
    }
    const r = applyBalanceMove(s, turn, move)
    if (!r.ok) break
    s = r.state
    turn = turn === 0 ? 1 : 0
    steps++
  }
  check(`optimal player 0 wins from (${a}, ${b})`, s.winner === 0)
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
