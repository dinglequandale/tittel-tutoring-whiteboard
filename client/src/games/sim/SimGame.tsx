// "Don't Make a Triangle" (Sim) — dots evenly spaced on a circle with every
// pair joined by a segment. Players alternate coloring one uncolored segment in
// their own color, and closing a triangle in YOUR OWN color loses.
//
// The lesson is R(3,3) = 6, so this board has two jobs beyond being playable:
//   • the DRAW must be unmistakable — at 6 dots no game can ever draw (that's
//     the theorem), at 5 dots the pentagon/pentagram coloring does, and that
//     contrast is the whole point of the class;
//   • the tutor must be able to change the dot count mid-class without walking
//     back out to the setup screen, hence the host-only board-size control
//     below (it re-sends `game-start` with the same two seats and new options —
//     the same message the setup screen sends, so the server needs nothing new).
//
// Two overlays, deliberately different in kind:
//   • "losing moves" (suicideEdges) is a tutor-only hint — local, never
//     broadcast, same as Balance's and Coins' strategy overlays.
//   • the proof overlay (tap a dot to count its segments by color) is room-wide
//     and rides `game-view`, because the students are the ones who need to see
//     it — it IS the pigeonhole step of the proof.
//
// Its own lazy chunk (registry.ts's per-game lazy()), so shared/games/sim.ts
// and this module's CSS never reach the entry bundle — see test/build-split.mjs.
import { useEffect, useMemo, useState } from 'react'
import { edgePairs, suicideEdges, MIN_DOTS, MAX_DOTS, type SimState } from '../../../../shared/games/sim.ts'
import type { GameComponentProps } from '../registry'
import './sim.css'

/** Host-set, room-wide display preference carried over `game-view` — which dot
 *  the tutor is walking the proof through. NOT authoritative game state: it can
 *  only ever change how the board is drawn, never what move is legal. */
type SimView = { highlightVertex: number | null }
const DEFAULT_VIEW: SimView = { highlightVertex: null }

// SVG geometry. The dots ring sits inside an inset square so the dot labels and
// a segment's glow have room inside the viewBox.
const VIEW = 340
const CENTER = VIEW / 2
const RADIUS = 128
const LABEL_RADIUS = RADIUS + 22
/** Fat invisible stroke carrying the click handler — a 6px line is close to
 *  unclickable on a trackpad, so every playable segment gets a wide transparent
 *  twin on top of it. Without this the game is simply unusable. */
const HIT_WIDTH = 16

const PLAYER_COLOR = ['red', 'blue'] as const
const CONFETTI_PIECES = Array.from({ length: 10 }, (_, i) => i)

/** Dot `i` of `n`, on the circle, with dot 0 at the top (12 o'clock). */
function dotPos(i: number, n: number, radius: number): { x: number; y: number } {
  const angle = (-90 + (i * 360) / n) * (Math.PI / 180)
  return { x: CENTER + radius * Math.cos(angle), y: CENTER + radius * Math.sin(angle) }
}

export default function SimGame({ channel, isHost, userId, state, players }: GameComponentProps) {
  const sim = state as SimState
  const pairs = useMemo(() => edgePairs(sim.dots), [sim.dots])
  const dots = useMemo(
    () => Array.from({ length: sim.dots }, (_, i) => dotPos(i, sim.dots, RADIUS)),
    [sim.dots],
  )

  const currentPlayer = players[sim.turn]
  const isMyTurn = !sim.done && currentPlayer?.userId === userId
  const currentName = currentPlayer?.name ?? 'Player'
  const winnerName = sim.winner !== null ? players[sim.winner]?.name ?? 'Player' : null
  const loserName = sim.winner !== null ? players[sim.winner === 0 ? 1 : 0]?.name ?? 'Player' : null
  const isDraw = sim.done && sim.winner === null
  const remaining = sim.edges.filter((c) => c === null).length

  // Room-wide, host-set: everyone must see the dot the tutor is pointing at,
  // unlike the losing-moves hint below. `game-view` is sticky (see
  // controlChannel.ts), so a late joiner gets the current highlight replayed.
  const [view, setView] = useState<SimView>(DEFAULT_VIEW)
  useEffect(
    () =>
      channel.on('game-view', (m) => {
        const v = m?.view
        if (!v || typeof v !== 'object') return
        const hv = (v as SimView).highlightVertex
        setView({ highlightVertex: typeof hv === 'number' ? hv : null })
      }),
    [channel],
  )
  // Defensive: a highlight set on a bigger board must not survive a smaller one
  // (the tutor drops 6 dots to 5 mid-class constantly).
  const highlight = view.highlightVertex !== null && view.highlightVertex < sim.dots ? view.highlightVertex : null

  // Tutor-only, never broadcast: which uncolored segments would lose on the
  // spot. Off by default, so a student never learns it from their own screen.
  const [showLosing, setShowLosing] = useState(false)
  // Computed unconditionally (guests receive the same game-state anyway), but
  // only ever RENDERED under an isHost guard — never a data guard. See
  // games-spec.md's note on keeping tutor hints render-time only.
  const suicides = useMemo(() => suicideEdges(sim), [sim])
  const suicideSet = useMemo(() => new Set(suicides), [suicides])

  // Board size, adjustable mid-class without going back through the library.
  const [nextDots, setNextDots] = useState(sim.dots)
  useEffect(() => setNextDots(sim.dots), [sim.dots])

  function pushView(next: SimView) {
    setView(next) // snappy locally; the server relays it to everyone else
    channel.send({ type: 'game-view', view: next })
  }

  function play(edge: number) {
    if (!isMyTurn || sim.edges[edge] !== null) return
    channel.send({ type: 'game-move', userId, move: { edge } })
  }

  /** Restart with a (possibly new) dot count. Re-sends the very same
   *  `game-start` the setup screen sends, with the seats we already have, so
   *  changing 6 dots to 5 is one click rather than End game → Games → set up
   *  again. Clears the proof highlight first: the server drops its copy when
   *  the game restarts, so leaving ours set would desync host and students. */
  function newBoard(dotCount: number) {
    if (!isHost) return
    if (view.highlightVertex !== null) pushView(DEFAULT_VIEW)
    channel.send({
      type: 'game-start',
      gameId: 'sim',
      players,
      options: { dots: dotCount },
    })
  }

  // Pigeonhole readout for the highlighted dot: n-1 segments, two colors, so at
  // least ceil((n-1)/2) of them must share a color. That sentence IS the proof.
  const highlightCounts = useMemo(() => {
    if (highlight === null) return null
    let red = 0
    let blue = 0
    let open = 0
    for (let i = 0; i < pairs.length; i++) {
      const [a, b] = pairs[i]
      if (a !== highlight && b !== highlight) continue
      const c = sim.edges[i]
      if (c === 0) red++
      else if (c === 1) blue++
      else open++
    }
    return { red, blue, open, total: sim.dots - 1, forced: Math.ceil((sim.dots - 1) / 2) }
  }, [highlight, pairs, sim.edges, sim.dots])

  const losingSet = useMemo(() => new Set(sim.losingTriangle ?? []), [sim.losingTriangle])

  return (
    <div className="sim-game">
      {!sim.done ? (
        <div className="sim-banner">
          {isMyTurn ? (
            <span>
              Your turn — color one segment <strong className={`sim-ink ${PLAYER_COLOR[sim.turn]}`}>
                {PLAYER_COLOR[sim.turn]}
              </strong>
              . Don&rsquo;t close a triangle!
            </span>
          ) : (
            <span>
              Watching — {currentName} is picking a{' '}
              <strong className={`sim-ink ${PLAYER_COLOR[sim.turn]}`}>{PLAYER_COLOR[sim.turn]}</strong> segment.
            </span>
          )}
        </div>
      ) : isDraw ? (
        // The draw is the result the lesson is fishing for at 5 dots, so it gets
        // the loudest treatment on the board — it must never read as the game
        // quietly running out of segments.
        <div className="sim-banner sim-banner-draw">
          <span className="sim-draw-headline">🤝 Draw — Nobody made a triangle</span>
          <span className="sim-draw-sub">
            {sim.dots < 6
              ? `All ${sim.edges.length} segments colored on ${sim.dots} dots, and not one triangle. This is the counterexample: with fewer than 6 dots a draw is possible.`
              : `All ${sim.edges.length} segments colored with no triangle — which shouldn't be possible at ${sim.dots} dots.`}
          </span>
        </div>
      ) : (
        <div className="sim-banner sim-banner-loss">
          <span>
            {loserName} closed a <strong className={`sim-ink ${PLAYER_COLOR[sim.winner === 0 ? 1 : 0]}`}>
              {PLAYER_COLOR[sim.winner === 0 ? 1 : 0]}
            </strong>{' '}
            triangle — {winnerName} wins!
          </span>
          <div className="sim-confetti" aria-hidden="true">
            {CONFETTI_PIECES.map((i) => (
              <span key={i} className="sim-confetti-piece" />
            ))}
          </div>
        </div>
      )}

      <div className="sim-legend">
        {players.map((p, i) => (
          <span
            key={p.userId}
            className={`sim-legend-chip ${PLAYER_COLOR[i]}${!sim.done && sim.turn === i ? ' active' : ''}`}
          >
            <span className="sim-legend-swatch" />
            {p.name}
          </span>
        ))}
        <span className="sim-remaining">
          {remaining} of {sim.edges.length} segments left
        </span>
      </div>

      <svg
        className="sim-board"
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        role="img"
        aria-label={`${sim.dots} dots joined by ${sim.edges.length} segments`}
      >
        {/* Visible segments, drawn under the hit targets and the dots. */}
        {pairs.map(([a, b], i) => {
          const color = sim.edges[i]
          const incident = highlight !== null && (a === highlight || b === highlight)
          const dim = highlight !== null && !incident
          const classes = [
            'sim-edge',
            color === null ? 'open' : PLAYER_COLOR[color],
            losingSet.has(i) ? 'losing' : '',
            isHost && showLosing && suicideSet.has(i) ? 'suicide' : '',
            incident ? 'incident' : '',
            dim ? 'dim' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <line
              key={i}
              className={classes}
              x1={dots[a].x}
              y1={dots[a].y}
              x2={dots[b].x}
              y2={dots[b].y}
            />
          )
        })}

        {/* Wide transparent twins: the actual click targets, and only for
            segments this viewer can legally play, so overlapping fat strokes
            near the middle of the board can't swallow a click meant for a
            segment that's already colored. */}
        {isMyTurn &&
          pairs.map(([a, b], i) =>
            sim.edges[i] === null ? (
              <line
                key={`hit-${i}`}
                className="sim-edge-hit"
                x1={dots[a].x}
                y1={dots[a].y}
                x2={dots[b].x}
                y2={dots[b].y}
                strokeWidth={HIT_WIDTH}
                onClick={() => play(i)}
              >
                <title>{`Segment from dot ${a + 1} to dot ${b + 1}`}</title>
              </line>
            ) : null,
          )}

        {dots.map((p, i) => {
          const label = dotPos(i, sim.dots, LABEL_RADIUS)
          return (
            <g key={i} className={`sim-dot-group${highlight === i ? ' highlighted' : ''}`}>
              <circle
                className={`sim-dot${isHost ? ' pickable' : ''}`}
                cx={p.x}
                cy={p.y}
                r={9}
                onClick={isHost ? () => pushView({ highlightVertex: highlight === i ? null : i }) : undefined}
              >
                {isHost && <title>{`Dot ${i + 1} — tap to count its segments`}</title>}
              </circle>
              <text className="sim-dot-label" x={label.x} y={label.y} textAnchor="middle" dominantBaseline="middle">
                {i + 1}
              </text>
            </g>
          )
        })}
      </svg>

      {highlightCounts && (
        // Room-wide (it rides game-view), because this readout is the proof
        // step the students have to follow, not a tutor's private hint.
        <div className="sim-proof-readout">
          <strong>Dot {highlight! + 1}</strong> has {highlightCounts.total} segments:{' '}
          <span className="sim-ink red">{highlightCounts.red} red</span> ·{' '}
          <span className="sim-ink blue">{highlightCounts.blue} blue</span>
          {highlightCounts.open > 0 && <> · {highlightCounts.open} uncolored</>}
          <div className="sim-proof-sub">
            {highlightCounts.total} segments, 2 colors → at least {highlightCounts.forced} of them must share a color.
          </div>
        </div>
      )}

      {isHost && (
        <div className="sim-controls">
          <div className="sim-control-row">
            <button
              className={`dock-btn sim-toggle${showLosing ? ' active' : ''}`}
              onClick={() => setShowLosing((s) => !s)}
            >
              {showLosing ? '🙈 Hide losing moves' : '👁 Show losing moves'}
            </button>
            {showLosing && (
              <span className="sim-hint">
                {sim.done
                  ? 'Game over'
                  : suicides.length === 0
                    ? 'No segment loses on the spot yet'
                    : `${suicides.length} segment${suicides.length === 1 ? '' : 's'} would close ${
                        currentName
                      }'s own triangle`}
              </span>
            )}
            <button
              className={`dock-btn sim-toggle${highlight !== null ? ' active' : ''}`}
              onClick={() => pushView({ highlightVertex: highlight === null ? 0 : null })}
            >
              {highlight !== null ? '✕ Clear the proof view' : '🔎 Walk the proof'}
            </button>
          </div>
          <div className="sim-control-row">
            <span className="sim-control-label">Dots</span>
            <div className="sim-stepper">
              <button
                type="button"
                className="dock-btn"
                disabled={nextDots <= MIN_DOTS}
                onClick={() => setNextDots((d) => Math.max(MIN_DOTS, d - 1))}
              >
                −
              </button>
              <span className="sim-stepper-value">{nextDots}</span>
              <button
                type="button"
                className="dock-btn"
                disabled={nextDots >= MAX_DOTS}
                onClick={() => setNextDots((d) => Math.min(MAX_DOTS, d + 1))}
              >
                +
              </button>
            </div>
            <button className="dock-btn primary" onClick={() => newBoard(nextDots)}>
              ↺ New board — {nextDots} dots
            </button>
          </div>
          {highlight !== null && <p className="sim-control-note">Tap any dot to count its segments.</p>}
          {sim.dots >= 6 && <p className="sim-control-note">At 6 dots a draw is impossible. Try 5.</p>}
        </div>
      )}
    </div>
  )
}
