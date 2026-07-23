// "Balance" — two-pile Nim. Two columns of stones; on your turn you take any
// number from ONE column, and whoever clears the last stone wins. The whole
// lesson is the invariant |a - b|: the winning move equalizes the piles, and
// the equal positions are exactly the losing ones. The tutor-only overlay
// (host screen only, off by default) points at that winning move so you can
// either demo it or deliberately withhold it and let a boy sit in a lost spot.
//
// Its own lazy chunk (registry.ts's per-game lazy()), so shared/games/balance.ts
// and this module's CSS never reach the entry bundle — see test/build-split.mjs.
import { useEffect, useRef, useState } from 'react'
import { optimalBalanceMove, type BalanceState } from '../../../../shared/games/balance.ts'
import type { GameComponentProps } from '../registry'
import './balance.css'

/** Wire shape for `game-drag`'s payload — a spectator only needs to know which
 *  pile the current player is drawing from and how many stones they've marked,
 *  so this stays tiny (no pixel coordinates, nothing to normalize). */
type DragPayload = { pile: 0 | 1 | null; k: number }

// Defensive: game-drag is advisory and non-sticky, so a dropped final frame
// could otherwise strand a phantom selection on spectators' screens. A fresh
// game-state clears it immediately; this just bounds the damage if that's
// somehow also missed. Same idea as NimGame's REMOTE_DRAG_STALE_MS.
const REMOTE_DRAG_STALE_MS = 4000

const CONFETTI_PIECES = Array.from({ length: 10 }, (_, i) => i)
const PILE_LABEL = ['left', 'right'] as const

export default function BalanceGame({ channel, isHost, userId, state, players }: GameComponentProps) {
  const bal = state as BalanceState

  // Local, uncommitted selection: which pile the player is drawing from and how
  // many stones (`k`) they've marked off the top. Cleared on every fresh
  // authoritative state (our own move's echo, the opponent's move, a rematch).
  const [selPile, setSelPile] = useState<0 | 1 | null>(null)
  const [k, setK] = useState(0)
  const selRef = useRef<{ pile: 0 | 1 | null; k: number }>({ pile: null, k: 0 })
  selRef.current = { pile: selPile, k }

  // The current player's live selection as broadcast by THEM — only ever
  // populated on a spectator's / the other player's screen (the server's
  // broadcastToOthers excludes the sender).
  const [remoteDrag, setRemoteDrag] = useState<DragPayload | null>(null)
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Whether a pointer is currently held down for a column-drag (so pointerenter
  // on a sibling stone extends the selection). No pointer capture on purpose —
  // capture would trap moves to the pressed stone and kill the sibling
  // pointerenter events the column-drag relies on.
  const draggingRef = useRef(false)
  const movedRef = useRef(false)

  // Tutor-only strategy overlay. OFF by default (spec: "hidden from students"),
  // and this state never leaves the host's screen — it's not broadcast, so a
  // student never learns the winning move even though they receive the same
  // game-state. Distinct from Lockers' room-wide `game-view`, on purpose.
  const [showHint, setShowHint] = useState(false)

  const currentPlayer = players[bal.turn]
  const isMyTurn = bal.winner === null && currentPlayer?.userId === userId
  const currentName = currentPlayer?.name ?? 'Player'
  const winnerName = bal.winner !== null ? players[bal.winner]?.name ?? 'Player' : null
  const diff = Math.abs(bal.piles[0] - bal.piles[1])

  // Computed unconditionally (guests get the same state), but only ever RENDERED
  // under an isHost guard below — never a data guard. See games-spec.md.
  const hint = optimalBalanceMove(bal)

  useEffect(() => {
    setSelPile(null)
    setK(0)
    selRef.current = { pile: null, k: 0 }
    draggingRef.current = false
    setRemoteDrag(null)
    if (staleTimerRef.current) {
      clearTimeout(staleTimerRef.current)
      staleTimerRef.current = null
    }
  }, [bal])

  useEffect(() => {
    return channel.on('game-drag', (m) => {
      const payload = m?.payload
      if (!payload || (payload.pile !== 0 && payload.pile !== 1 && payload.pile !== null)) return
      setRemoteDrag({ pile: payload.pile, k: typeof payload.k === 'number' ? payload.k : 0 })
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      staleTimerRef.current = setTimeout(() => setRemoteDrag(null), REMOTE_DRAG_STALE_MS)
    })
  }, [channel])

  useEffect(() => {
    // A held pointer that lifts anywhere ends the column-drag — listen on the
    // window so releasing off a stone still stops the drag.
    const onUp = () => {
      draggingRef.current = false
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
    }
  }, [])

  function broadcast(pile: 0 | 1 | null, count: number) {
    channel.send({ type: 'game-drag', userId, payload: { pile, k: count } satisfies DragPayload })
  }

  /** Set the selection to exactly `depth` stones off the top of pile `p`
   *  (used while dragging — an absolute set to wherever the pointer is). */
  function setDepth(p: 0 | 1, depth: number) {
    if (!isMyTurn) return
    const clamped = Math.min(bal.piles[p], Math.max(0, depth))
    setSelPile(clamped === 0 ? null : p)
    setK(clamped)
    selRef.current = { pile: clamped === 0 ? null : p, k: clamped }
    broadcast(clamped === 0 ? null : p, clamped)
  }

  /** Click handler: sets the selection to `depth`, except that clicking the
   *  current boundary stone again steps it back by one (so you can un-take the
   *  last stone, and clicking the very top stone twice clears the pile). */
  function clickDepth(p: 0 | 1, depth: number) {
    if (!isMyTurn) return
    if (movedRef.current) {
      movedRef.current = false // this click is the tail of a drag — the drag already set it
      return
    }
    const cur = selRef.current
    const next = cur.pile === p && cur.k === depth ? depth - 1 : depth
    setDepth(p, next)
  }

  function endTurn() {
    if (selPile === null || k < 1 || k > bal.piles[selPile]) return
    channel.send({ type: 'game-move', userId, move: { pile: selPile, count: k } })
    setSelPile(null)
    setK(0)
  }

  // What to render as "marked to take": our own selection on our turn,
  // otherwise the current player's live broadcast.
  const shown = isMyTurn ? { pile: selPile, k } : { pile: remoteDrag?.pile ?? null, k: remoteDrag?.k ?? 0 }

  function renderPile(p: 0 | 1) {
    const count = bal.piles[p]
    const markedTop = shown.pile === p ? shown.k : 0
    // Tutor overlay: highlight the stones the winning move would remove.
    const hintCount = isHost && showHint && hint && hint.pile === p ? hint.count : 0
    // Render top-of-pile first so "taking from the top" reads top-down.
    const stones = Array.from({ length: count }, (_, i) => i) // i = depth from top (0 = top)
    return (
      <div className="balance-pile">
        <div className="balance-pile-count">{count}</div>
        <div
          className="balance-column"
          onPointerLeave={() => {
            /* leaving the column mid-drag keeps the last set value — nothing to do */
          }}
        >
          {stones.map((i) => {
            const depth = i + 1
            const marked = depth <= markedTop
            const hinted = depth <= hintCount
            return (
              <button
                key={i}
                type="button"
                className={`balance-stone${marked ? ' marked' : ''}${hinted ? ' hinted' : ''}${
                  isMyTurn ? '' : ' disabled'
                }`}
                disabled={!isMyTurn}
                onPointerDown={() => {
                  if (!isMyTurn) return
                  draggingRef.current = true
                  movedRef.current = false
                  setDepth(p, depth)
                }}
                onPointerEnter={() => {
                  if (!isMyTurn || !draggingRef.current) return
                  movedRef.current = true
                  setDepth(p, depth)
                }}
                onClick={() => clickDepth(p, depth)}
                aria-label={`${PILE_LABEL[p]} pile, stone ${depth} from top`}
                aria-pressed={marked}
              />
            )
          })}
          {count === 0 && <div className="balance-empty">empty</div>}
        </div>
        {isMyTurn && (
          <div className="balance-stepper" aria-label={`${PILE_LABEL[p]} pile take count`}>
            <button
              type="button"
              className="dock-btn"
              disabled={shown.pile !== p || shown.k <= 0}
              onClick={() => setDepth(p, (shown.pile === p ? shown.k : 0) - 1)}
            >
              −
            </button>
            <span className="balance-stepper-value">{shown.pile === p ? shown.k : 0}</span>
            <button
              type="button"
              className="dock-btn"
              disabled={count === 0 || (shown.pile === p && shown.k >= count)}
              onClick={() => setDepth(p, (shown.pile === p ? shown.k : 0) + 1)}
            >
              +
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="balance-game">
      {bal.winner === null ? (
        <div className="balance-banner">
          {isMyTurn ? (
            <span>Your turn — take any number from one pile.</span>
          ) : (
            <span>Watching — {currentName} is choosing.</span>
          )}
        </div>
      ) : (
        <div className="balance-banner balance-banner-win">
          {winnerName} wins!
          <div className="balance-confetti" aria-hidden="true">
            {CONFETTI_PIECES.map((i) => (
              <span key={i} className="balance-confetti-piece" />
            ))}
          </div>
        </div>
      )}

      <div className={`balance-diff${diff === 0 ? ' balanced' : ''}`}>
        {diff === 0 ? '⚖️ Balanced' : `Difference: ${diff}`}
      </div>

      {isHost && bal.winner === null && (
        <div className="balance-controls">
          <button
            className={`dock-btn balance-hint-toggle${showHint ? ' active' : ''}`}
            onClick={() => setShowHint((s) => !s)}
          >
            {showHint ? '🙈 Hide winning move' : '👁 Show winning move'}
          </button>
          {showHint && (
            <span className="balance-hint">
              {hint ? `Take ${hint.count} from the ${PILE_LABEL[hint.pile]} pile` : 'No winning move — balanced'}
            </span>
          )}
        </div>
      )}

      <div className="balance-piles">
        {renderPile(0)}
        {renderPile(1)}
      </div>

      {isMyTurn && (
        <button
          className="dock-btn primary balance-end-turn"
          disabled={selPile === null || k < 1}
          onClick={endTurn}
        >
          Take {k > 0 ? k : ''} {k === 1 ? 'stone' : 'stones'} — end turn
        </button>
      )}

      {bal.winner !== null && isHost && (
        <button className="dock-btn primary balance-rematch" onClick={() => channel.send({ type: 'game-reset' })}>
          ↺ Rematch
        </button>
      )}
    </div>
  )
}
