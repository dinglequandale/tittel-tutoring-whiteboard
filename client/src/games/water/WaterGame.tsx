// "Water Jugs" — a SIMULTANEOUS race, unlike every other game in the library.
// Each of the two players gets their OWN small + big jug and races to measure
// out the goal amount by Fill / Empty / Pour. There is no shared turn: the state
// carries `turn: -1` and the server lets either chosen player move their own
// side at any time (see server/index.ts canPlay).
//
// PRIVACY ("can't see the other's jugs") is done the same render-time way as the
// tutor-only hints elsewhere: the authoritative state (both players' jugs) is
// broadcast to everyone, but a PLAYER's screen renders only their own board —
// they just see that the opponent is "still pouring". The tutor, when they're
// refereeing rather than competing, sees BOTH boards side by side (and can peek
// at the shortest-path hint). Same trust model as the calc/write-lock features.
//
// Its own lazy chunk (registry.ts's per-game lazy()), so shared/games/water.ts
// and this module's CSS never reach the entry bundle — see test/build-split.mjs.
import { useState } from 'react'
import { optimalWaterMove, type WaterState, type WaterMove, type JugId } from '../../../../shared/games/water.ts'
import type { GameComponentProps } from '../registry'
import './water.css'

const CONFETTI_PIECES = Array.from({ length: 12 }, (_, i) => i)

function hintLabel(move: WaterMove | null): string {
  if (!move) return '—'
  const which = move.jug === 'small' ? 'small' : 'big'
  if (move.op === 'fill') return `Fill the ${which} jug`
  if (move.op === 'empty') return `Empty the ${which} jug`
  return move.jug === 'small' ? 'Pour small → big' : 'Pour big → small'
}

export default function WaterGame({ channel, isHost, userId, state, players }: GameComponentProps) {
  const water = state as WaterState
  const { smallCap, bigCap, target } = water

  const myIndex = players.findIndex((p) => p.userId === userId)
  const amIPlayer = myIndex === 0 || myIndex === 1
  // A tutor who ISN'T one of the two racers referees: they see both boards and
  // may peek at the shortest-path hint. A tutor who picked themselves as a
  // racer only sees their own board — no peeking at your own solution.
  const [showHint, setShowHint] = useState(false)
  const canReferee = isHost && !amIPlayer

  const winnerName = water.winner !== null ? players[water.winner]?.name ?? 'Player' : null

  function sendMove(op: WaterMove['op'], jug: JugId) {
    channel.send({ type: 'game-move', userId, move: { op, jug } })
  }

  function renderJug(idx: 0 | 1, jug: JugId) {
    const pair = water.jugs[idx]
    const cap = jug === 'small' ? smallCap : bigCap
    const amount = pair[jug]
    const pct = cap > 0 ? (amount / cap) * 100 : 0
    // Interior liter lines, so a student can read the level like a measuring cup.
    const ticks = Array.from({ length: Math.max(0, cap - 1) }, (_, i) => i + 1)
    return (
      <div className="water-jug-slot">
        <div className={`water-jug${amount === cap ? ' full' : ''}`} aria-label={`${jug} jug, ${amount} of ${cap} liters`}>
          <div className="water-jug-fill" style={{ height: `${pct}%` }} />
          <div className="water-jug-ticks" aria-hidden="true">
            {ticks.map((t) => (
              <span key={t} className="water-jug-tick" style={{ bottom: `${(t / cap) * 100}%` }} />
            ))}
          </div>
          <div className="water-jug-amount">{amount} L</div>
        </div>
        <div className="water-jug-cap">{cap} L jug</div>
      </div>
    )
  }

  function renderBoard(idx: 0 | 1, interactive: boolean) {
    const pair = water.jugs[idx]
    const name = players[idx]?.name ?? `Player ${idx + 1}`
    const hint = canReferee ? optimalWaterMove(water, idx) : null
    return (
      <div className="water-board" key={idx}>
        {!interactive && <div className="water-board-name">{name}</div>}
        <div className="water-jugs">
          {renderJug(idx, 'small')}
          <div className="water-pour-mid">
            <button
              type="button"
              className="dock-btn water-pour-btn"
              disabled={!interactive || pair.small === 0 || pair.big === bigCap}
              onClick={() => sendMove('pour', 'small')}
              title="Pour the small jug into the big one"
            >
              ▸
            </button>
            <button
              type="button"
              className="dock-btn water-pour-btn"
              disabled={!interactive || pair.big === 0 || pair.small === smallCap}
              onClick={() => sendMove('pour', 'big')}
              title="Pour the big jug into the small one"
            >
              ◂
            </button>
          </div>
          {renderJug(idx, 'big')}
        </div>

        {interactive && (
          <div className="water-controls">
            <div className="water-jug-controls">
              <button
                type="button"
                className="dock-btn"
                disabled={pair.small === smallCap}
                onClick={() => sendMove('fill', 'small')}
              >
                Fill
              </button>
              <button
                type="button"
                className="dock-btn"
                disabled={pair.small === 0}
                onClick={() => sendMove('empty', 'small')}
              >
                Empty
              </button>
            </div>
            <div className="water-jug-controls">
              <button
                type="button"
                className="dock-btn"
                disabled={pair.big === bigCap}
                onClick={() => sendMove('fill', 'big')}
              >
                Fill
              </button>
              <button
                type="button"
                className="dock-btn"
                disabled={pair.big === 0}
                onClick={() => sendMove('empty', 'big')}
              >
                Empty
              </button>
            </div>
          </div>
        )}

        {water.collectAll && (
          <div className="water-checklist" aria-label="amounts collected so far">
            {water.required.map((v) => (
              <span key={v} className={`water-check${pair.found.includes(v) ? ' got' : ''}`}>
                {v}
              </span>
            ))}
          </div>
        )}

        <div className="water-board-foot">
          <span className="water-ops">{pair.ops} moves</span>
          {water.collectAll && (
            <span className="water-ops">
              {pair.found.length}/{water.required.length} collected
            </span>
          )}
          {canReferee && (
            <span className="water-hint">{showHint ? `Next: ${hintLabel(hint)}` : ''}</span>
          )}
        </div>
      </div>
    )
  }

  const opponentName = amIPlayer ? players[myIndex === 0 ? 1 : 0]?.name ?? 'Your opponent' : ''

  return (
    <div className="water-game">
      {water.winner === null ? (
        <div className="water-goal">
          {water.collectAll ? (
            <>
              🚰 Race to make <strong>every amount from 1 to {target} L</strong> — first to collect them all.
            </>
          ) : (
            <>
              🚰 First to measure exactly <strong>{target} L</strong> — in one jug, or across both.
            </>
          )}
        </div>
      ) : (
        <div className="water-goal water-goal-win">
          🏆 {winnerName} wins —{' '}
          {water.collectAll
            ? `collected 1–${target} in ${water.jugs[water.winner!].ops} moves!`
            : `${target} L in ${water.jugs[water.winner!].ops} moves!`}
          <div className="water-confetti" aria-hidden="true">
            {CONFETTI_PIECES.map((i) => (
              <span key={i} className="water-confetti-piece" />
            ))}
          </div>
        </div>
      )}

      {canReferee && water.winner === null && (
        <button
          className={`dock-btn water-hint-toggle${showHint ? ' active' : ''}`}
          onClick={() => setShowHint((s) => !s)}
        >
          {showHint ? '🙈 Hide the shortest path' : '👁 Show the shortest path'}
        </button>
      )}

      {amIPlayer ? (
        <>
          {renderBoard(myIndex as 0 | 1, water.winner === null)}
          {water.winner === null && (
            <div className="water-opponent">
              <span className="water-opponent-dot" aria-hidden="true" />
              {opponentName} is still pouring…
            </div>
          )}
        </>
      ) : (
        <div className="water-both">
          {renderBoard(0, false)}
          {renderBoard(1, false)}
        </div>
      )}

      {water.winner !== null && isHost && (
        <button className="dock-btn primary water-rematch" onClick={() => channel.send({ type: 'game-reset' })}>
          ↺ Rematch
        </button>
      )}
    </div>
  )
}
