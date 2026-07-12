// The Pizza Cutting Problem — like Lockers, less a competitive game than an
// illustrated demo: a round pizza, cut by N straight lines, each crossing
// every earlier one. It runs through the same two-seat, turn-based wire
// protocol every game in the registry uses (see shared/games/pizza.ts's
// header comment for why): the two picked participants alternate making
// consecutive cuts, which doubles as the "1st cut, 2nd cut, 3rd cut…"
// iteration the demo is about.
//
// Its own lazy chunk (registry.ts's per-game lazy()), so shared/games/pizza.ts
// and this module's CSS never reach the entry bundle — see test/build-split.mjs.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { chordEndpoints, piecesForCuts, type PizzaState } from '../../../../shared/games/pizza.ts'
import type { GameComponentProps } from '../registry'
import './pizza.css'

const RADIUS = 140
const CENTER = 150
const VIEWBOX = 300

// Deterministic, purely decorative pepperoni — not tied to game state, just
// enough visual texture that the circle reads as a pizza rather than a pie
// chart. Golden-angle spread again, offset from the cut sequence's own
// values so the toppings don't line up with where cuts tend to land.
const PEPPERONI = Array.from({ length: 9 }, (_, i) => {
  const angle = (i * 137.508 + 40) % 360
  const r = RADIUS * (0.28 + 0.14 * ((i * 0.618) % 1) + 0.35 * (i % 3 === 0 ? 0.6 : 1))
  const rad = (angle * Math.PI) / 180
  return { cx: CENTER + r * Math.cos(rad), cy: CENTER + r * Math.sin(rad) }
})

export default function PizzaGame({ channel, isHost, userId, state, players }: GameComponentProps) {
  const pizza = state as PizzaState

  const currentPlayer = players[pizza.turn]
  const isMyTurn = !pizza.done && currentPlayer?.userId === userId
  const currentName = currentPlayer?.name ?? 'Player'
  const remaining = pizza.maxCuts - pizza.nextCut + 1

  // Which cuts just appeared, so each new line can sweep into place (via
  // stroke-dasharray) instead of silently popping onto the board — same
  // "wave" idea as Lockers' door-flip stagger, keyed by cut index so a
  // fast-forwarded batch still reveals in order.
  const prevCountRef = useRef(pizza.cuts.length)
  const [freshFrom, setFreshFrom] = useState<number | null>(null)
  useEffect(() => {
    const prev = prevCountRef.current
    prevCountRef.current = pizza.cuts.length
    if (pizza.cuts.length <= prev) {
      setFreshFrom(null) // a fresh board (rematch) — nothing to sweep in
      return
    }
    setFreshFrom(prev)
    const t = setTimeout(() => setFreshFrom(null), 500 + (pizza.cuts.length - prev) * 120)
    return () => clearTimeout(t)
  }, [pizza.cuts.length])

  function runCuts(count: number) {
    channel.send({ type: 'game-move', userId, move: { count } })
  }

  return (
    <div className="pizza-game">
      {!pizza.done ? (
        <div className="pizza-banner">
          {isMyTurn ? (
            <span>Your turn — make cut #{pizza.nextCut}.</span>
          ) : (
            <span>
              Watching — {currentName} is making cut #{pizza.nextCut}.
            </span>
          )}
        </div>
      ) : (
        <div className="pizza-banner pizza-banner-done">
          All {pizza.maxCuts} cuts made — {pizza.pieces} pieces.
          <div className="pizza-reveal">
            1 + n(n+1)/2, with n = {pizza.maxCuts}, is {piecesForCuts(pizza.maxCuts)}.
          </div>
        </div>
      )}

      {isMyTurn && (
        <div className="pizza-controls">
          <button className="dock-btn primary" onClick={() => runCuts(1)}>
            ✂️ Cut #{pizza.nextCut}
          </button>
          {remaining > 3 && (
            <button className="dock-btn" onClick={() => runCuts(Math.min(3, remaining))}>
              Skip 3
            </button>
          )}
          {remaining > 1 && (
            <button className="dock-btn" onClick={() => runCuts(remaining)}>
              Finish remaining ⏭
            </button>
          )}
        </div>
      )}

      <div className="pizza-stage">
        <svg viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`} className="pizza-svg" role="img" aria-label="Pizza with cuts">
          <circle className="pizza-crust" cx={CENTER} cy={CENTER} r={RADIUS} />
          <circle className="pizza-cheese" cx={CENTER} cy={CENTER} r={RADIUS - 8} />
          {PEPPERONI.map((p, i) => (
            <circle key={i} className="pizza-pepperoni" cx={p.cx} cy={p.cy} r={7} />
          ))}
          {pizza.cuts.map((cut, i) => {
            const chord = chordEndpoints(cut, RADIUS)
            if (!chord) return null
            const isFresh = freshFrom !== null && i >= freshFrom
            const style: CSSProperties | undefined = isFresh
              ? ({ '--cut-delay': `${(i - (freshFrom ?? 0)) * 120}ms` } as CSSProperties)
              : undefined
            return (
              <line
                key={i}
                className={`pizza-cut${isFresh ? ' fresh' : ''}`}
                x1={CENTER + chord.x1}
                y1={CENTER + chord.y1}
                x2={CENTER + chord.x2}
                y2={CENTER + chord.y2}
                style={style}
              />
            )
          })}
        </svg>
        <div className="pizza-count">
          🍕 <strong>{pizza.pieces}</strong> piece{pizza.pieces === 1 ? '' : 's'}
        </div>
      </div>

      {pizza.done && isHost && (
        <button className="dock-btn primary pizza-rematch" onClick={() => channel.send({ type: 'game-reset' })}>
          ↺ Cut again
        </button>
      )}
    </div>
  )
}
