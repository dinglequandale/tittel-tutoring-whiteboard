// "Water Jugs" — the library's simultaneous game. The state carries `turn: -1`
// and the server lets either chosen player move at any time (see
// server/index.ts canPlay), which covers both of this game's modes:
//
//   - RACE (default): each of the two players gets their OWN small + big jug and
//     races to measure the goal. PRIVACY ("can't see the other's jugs") is done
//     the same render-time way as the tutor-only hints elsewhere: the
//     authoritative state (both boards) is broadcast to everyone, but a RACER's
//     screen renders only their own — they just see the opponent is "still
//     pouring". A tutor refereeing rather than competing sees both.
//
//   - COLLABORATIVE: one shared board. The tutor is the only one with controls
//     and pours what the class calls out; every student watches the same jugs
//     update live. The tutor's move is stamped with a seat's userId so the
//     server's identity check passes — the same referee move Coins uses for its
//     "no moves left" button (games-spec.md: authority by identity, trust-based,
//     zero server edits).
//
// With the RESERVOIR option on, each board grows a third vessel of unlimited
// capacity: pour water aside and you can build amounts past small + big — any
// positive integer at all when the capacities are coprime.
//
// Its own lazy chunk (registry.ts's per-game lazy()), so shared/games/water.ts
// and this module's CSS never reach the entry bundle — see test/build-split.mjs.
import { useState } from 'react'
import {
  optimalWaterMove,
  type WaterState,
  type WaterMove,
  type JugId,
  type VesselId,
} from '../../../../shared/games/water.ts'
import type { GameComponentProps } from '../registry'
import './water.css'

const CONFETTI_PIECES = Array.from({ length: 12 }, (_, i) => i)

function vesselName(v: VesselId): string {
  return v === 'stash' ? 'the reservoir' : v === 'small' ? 'the small jug' : 'the big jug'
}

function hintLabel(move: WaterMove | null): string {
  if (!move) return '—'
  if (move.op === 'fill') return `Fill ${vesselName(move.jug)}`
  if (move.op === 'empty') return `Empty ${vesselName(move.jug)}`
  const dest = move.to ?? (move.jug === 'small' ? 'big' : 'small')
  return `Pour ${vesselName(move.jug)} → ${vesselName(dest)}`
}

export default function WaterGame({ channel, isHost, userId, state, players }: GameComponentProps) {
  const water = state as WaterState
  const { smallCap, bigCap, target, collaborative, stash } = water

  const myIndex = players.findIndex((p) => p.userId === userId)
  // In collaborative mode nobody occupies a seat in any meaningful sense: the
  // tutor pours and everyone else spectates the one board.
  const amIRacer = !collaborative && (myIndex === 0 || myIndex === 1)
  const canDrive = collaborative ? isHost : amIRacer
  // The tutor may peek at the shortest path whenever they aren't competing:
  // refereeing a race, or driving the collaborative board. A tutor who picked
  // themselves as a racer gets no peek at their own solution.
  const canSeeHint = isHost && (collaborative || !amIRacer)
  const [showHint, setShowHint] = useState(false)

  const winnerName = water.winner !== null ? players[water.winner]?.name ?? 'Player' : null

  function sendMove(op: WaterMove['op'], jug: VesselId, to?: VesselId) {
    // Collaborative: the tutor pours on the class's behalf, so the move goes out
    // under a seat's identity (the server authorizes play by userId, not role).
    const as = collaborative ? players[0]?.userId ?? userId : userId
    channel.send({ type: 'game-move', userId: as, move: to === undefined ? { op, jug } : { op, jug, to } })
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

  /** The infinite reservoir: a vessel with no brim to fill, so its column is
   *  drawn against the goal rather than a capacity, and it simply tops out. */
  function renderStash(idx: 0 | 1, interactive: boolean) {
    const pair = water.jugs[idx]
    const scale = Math.max(target, bigCap)
    const pct = Math.min(100, (pair.stash / scale) * 100)
    return (
      <div className="water-stash-row">
        <div className="water-stash-slot">
          <div className="water-stash" aria-label={`reservoir, ${pair.stash} liters`}>
            <div className="water-stash-fill" style={{ height: `${pct}%` }} />
            <div className="water-stash-amount">{pair.stash} L</div>
          </div>
          <div className="water-jug-cap">∞ reservoir</div>
        </div>
        {interactive && (
          <div className="water-stash-controls">
            <div className="water-stash-line">
              <span className="water-stash-label">Stash</span>
              <button
                type="button"
                className="dock-btn"
                disabled={pair.small === 0}
                onClick={() => sendMove('pour', 'small', 'stash')}
                title="Tip the small jug into the reservoir"
              >
                small ▾
              </button>
              <button
                type="button"
                className="dock-btn"
                disabled={pair.big === 0}
                onClick={() => sendMove('pour', 'big', 'stash')}
                title="Tip the big jug into the reservoir"
              >
                big ▾
              </button>
            </div>
            <div className="water-stash-line">
              <span className="water-stash-label">Draw</span>
              <button
                type="button"
                className="dock-btn"
                disabled={pair.stash === 0 || pair.small === smallCap}
                onClick={() => sendMove('pour', 'stash', 'small')}
                title="Fill the small jug from the reservoir"
              >
                ▴ small
              </button>
              <button
                type="button"
                className="dock-btn"
                disabled={pair.stash === 0 || pair.big === bigCap}
                onClick={() => sendMove('pour', 'stash', 'big')}
                title="Fill the big jug from the reservoir"
              >
                ▴ big
              </button>
              <button
                type="button"
                className="dock-btn"
                disabled={pair.stash === 0}
                onClick={() => sendMove('empty', 'stash')}
              >
                Empty
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  function renderBoard(idx: 0 | 1, interactive: boolean, label: string | null) {
    const pair = water.jugs[idx]
    const hint = canSeeHint ? optimalWaterMove(water, idx) : null
    return (
      <div className="water-board" key={idx}>
        {label !== null && <div className="water-board-name">{label}</div>}
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

        {stash && renderStash(idx, interactive)}

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
          {canSeeHint && <span className="water-hint">{showHint ? `Next: ${hintLabel(hint)}` : ''}</span>}
        </div>
      </div>
    )
  }

  const opponentName = amIRacer ? players[myIndex === 0 ? 1 : 0]?.name ?? 'Your opponent' : ''
  const goalPhrase = water.collectAll ? (
    <>
      <strong>every amount from 1 to {target} L</strong>
    </>
  ) : (
    <>
      exactly <strong>{target} L</strong>
    </>
  )
  const winOps = water.winner !== null ? water.jugs[water.winner].ops : 0

  return (
    <div className="water-game">
      {water.winner === null ? (
        <div className="water-goal">
          {collaborative ? (
            <>🚰 Together, let&rsquo;s measure {goalPhrase} — in one vessel, or added together.</>
          ) : water.collectAll ? (
            <>🚰 Race to make {goalPhrase} — first to collect them all.</>
          ) : (
            <>🚰 First to measure {goalPhrase} — in one jug, or across both.</>
          )}
        </div>
      ) : (
        <div className="water-goal water-goal-win">
          {collaborative ? '🏆 Solved — ' : `🏆 ${winnerName} wins — `}
          {water.collectAll ? `collected 1–${target} in ${winOps} moves!` : `${target} L in ${winOps} moves!`}
          <div className="water-confetti" aria-hidden="true">
            {CONFETTI_PIECES.map((i) => (
              <span key={i} className="water-confetti-piece" />
            ))}
          </div>
        </div>
      )}

      {canSeeHint && water.winner === null && (
        <button
          className={`dock-btn water-hint-toggle${showHint ? ' active' : ''}`}
          onClick={() => setShowHint((s) => !s)}
        >
          {showHint ? '🙈 Hide the shortest path' : '👁 Show the shortest path'}
        </button>
      )}

      {collaborative ? (
        <>
          {water.winner === null && (
            <div className="water-collab-note">
              {isHost ? 'You do the pouring — the class calls the moves.' : 'Call out the next move — your tutor pours.'}
            </div>
          )}
          {renderBoard(0, canDrive && water.winner === null, null)}
        </>
      ) : amIRacer ? (
        <>
          {renderBoard(myIndex as 0 | 1, water.winner === null, null)}
          {water.winner === null && (
            <div className="water-opponent">
              <span className="water-opponent-dot" aria-hidden="true" />
              {opponentName} is still pouring…
            </div>
          )}
        </>
      ) : (
        <div className="water-both">
          {renderBoard(0, false, players[0]?.name ?? 'Player 1')}
          {renderBoard(1, false, players[1]?.name ?? 'Player 2')}
        </div>
      )}

      {water.winner !== null && isHost && (
        <button className="dock-btn primary water-rematch" onClick={() => channel.send({ type: 'game-reset' })}>
          ↺ {collaborative ? 'Play again' : 'Rematch'}
        </button>
      )}
    </div>
  )
}
