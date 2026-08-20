// Headless unit test for the pure Sim rules in shared/games/sim.ts
// ("Don't Make a Triangle").
//
// Run with:  node test/sim.mjs
//
// Two of these tests are the lesson itself, not just regression cover:
//   • the pentagon/pentagram draw at 5 dots — the counterexample the class
//     hunts for, pinned so a refactor can never quietly make it unreachable;
//   • R(3,3) = 6 by brute force over all 2^15 colorings of the 6-dot board —
//     every one of them must contain a monochromatic triangle, which is exactly
//     the theorem the students prove. A bug in triangle detection fails here
//     loudly instead of showing a class a "draw" that can't exist.
import {
  createSim,
  applySimMove,
  edgePairs,
  edgeIndex,
  edgeCount,
  suicideEdges,
  monochromaticTriangles,
} from '../shared/games/sim.ts'

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

/** Play a list of edge indices in order, alternating players from state.turn. */
function playAll(state, edges) {
  let s = state
  for (const e of edges) {
    const r = applySimMove(s, s.turn, { edge: e })
    if (!r.ok) return { state: s, failedAt: e, error: r.error }
    s = r.state
  }
  return { state: s, failedAt: null }
}

// ---- edge indexing ---------------------------------------------------------
{
  const pairs = edgePairs(6)
  check('edgePairs(6) has 15 pairs', pairs.length === 15)
  check('edgeCount(6) agrees with edgePairs(6).length', edgeCount(6) === pairs.length)
  check(
    'edgePairs(6) is lexicographic with a < b',
    JSON.stringify(pairs.slice(0, 6)) === JSON.stringify([[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 2]]),
  )
  check('edgePairs(6) ends at [4,5]', JSON.stringify(pairs[14]) === JSON.stringify([4, 5]))
  check(
    'edgePairs is deterministic (same input, identical output)',
    JSON.stringify(edgePairs(6)) === JSON.stringify(edgePairs(6)),
  )

  // Round-trip, both directions, for every board size the game allows.
  let roundTrips = true
  let inverseOk = true
  for (let n = 4; n <= 8; n++) {
    const ps = edgePairs(n)
    if (ps.length !== (n * (n - 1)) / 2) roundTrips = false
    ps.forEach(([a, b], i) => {
      if (edgeIndex(n, a, b) !== i) roundTrips = false
      if (edgeIndex(n, b, a) !== i) inverseOk = false // endpoint order must not matter
    })
  }
  check('edgeIndex round-trips edgePairs for dots 4..8', roundTrips)
  check('edgeIndex ignores endpoint order', inverseOk)
  check('edgeIndex rejects a self-loop', edgeIndex(6, 3, 3) === -1)
  check('edgeIndex rejects an out-of-range dot', edgeIndex(6, 0, 6) === -1 && edgeIndex(6, -1, 2) === -1)
}

// ---- createSim -------------------------------------------------------------
{
  const s = createSim({ dots: 6 })
  check('createSim(6) starts with 15 uncolored edges', s.edges.length === 15 && s.edges.every((c) => c === null))
  check('createSim starts at turn 0 (red moves first)', s.turn === 0)
  check('createSim starts undecided', s.winner === null && s.done === false && s.losingTriangle === null)
  check('createSim starts with an empty log', s.log.length === 0)
}
check('createSim clamps dots below range up to 4', createSim({ dots: 2 }).dots === 4)
check('createSim clamps dots above range down to 8', createSim({ dots: 99 }).dots === 8)
check('createSim falls back to 6 dots on a malformed option', createSim({ dots: 'six' }).dots === 6)
check('createSim rounds a fractional dot count', createSim({ dots: 5.4 }).dots === 5)

// ---- applySimMove: legality ------------------------------------------------
{
  const s = createSim({ dots: 6 })
  check('rejects a non-integer edge', applySimMove(s, 0, { edge: 1.5 }).ok === false)
  check('rejects a negative edge', applySimMove(s, 0, { edge: -1 }).ok === false)
  check('rejects an edge past the end', applySimMove(s, 0, { edge: 15 }).ok === false)
  check('rejects a missing move object', applySimMove(s, 0, undefined).ok === false)
  check('rejects a non-numeric edge', applySimMove(s, 0, { edge: '3' }).ok === false)
  check('accepts a legal move', applySimMove(s, 0, { edge: 0 }).ok === true)
}
{
  const s = createSim({ dots: 6 })
  const r1 = applySimMove(s, 0, { edge: 4 })
  check('rejects re-coloring an already-colored segment', applySimMove(r1.state, 1, { edge: 4 }).ok === false)
}

// ---- applySimMove: turn alternation ----------------------------------------
{
  const s = createSim({ dots: 6 })
  check('wrong playerIdx (not their turn) is rejected', applySimMove(s, 1, { edge: 0 }).ok === false)
  const r1 = applySimMove(s, 0, { edge: 0 })
  check('turn flips to player 1 after player 0 moves', r1.state.turn === 1)
  check('the same player moving twice in a row is rejected', applySimMove(r1.state, 0, { edge: 1 }).ok === false)
  const r2 = applySimMove(r1.state, 1, { edge: 1 })
  check('turn flips back to player 0', r2.state.turn === 0)
  check('each edge records its mover', r2.state.edges[0] === 0 && r2.state.edges[1] === 1)
  check(
    'log records every move in order',
    JSON.stringify(r2.state.log) === JSON.stringify([{ player: 0, edge: 0 }, { player: 1, edge: 1 }]),
  )
}

// ---- purity ----------------------------------------------------------------
{
  const s = createSim({ dots: 6 })
  const before = JSON.stringify(s)
  const r = applySimMove(s, 0, { edge: 7 })
  check('purity: input state unchanged after a successful move', JSON.stringify(s) === before)
  check('purity: returned state is a different object', r.state !== s)
  check('purity: returned edges is a different array', r.state.edges !== s.edges)
}
{
  const s = createSim({ dots: 6 })
  const before = JSON.stringify(s)
  applySimMove(s, 1, { edge: 0 }) // illegal: not player 1's turn
  applySimMove(s, 0, { edge: 99 }) // illegal: no such edge
  check('purity: input state unchanged after REJECTED moves too', JSON.stringify(s) === before)
}
{
  const s = createSim({ dots: 6 })
  const move = { edge: 3 }
  const moveBefore = JSON.stringify(move)
  applySimMove(s, 0, move)
  check('purity: the move object passed in is not mutated', JSON.stringify(move) === moveBefore)
}

// ---- a scripted loss: red closes a triangle ---------------------------------
{
  // Red (player 0) takes the triangle 0-1-2; blue takes three harmless
  // segments off dot 3/4/5 that never repeat a pair.
  const e01 = edgeIndex(6, 0, 1)
  const e02 = edgeIndex(6, 0, 2)
  const e12 = edgeIndex(6, 1, 2)
  const script = [e01, edgeIndex(6, 3, 4), e02, edgeIndex(6, 3, 5), e12]
  const { state: s, failedAt } = playAll(createSim({ dots: 6 }), script)
  check('scripted loss: every move in the script was legal', failedAt === null)
  check('scripted loss: the game is done', s.done === true)
  check('scripted loss: the triangle-maker LOSES — winner is player 1', s.winner === 1)
  check(
    'scripted loss: losingTriangle names the three edges of 0-1-2 (ascending)',
    JSON.stringify(s.losingTriangle) === JSON.stringify([e01, e02, e12].sort((x, y) => x - y)),
  )
  check('scripted loss: the board is NOT full — the triangle ended it early', s.edges.some((c) => c === null))
  check('scripted loss: further moves are rejected', applySimMove(s, s.turn, { edge: edgeIndex(6, 4, 5) }).ok === false)
}
{
  // The mirror case: blue closes the triangle, so red wins.
  const script = [
    edgeIndex(6, 0, 1), // red
    edgeIndex(6, 2, 3), // blue
    edgeIndex(6, 0, 2), // red
    edgeIndex(6, 2, 4), // blue
    edgeIndex(6, 1, 5), // red (avoids closing 0-1-2)
    edgeIndex(6, 3, 4), // blue closes 2-3-4
  ]
  const { state: s, failedAt } = playAll(createSim({ dots: 6 }), script)
  check('scripted loss (blue): every move in the script was legal', failedAt === null)
  check('scripted loss (blue): winner is player 0', s.done === true && s.winner === 0)
}

// ---- the pentagon draw at 5 dots -------------------------------------------
{
  // The counterexample showing 6 dots is necessary: color the perimeter
  // 0-1-2-3-4-0 one color and the pentagram 0-2-4-1-3-0 the other, and neither
  // player ever holds a triangle. Interleaved so the turns alternate legally.
  const perimeter = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]].map(([a, b]) => edgeIndex(5, a, b))
  const pentagram = [[0, 2], [1, 3], [2, 4], [3, 0], [4, 1]].map(([a, b]) => edgeIndex(5, a, b))
  const script = []
  for (let i = 0; i < 5; i++) {
    script.push(perimeter[i]) // red
    script.push(pentagram[i]) // blue
  }
  const { state: s, failedAt } = playAll(createSim({ dots: 5 }), script)
  check('pentagon draw: every move in the script was legal', failedAt === null)
  check('pentagon draw: all 10 segments are colored', s.edges.length === 10 && s.edges.every((c) => c !== null))
  check('pentagon draw: the game is done', s.done === true)
  check('pentagon draw: there is NO winner — this is a genuine draw', s.winner === null)
  check('pentagon draw: no losing triangle was recorded', s.losingTriangle === null)
  check(
    'pentagon draw: the finished board really has no monochromatic triangle',
    monochromaticTriangles(5, s.edges).length === 0,
  )
  check('pentagon draw: no further move is accepted', applySimMove(s, s.turn, { edge: 0 }).ok === false)
}

// ---- R(3,3) = 6: brute force over all 2^15 colorings ------------------------
{
  const n = 6
  const m = edgeCount(n) // 15
  const total = 1 << m // 32768
  let drawFree = true
  let firstDrawMask = null
  for (let mask = 0; mask < total; mask++) {
    const edges = new Array(m)
    for (let i = 0; i < m; i++) edges[i] = (mask >> i) & 1
    if (monochromaticTriangles(n, edges).length === 0) {
      drawFree = false
      firstDrawMask = mask
      break
    }
  }
  check(
    `R(3,3) = 6: all ${total} two-colorings of the 6-dot board contain a monochromatic triangle` +
      (firstDrawMask === null ? '' : ` (counterexample found at mask ${firstDrawMask})`),
    drawFree,
  )

  // The same sweep at 5 dots must find plenty of triangle-free colorings —
  // otherwise the check above would be passing for the wrong reason (e.g. a
  // triangle detector that reports a triangle on every board).
  const m5 = edgeCount(5)
  let triangleFree5 = 0
  for (let mask = 0; mask < 1 << m5; mask++) {
    const edges = new Array(m5)
    for (let i = 0; i < m5; i++) edges[i] = (mask >> i) & 1
    if (monochromaticTriangles(5, edges).length === 0) triangleFree5++
  }
  // The pentagon/pentagram is essentially the only one: 12 of the 1024
  // colorings (5!/(5·2) = 12 distinct pentagon cycles), each counted once here
  // since swapping the two colors gives the complementary cycle, which is also
  // a pentagon. The exact number matters less than "some, and not many".
  check(`5 dots: triangle-free colorings exist (${triangleFree5} of ${1 << m5})`, triangleFree5 === 12)
}

// ---- suicideEdges ----------------------------------------------------------
{
  // Hand-built position: red holds 0-1 and 0-2, blue holds a scattering with no
  // two sharing a vertex-pair. Red is to move, so the ONLY instantly-losing
  // segment is 1-2 (closing red's 0-1-2).
  const s = createSim({ dots: 6 })
  const edges = s.edges.slice()
  edges[edgeIndex(6, 0, 1)] = 0
  edges[edgeIndex(6, 0, 2)] = 0
  edges[edgeIndex(6, 3, 4)] = 1
  edges[edgeIndex(6, 4, 5)] = 1
  const redToMove = { ...s, edges, turn: 0 }
  check(
    'suicideEdges: exactly one segment loses on the spot for red (1-2)',
    JSON.stringify(suicideEdges(redToMove)) === JSON.stringify([edgeIndex(6, 1, 2)]),
  )
  // Same board, blue to move: blue's own pair 3-4 / 4-5 makes 3-5 the losing
  // segment, and red's 0-1 / 0-2 is none of blue's business.
  const blueToMove = { ...redToMove, turn: 1 }
  check(
    'suicideEdges: reads the CURRENT player’s color, not the board’s (blue: 3-5)',
    JSON.stringify(suicideEdges(blueToMove)) === JSON.stringify([edgeIndex(6, 3, 5)]),
  )
  check('suicideEdges: none on a fresh board', suicideEdges(createSim({ dots: 6 })).length === 0)
  check('suicideEdges: empty once the game is done', suicideEdges({ ...redToMove, done: true }).length === 0)

  // Cross-check against the rules themselves: a segment is a "suicide" exactly
  // when actually playing it ends the game with the mover losing.
  let agrees = true
  const suicides = new Set(suicideEdges(redToMove))
  for (let i = 0; i < redToMove.edges.length; i++) {
    if (redToMove.edges[i] !== null) continue
    const r = applySimMove(redToMove, 0, { edge: i })
    const losesNow = r.ok && r.state.done && r.state.winner === 1
    if (losesNow !== suicides.has(i)) agrees = false
  }
  check('suicideEdges agrees with applySimMove on every uncolored segment', agrees)
}

// ---- every finished game is one of exactly two outcomes ---------------------
{
  // Random playouts at several board sizes: a game must always end either with
  // a recorded losing triangle (and a winner) or with a full board and no
  // winner. Never both, never neither.
  let ok = true
  let sawDraw = false
  let sawTriangle = false
  let seed = 12345
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let trial = 0; trial < 400; trial++) {
    const dots = 4 + (trial % 5) // 4..8
    let s = createSim({ dots })
    while (!s.done) {
      const open = s.edges.map((c, i) => (c === null ? i : -1)).filter((i) => i >= 0)
      const pick = open[Math.floor(rand() * open.length)]
      const r = applySimMove(s, s.turn, { edge: pick })
      if (!r.ok) {
        ok = false
        break
      }
      s = r.state
    }
    const full = s.edges.every((c) => c !== null)
    if (s.losingTriangle !== null) {
      sawTriangle = true
      if (s.winner === null) ok = false
      // The losing player is whoever just moved — i.e. not the winner.
      if (s.log[s.log.length - 1].player === s.winner) ok = false
      const tri = s.losingTriangle
      const color = s.edges[tri[0]]
      if (color !== s.log[s.log.length - 1].player) ok = false
      if (!tri.every((e) => s.edges[e] === color)) ok = false
    } else {
      sawDraw = true
      if (!full || s.winner !== null) ok = false
      if (monochromaticTriangles(dots, s.edges).length !== 0) ok = false
    }
    if (s.dots >= 6 && s.winner === null) ok = false // a draw is impossible at 6+
  }
  check('random playouts: every finished game is a clean loss or a clean draw', ok)
  check('random playouts: reached both outcomes (a draw at 4/5 dots, a triangle elsewhere)', sawDraw && sawTriangle)
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
