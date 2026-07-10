// Nim ("the 21 game") board, Phase 2: plain clickable tokens — no dragging,
// no live drag broadcast, no win-celebration polish (Phase 3 adds those).
// The end-to-end loop this proves: click 1-3 tokens, End turn sends the
// authoritative move, everyone's `game-state` advances, a winner shows.
//
// Its own lazy chunk (see registry.ts's per-game lazy()), so importing
// shared/games/nim.ts here — for the tutor-only hint's `optimalNimMove` — and
// this module's own CSS never reach the entry bundle. test/build-split.mjs
// enforces that split.
import { useEffect, useState } from 'react'
import { optimalNimMove, type NimState } from '../../../../shared/games/nim.ts'
import type { GameComponentProps } from '../registry'
import './nim.css'

export default function NimGame({ channel, isHost, userId, state, players }: GameComponentProps) {
  const nim = state as NimState

  // Tokens the local player has clicked but not yet committed with "End
  // turn". Purely local UI state — cleared whenever a fresh authoritative
  // state arrives (our own move's echo, the opponent's move, or a rematch),
  // so a stale selection never survives past the turn it was made for.
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  useEffect(() => setPicked(new Set()), [nim])

  // Tutor-only "rows of 4" toggle that re-lays the pile to telegraph the
  // winning strategy (leave a multiple of maxTake+1). Local visual only — no
  // wire message, so it never affects what a student sees on their screen.
  const [rowSize, setRowSize] = useState<4 | 5>(5)

  const currentPlayer = players[nim.turn]
  const isMyTurn = currentPlayer?.userId === userId
  const currentName = currentPlayer?.name ?? 'Player'
  const winnerName = nim.winner !== null ? players[nim.winner]?.name ?? 'Player' : null

  // Computed unconditionally (guests get the same game-state as the host, so
  // this must never be a data guard) — only the JSX render below is gated on
  // `isHost`. See games-spec.md's "must be a render-time guard" note.
  const hint = nim.winner === null ? optimalNimMove(nim) : null

  function toggleToken(id: string) {
    if (!isMyTurn) return
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        if (next.size >= nim.maxTake) return prev // at the cap — ignore the extra click
        next.add(id)
      }
      return next
    })
  }

  function endTurn() {
    if (picked.size < 1 || picked.size > nim.maxTake) return
    channel.send({ type: 'game-move', userId, move: { tokenIds: [...picked] } })
    setPicked(new Set()) // snappy — the state-reset effect above will also clear it
  }

  return (
    <div className="nim-game">
      {nim.winner === null ? (
        <div className="nim-banner">
          {isMyTurn ? (
            <span>Your turn — take 1–{nim.maxTake}.</span>
          ) : (
            <span>Watching — {currentName} is choosing.</span>
          )}
        </div>
      ) : (
        <div className="nim-banner nim-banner-win">{winnerName} wins!</div>
      )}

      {isHost && nim.winner === null && (
        <div className="nim-hint">{hint === null ? 'No winning move' : `Take ${hint} to win`}</div>
      )}

      {isHost && (
        <div className="nim-controls">
          <button className="dock-btn nim-layout-toggle" onClick={() => setRowSize((r) => (r === 5 ? 4 : 5))}>
            {rowSize === 5 ? 'Rows of 4' : 'Rows of 5'}
          </button>
        </div>
      )}

      <div className={`nim-pile rows-of-${rowSize}`}>
        {nim.tokens.map((id) => {
          const isPicked = picked.has(id)
          return (
            <button
              key={id}
              type="button"
              className={`nim-token${isPicked ? ' picked' : ''}${!isMyTurn ? ' disabled' : ''}`}
              disabled={!isMyTurn}
              onClick={() => toggleToken(id)}
              aria-pressed={isPicked}
              aria-label={`Token ${id}`}
            />
          )
        })}
      </div>

      <div className="nim-tray">
        <span className="nim-tray-label">Taking:</span>
        {picked.size === 0 ? (
          <span className="nim-tray-empty">Click 1–{nim.maxTake} tokens</span>
        ) : (
          [...picked].map((id) => <span key={id} className="nim-tray-token" />)
        )}
      </div>

      {isMyTurn && nim.winner === null && (
        <button
          className="dock-btn primary nim-end-turn"
          disabled={picked.size < 1 || picked.size > nim.maxTake}
          onClick={endTurn}
        >
          End turn
        </button>
      )}

      {nim.winner !== null && isHost && (
        <button className="dock-btn primary nim-rematch" onClick={() => channel.send({ type: 'game-reset' })}>
          ↺ Rematch
        </button>
      )}
    </div>
  )
}
