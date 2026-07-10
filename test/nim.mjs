// Headless unit test for the pure Nim rules in shared/games/nim.ts.
//
// Run with:  node test/nim.mjs
import { createNim, applyNimMove, optimalNimMove } from '../shared/games/nim.ts'

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

function nim(pile, extra = {}) {
  return createNim({ pile, maxTake: 3, misere: false, ...extra })
}

// ---- createNim ------------------------------------------------------------
{
  const s = nim(5)
  check('createNim builds tokens t0..t{pile-1}', JSON.stringify(s.tokens) === JSON.stringify(['t0', 't1', 't2', 't3', 't4']))
  check('createNim starts empty taken', s.taken.length === 0)
  check('createNim starts at turn 0', s.turn === 0)
  check('createNim starts with no winner', s.winner === null)
  check('createNim starts with empty log', s.log.length === 0)
}
check('createNim clamps pile below range up to 1', createNim({ pile: 0, maxTake: 3, misere: false }).tokens.length === 1)
check('createNim clamps pile above range down to 60', createNim({ pile: 999, maxTake: 3, misere: false }).tokens.length === 60)
check('createNim clamps maxTake below range up to 1', createNim({ pile: 10, maxTake: 0, misere: false }).maxTake === 1)
check('createNim clamps maxTake above range down to 5', createNim({ pile: 10, maxTake: 99, misere: false }).maxTake === 5)

// ---- applyNimMove: legality -----------------------------------------------
{
  const s = nim(21)
  const r = applyNimMove(s, 0, { tokenIds: [] })
  check('rejects empty tokenIds', r.ok === false)
}
{
  const s = nim(21)
  const r = applyNimMove(s, 0, { tokenIds: ['t0', 't0'] })
  check('rejects duplicate ids', r.ok === false)
}
{
  const s = nim(21)
  const r = applyNimMove(s, 0, { tokenIds: ['t0', 'ghost'] })
  check('rejects ids not in the pile', r.ok === false)
}
{
  const s = nim(21)
  const r = applyNimMove(s, 0, { tokenIds: ['t0', 't1', 't2', 't3'] }) // maxTake is 3
  check('rejects count > maxTake', r.ok === false)
}
{
  const s = nim(21)
  const r = applyNimMove(s, 0, { tokenIds: ['t0', 't1'] })
  check('accepts a legal move', r.ok === true)
}

// ---- applyNimMove: turn enforcement ----------------------------------------
{
  const s = nim(21) // turn: 0
  const r = applyNimMove(s, 1, { tokenIds: ['t0'] })
  check('wrong playerIdx (not their turn) is rejected', r.ok === false)
}
{
  const s = nim(21)
  const r1 = applyNimMove(s, 0, { tokenIds: ['t0'] })
  const r2 = applyNimMove(r1.state, 0, { tokenIds: ['t1'] }) // still player 0's move, but turn flipped to 1
  check('same player moving twice in a row is rejected', r2.ok === false)
}

// ---- applyNimMove: rejected once a winner exists ---------------------------
{
  let s = nim(1) // one token; player 0 takes it and wins immediately (normal play)
  const r1 = applyNimMove(s, 0, { tokenIds: ['t0'] })
  check('taking the last token produces a winner', r1.ok === true && r1.state.winner === 0)
  const r2 = applyNimMove(r1.state, 1, { tokenIds: [] })
  check('a move with no tokens after a winner exists is still rejected for that reason too', r2.ok === false)
  // Construct a state with tokens still present but a winner already set, to
  // specifically exercise the "winner !== null short-circuits everything
  // else" branch rather than piggybacking on the empty-pile case above.
  const wonEarly = { ...nim(5), winner: 0 }
  const r3 = applyNimMove(wonEarly, wonEarly.turn, { tokenIds: ['t0'] })
  check('a structurally legal move is rejected once winner is already set', r3.ok === false)
}

// ---- winner determination: normal play -------------------------------------
{
  // pile of 4, maxTake 3: player 0 takes all 4 in two moves and empties the pile.
  let s = nim(4)
  s = applyNimMove(s, 0, { tokenIds: ['t0'] }).state
  s = applyNimMove(s, 1, { tokenIds: ['t1', 't2', 't3'] }).state
  check('normal play: whoever empties the pile wins (player 1 here)', s.winner === 1)
}
{
  let s = nim(3)
  s = applyNimMove(s, 0, { tokenIds: ['t0', 't1', 't2'] }).state
  check('normal play: taking the last token(s) directly wins for that player', s.winner === 0)
}

// ---- winner determination: misere -------------------------------------------
{
  let s = nim(3, { misere: true })
  s = applyNimMove(s, 0, { tokenIds: ['t0', 't1', 't2'] }).state
  check('misere: the player who empties the pile LOSES (opponent wins)', s.winner === 1)
}
{
  let s = nim(4, { misere: true })
  s = applyNimMove(s, 0, { tokenIds: ['t0'] }).state
  s = applyNimMove(s, 1, { tokenIds: ['t1', 't2', 't3'] }).state
  check('misere: opponent of whoever empties the pile is declared winner', s.winner === 0)
}

// ---- purity: applyNimMove never mutates its input state --------------------
{
  const s = nim(10)
  const before = JSON.parse(JSON.stringify(s))
  const r = applyNimMove(s, 0, { tokenIds: ['t0', 't1'] })
  check('purity: input state object unchanged after a successful move', JSON.stringify(s) === JSON.stringify(before))
  check('purity: returned state is a different object', r.state !== s)
}
{
  const s = nim(10)
  const before = JSON.parse(JSON.stringify(s))
  applyNimMove(s, 1, { tokenIds: ['t0'] }) // illegal: not player 1's turn
  check('purity: input state unchanged after a REJECTED move too', JSON.stringify(s) === JSON.stringify(before))
}
{
  // The move's own tokenIds array must not be touched either (defensive: some
  // naive implementations sort/splice the caller's array in place).
  const s = nim(10)
  const move = { tokenIds: ['t2', 't0'] }
  const moveBefore = JSON.parse(JSON.stringify(move))
  applyNimMove(s, 0, move)
  check('purity: the move object passed in is not mutated', JSON.stringify(move) === JSON.stringify(moveBefore))
}

// ---- optimalNimMove: property test -----------------------------------------
// For every pile size 1..25, in both normal and misère play, verify that
// optimalNimMove is a genuine winning strategy: a player who always follows
// it beats an opponent who tries EVERY possible legal reply at each of their
// turns (full game-tree search, not random sampling, and not just re-deriving
// the closed-form formula — every branch is played out through the real
// applyNimMove, so a bug in ITS legality/winner logic would also be caught).
// Where optimalNimMove returns null, the position must be genuinely lost:
// every one of this player's legal replies must let the opponent force a win.
//
// Memoized by (tokens remaining, whose turn) rather than by exact token ids:
// legality and win/loss depend only on the COUNT of tokens left (all ids are
// interchangeable to the rules), so every state with the same count+turn has
// an identical subtree. Without this the search is a real ~3^25-node tree.
function playerCanForceWin(state, player) {
  const memo = new Map() // "n:turn" -> can the mover force a win with n tokens left?
  function moverCanForceWin(n, turn) {
    const key = `${n}:${turn}`
    if (memo.has(key)) return memo.get(key)
    // Token identity is irrelevant to legality/winner logic, only the count
    // is — so any n-token pile is representative of the real reachable state.
    const synthetic = {
      tokens: Array.from({ length: n }, (_, i) => `t${i}`),
      taken: [],
      turn,
      maxTake: state.maxTake,
      misere: state.misere,
      winner: null,
      log: [],
    }
    const maxTake = Math.min(synthetic.maxTake, n)
    let canWin = false
    for (let take = 1; take <= maxTake && !canWin; take++) {
      const result = applyNimMove(synthetic, turn, { tokenIds: synthetic.tokens.slice(0, take) })
      if (!result.ok) continue
      if (result.state.winner !== null) {
        if (result.state.winner === turn) canWin = true
        continue
      }
      const nextTurn = turn === 0 ? 1 : 0
      if (!moverCanForceWin(result.state.tokens.length, nextTurn)) canWin = true
    }
    memo.set(key, canWin)
    return canWin
  }
  const moverWins = moverCanForceWin(state.tokens.length, state.turn)
  return state.turn === player ? moverWins : !moverWins
}

for (const misere of [false, true]) {
  for (let pile = 1; pile <= 25; pile++) {
    const state = createNim({ pile, maxTake: 3, misere })
    const hint = optimalNimMove(state)
    const mode = misere ? 'misere' : 'normal'
    const positionIsWinning = playerCanForceWin(state, 0) // player 0 is always to move on a fresh pile

    check(`${mode} pile=${pile}: optimalNimMove is null exactly when the position is lost`, (hint === null) === !positionIsWinning)

    if (hint === null) {
      // Every one of player 0's legal replies must hand the opponent a forced win.
      const maxTake = Math.min(state.maxTake, state.tokens.length)
      let everyReplyLoses = true
      for (let take = 1; take <= maxTake; take++) {
        const result = applyNimMove(state, 0, { tokenIds: state.tokens.slice(0, take) })
        if (!result.ok) continue
        const stillWinningForP0 =
          result.state.winner !== null ? result.state.winner === 0 : playerCanForceWin(result.state, 0)
        if (stillWinningForP0) everyReplyLoses = false
      }
      check(`${mode} pile=${pile}: every reply from a lost position still loses`, everyReplyLoses)
    } else {
      // Taking `hint` now must be legal and must leave player 0 still winning
      // against every possible opponent reply, exhaustively.
      const afterHint = applyNimMove(state, 0, { tokenIds: state.tokens.slice(0, hint) })
      check(`${mode} pile=${pile}: hinted move ${hint} is legal`, afterHint.ok === true)
      if (afterHint.ok) {
        const stillWinning =
          afterHint.state.winner !== null ? afterHint.state.winner === 0 : playerCanForceWin(afterHint.state, 0)
        check(`${mode} pile=${pile}: optimalNimMove(${hint}) is a genuine winning strategy`, stillWinning)
      }
    }
  }
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
