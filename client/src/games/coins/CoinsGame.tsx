// "Coins on a Round Table" — players alternate dropping coins on the table, no
// overlaps, none hanging off the edge; whoever places the last coin wins. The
// lesson is the symmetry argument: take the exact center, then mirror every
// opponent coin through it, so you always have a reply and place the last coin.
//
// Two modes (see shared/games/coins.ts):
//   • freeform — the real game. Drop a coin anywhere it fits; the game ends when
//     the player to move declares themselves stuck (or the tutor calls it as
//     referee), because "no legal spot remains" isn't machine-decidable. This is
//     where the mirror strategy actually forces the win.
//   • lattice — a decidable demo: placements snap to a grid, the board always
//     fills, and the winner is pure parity (blocking the center flips it).
//
// Its own lazy chunk (registry.ts's per-game lazy()), so shared/games/coins.ts
// and this module's CSS never reach the entry bundle — see test/build-split.mjs.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react'
import {
  isFreeformLegal,
  isPlayable,
  optimalCoinsMove,
  placedCoins,
  playablePoints,
  type CoinsState,
} from '../../../../shared/games/coins.ts'
import type { GameComponentProps } from '../registry'
import './coins.css'

/** `game-drag` payload: a lattice hover (candidate index) OR a freeform ghost
 *  (normalized coords), so spectators see where the current player is aiming. */
type DragPayload = { hover?: number | null; ghost?: { x: number; y: number } | null }

const REMOTE_DRAG_STALE_MS = 4000
const GHOST_THROTTLE_MS = 50
const CONFETTI_PIECES = Array.from({ length: 10 }, (_, i) => i)

// SVG geometry: normalized [0,1] coords map into an inset square so the table
// rim and a coin's shadow have room inside the viewBox.
const VIEW = 320
const PAD = 12
const AREA = VIEW - 2 * PAD
const nx = (x: number) => PAD + x * AREA
const ny = (y: number) => PAD + y * AREA

export default function CoinsGame({ channel, isHost, userId, state, players }: GameComponentProps) {
  const coins = state as CoinsState
  const coinsRef = useRef(coins)
  coinsRef.current = coins
  const freeform = coins.mode === 'freeform'

  const svgRef = useRef<SVGSVGElement>(null)

  const currentPlayer = players[coins.turn]
  const isMyTurn = coins.winner === null && currentPlayer?.userId === userId
  const currentName = currentPlayer?.name ?? 'Player'
  const winnerName = coins.winner !== null ? players[coins.winner]?.name ?? 'Player' : null

  // Local hover/ghost of the current player; the current player's broadcast
  // ghost as seen by everyone else (server excludes the sender).
  const [localHover, setLocalHover] = useState<number | null>(null) // lattice
  const [localGhost, setLocalGhost] = useState<{ x: number; y: number } | null>(null) // freeform
  const [remoteGhost, setRemoteGhost] = useState<{ x: number; y: number } | null>(null)
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ghostThrottle = useRef<{ timer: ReturnType<typeof setTimeout> | null; pending: { x: number; y: number } | null }>(
    { timer: null, pending: null },
  )

  // Tutor-only mirror overlay. OFF by default and never broadcast (spec:
  // "hidden"), so students never see the winning move.
  const [showMirror, setShowMirror] = useState(false)

  const hint = optimalCoinsMove(coins) // computed always; only RENDERED under isHost

  useEffect(() => {
    setLocalHover(null)
    setLocalGhost(null)
    setRemoteGhost(null)
    if (staleTimerRef.current) {
      clearTimeout(staleTimerRef.current)
      staleTimerRef.current = null
    }
  }, [coins])

  useEffect(() => {
    return channel.on('game-drag', (m) => {
      const p = m?.payload as DragPayload | undefined
      if (!p) return
      const c = coinsRef.current
      let coord: { x: number; y: number } | null = null
      if (p.ghost && typeof p.ghost.x === 'number') coord = { x: p.ghost.x, y: p.ghost.y }
      else if (typeof p.hover === 'number' && c.points[p.hover]) coord = c.points[p.hover]
      setRemoteGhost(coord)
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      staleTimerRef.current = setTimeout(() => setRemoteGhost(null), REMOTE_DRAG_STALE_MS)
    })
  }, [channel])

  useEffect(
    () => () => {
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      if (ghostThrottle.current.timer) clearTimeout(ghostThrottle.current.timer)
    },
    [],
  )

  // --- shared: map a pointer event to normalized table coords -----------------
  function clientToNorm(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const svg = svgRef.current
    if (!svg) return null
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const loc = pt.matrixTransform(ctm.inverse())
    return { x: (loc.x - PAD) / AREA, y: (loc.y - PAD) / AREA }
  }

  // --- lattice input ----------------------------------------------------------
  function hoverPoint(i: number | null) {
    if (!isMyTurn) return
    setLocalHover(i)
    channel.send({ type: 'game-drag', userId, payload: { hover: i } satisfies DragPayload })
  }
  function placePoint(i: number) {
    if (!isMyTurn || !isPlayable(coins, i)) return
    channel.send({ type: 'game-move', userId, move: { point: i } })
    setLocalHover(null)
  }

  // --- freeform input ---------------------------------------------------------
  function broadcastGhost(coord: { x: number; y: number } | null) {
    const bucket = ghostThrottle.current
    if (coord === null) {
      if (bucket.timer) {
        clearTimeout(bucket.timer)
        bucket.timer = null
      }
      bucket.pending = null
      channel.send({ type: 'game-drag', userId, payload: { ghost: null } satisfies DragPayload })
      return
    }
    bucket.pending = coord
    if (bucket.timer) return
    bucket.timer = setTimeout(() => {
      bucket.timer = null
      const p = bucket.pending
      bucket.pending = null
      if (p) channel.send({ type: 'game-drag', userId, payload: { ghost: p } satisfies DragPayload })
    }, GHOST_THROTTLE_MS)
  }
  function moveFree(e: ReactPointerEvent) {
    if (!isMyTurn) return
    const c = clientToNorm(e)
    if (!c) return
    setLocalGhost(c)
    broadcastGhost(c)
  }
  function leaveFree() {
    if (!isMyTurn) return
    setLocalGhost(null)
    broadcastGhost(null)
  }
  function placeFree(e: ReactMouseEvent) {
    if (!isMyTurn) return
    const c = clientToNorm(e)
    if (!c || !isFreeformLegal(coins, c.x, c.y)) return // illegal spot — ignore the click
    channel.send({ type: 'game-move', userId, move: { x: c.x, y: c.y } })
    setLocalGhost(null)
  }

  // Freeform ending: the player to move (or the tutor as referee) declares that
  // no legal spot remains. Sent as a `game-move` stamped with the current
  // player's id, which is all the server's identity check requires (userId is
  // trust-based here — see games-spec.md), so a spectating tutor can call it too.
  function declareStuck() {
    const uid = players[coins.turn]?.userId
    if (!uid) return
    channel.send({ type: 'game-move', userId: uid, move: { concede: true } })
  }

  const placed = placedCoins(coins)
  const lastCoin = placed.length > 0 ? placed[placed.length - 1] : null
  const r = coins.radius * AREA

  // The ghost coin to draw (local for the current player, broadcast for others)
  // and whether it's a legal spot (freeform only; lattice ghosts are always legal).
  const ghost = isMyTurn ? (freeform ? localGhost : localHover !== null ? coins.points[localHover] : null) : remoteGhost
  const ghostLegal = ghost ? (freeform ? isFreeformLegal(coins, ghost.x, ghost.y) : true) : false

  const remainingLattice = freeform ? 0 : playablePoints(coins).length

  return (
    <div className="coins-game">
      {coins.winner === null ? (
        <div className="coins-banner">
          {isMyTurn ? (
            <span>
              Your turn — place a coin.{' '}
              {freeform ? `${placed.length} down.` : `${remainingLattice} spot${remainingLattice === 1 ? '' : 's'} left.`}
            </span>
          ) : (
            <span>Watching — {currentName} is choosing a spot.</span>
          )}
        </div>
      ) : (
        <div className="coins-banner coins-banner-win">
          {winnerName} placed the last coin — {winnerName} wins!
          <div className="coins-confetti" aria-hidden="true">
            {CONFETTI_PIECES.map((i) => (
              <span key={i} className="coins-confetti-piece" />
            ))}
          </div>
        </div>
      )}

      <div className="coins-legend">
        <span className="coins-legend-item">
          <span className="coins-swatch p0" /> {players[0]?.name ?? 'Player 1'}
        </span>
        <span className="coins-legend-item">
          <span className="coins-swatch p1" /> {players[1]?.name ?? 'Player 2'}
        </span>
        {freeform && <span className="coins-legend-note">freeform — you call “no moves left”</span>}
        {!freeform && coins.centerBlocked && <span className="coins-legend-note">center blocked</span>}
      </div>

      {isHost && coins.winner === null && (
        <div className="coins-controls">
          <button
            className={`dock-btn coins-mirror-toggle${showMirror ? ' active' : ''}`}
            onClick={() => setShowMirror((s) => !s)}
          >
            {showMirror ? '🙈 Hide mirror hint' : '🪞 Show mirror hint'}
          </button>
          {showMirror && (
            <span className="coins-hint">
              {hint
                ? hint.kind === 'center'
                  ? 'Take the exact center'
                  : 'Copy the last coin through the center'
                : 'No mirror move here'}
            </span>
          )}
        </div>
      )}

      <div className="coins-stage">
        <svg ref={svgRef} viewBox={`0 0 ${VIEW} ${VIEW}`} className="coins-svg" role="img" aria-label="Table with coins">
          {coins.shape === 'circle' ? (
            <circle
              className={`coins-table${freeform && isMyTurn ? ' live' : ''}`}
              cx={nx(0.5)}
              cy={ny(0.5)}
              r={AREA / 2}
              onPointerMove={freeform ? moveFree : undefined}
              onPointerLeave={freeform ? leaveFree : undefined}
              onClick={freeform ? placeFree : undefined}
            />
          ) : (
            <rect
              className={`coins-table${freeform && isMyTurn ? ' live' : ''}`}
              x={nx(0)}
              y={ny(0.5) - 0.33 * AREA}
              width={AREA}
              height={0.66 * AREA}
              rx={10}
              onPointerMove={freeform ? moveFree : undefined}
              onPointerLeave={freeform ? leaveFree : undefined}
              onClick={freeform ? placeFree : undefined}
            />
          )}

          {/* Tutor mirror overlay: a dashed line from the last coin through the
              center to its 180° image. Host screen only. */}
          {isHost && showMirror && hint && hint.kind === 'mirror' && lastCoin && (
            <line
              className="coins-mirror-line"
              x1={nx(lastCoin.x)}
              y1={ny(lastCoin.y)}
              x2={nx(hint.x)}
              y2={ny(hint.y)}
            />
          )}

          {/* Lattice candidate points: faint dots you click to place. */}
          {!freeform &&
            coins.points.map((p, i) => {
              if (coins.occupied.includes(i)) return null
              const blocked = coins.centerBlocked && i === coins.centerIndex
              if (blocked) {
                return (
                  <g key={i} className="coins-blocked" aria-hidden="true">
                    <circle cx={nx(p.x)} cy={ny(p.y)} r={r * 0.5} />
                    <line x1={nx(p.x) - r * 0.4} y1={ny(p.y) - r * 0.4} x2={nx(p.x) + r * 0.4} y2={ny(p.y) + r * 0.4} />
                    <line x1={nx(p.x) - r * 0.4} y1={ny(p.y) + r * 0.4} x2={nx(p.x) + r * 0.4} y2={ny(p.y) - r * 0.4} />
                  </g>
                )
              }
              return (
                <circle
                  key={i}
                  className={`coins-spot${isMyTurn ? ' live' : ''}`}
                  cx={nx(p.x)}
                  cy={ny(p.y)}
                  r={r}
                  onMouseEnter={() => hoverPoint(i)}
                  onMouseLeave={() => hoverPoint(null)}
                  onClick={() => placePoint(i)}
                />
              )
            })}

          {/* Ghost preview of where a coin is about to land (red when the spot
              is illegal in freeform). */}
          {ghost && (
            <circle
              className={`coins-ghost${ghostLegal ? '' : ' illegal'}`}
              cx={nx(ghost.x)}
              cy={ny(ghost.y)}
              r={r}
              aria-hidden="true"
            />
          )}

          {/* Tutor hint ring on the winning move (host screen only). */}
          {isHost && showMirror && hint && (
            <circle className="coins-hint-ring" cx={nx(hint.x)} cy={ny(hint.y)} r={r} aria-hidden="true" />
          )}

          {/* Placed coins, coloured by who placed them (rendered last, on top). */}
          {placed.map((c, j) => (
            <circle
              key={`c${j}`}
              className={`coins-coin p${c.by}${j === placed.length - 1 ? ' fresh' : ''}`}
              cx={nx(c.x)}
              cy={ny(c.y)}
              r={r}
            />
          ))}
        </svg>
      </div>

      {/* Freeform ending controls: the stuck player concedes; or the tutor, as
          referee, calls "no moves left" on whoever is to move. */}
      {freeform && coins.winner === null && isMyTurn && (
        <button className="dock-btn coins-stuck" onClick={declareStuck}>
          🚫 I can’t place a coin — I’m stuck
        </button>
      )}
      {freeform && coins.winner === null && isHost && !isMyTurn && (
        <button className="dock-btn coins-stuck" onClick={declareStuck}>
          🚫 No moves left — {currentName} is stuck
        </button>
      )}

      {coins.winner !== null && isHost && (
        <button className="dock-btn primary coins-rematch" onClick={() => channel.send({ type: 'game-reset' })}>
          ↺ Clear the table
        </button>
      )}
    </div>
  )
}
