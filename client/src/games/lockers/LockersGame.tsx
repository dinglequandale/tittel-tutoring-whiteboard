// The Locker Problem — less a competitive game than an illustrated demo: 100
// closed lockers, student 1 opens every one, student 2 toggles every 2nd,
// student N toggles every Nth. It still runs through the same two-seat,
// turn-based wire protocol every game in the registry uses (see
// shared/games/lockers.ts's header comment for why): the two picked
// participants alternate running consecutive students' passes, which doubles
// as the "1st person, 2nd person, 3rd person…" iteration the demo is about —
// nobody has to click through all 100 alone.
//
// Its own lazy chunk (registry.ts's per-game lazy()), so shared/games/lockers.ts
// and this module's CSS never reach the entry bundle — see test/build-split.mjs.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { isPerfectSquare, type LockersState } from '../../../../shared/games/lockers.ts'
import type { GameComponentProps } from '../registry'
import './lockers.css'

// How long the staggered "wave" of door-flips takes to fully settle, before
// the transient `flipping` class (and its per-locker delay) is cleared.
const FLIP_BASE_MS = 550
const FLIP_STEP_MS = 14

/** Host-set, room-wide display preferences carried over `game-view` — NOT
 *  authoritative game state, just how the board is drawn, so every viewer
 *  (not only the host) sees the same layout. */
type LockersView = { fit: boolean; showCounts: boolean }
const DEFAULT_VIEW: LockersView = { fit: false, showCounts: false }

export default function LockersGame({ channel, isHost, userId, state, players }: GameComponentProps) {
  const lockers = state as LockersState

  const currentPlayer = players[lockers.turn]
  const isMyTurn = !lockers.done && currentPlayer?.userId === userId
  const currentName = currentPlayer?.name ?? 'Player'
  const remaining = lockers.lockerCount - lockers.nextStudent + 1

  // Fit/visit-count are host-set but room-wide: everyone should see the same
  // layout the tutor is pointing at, unlike Nim's tutor-only "rows of 4"
  // toggle (which stays local on purpose, so the tutor can preview a layout
  // without changing what students see). `game-view` is sticky (see
  // controlChannel.ts), so a late-joining or reconnecting viewer gets the
  // room's current view replayed immediately, same as `game-state`.
  const [view, setView] = useState<LockersView>(DEFAULT_VIEW)
  const { fit, showCounts } = view
  useEffect(
    () =>
      channel.on('game-view', (m) => {
        const v = m?.view
        if (v && typeof v === 'object') setView({ fit: !!v.fit, showCounts: !!v.showCounts })
      }),
    [channel],
  )

  // Only ever called from host-gated buttons below — sets the local view
  // immediately (snappy for the tutor) and broadcasts it to everyone else.
  function pushView(next: LockersView) {
    setView(next)
    channel.send({ type: 'game-view', view: next })
  }

  // Which lockers just flipped, and in what order (ascending locker number —
  // the same order a real pass toggles them in), so the grid can stagger a
  // little door-swing wave across exactly the lockers that changed rather
  // than silently snapping to the new state.
  const prevOpenRef = useRef<boolean[]>(lockers.open)
  const [justToggled, setJustToggled] = useState<Map<number, number>>(new Map())
  useEffect(() => {
    const prev = prevOpenRef.current
    prevOpenRef.current = lockers.open
    if (prev.length !== lockers.open.length) return // a fresh board (rematch) — nothing to diff
    const changed: number[] = []
    lockers.open.forEach((v, i) => {
      if (v !== prev[i]) changed.push(i)
    })
    if (changed.length === 0) return
    const order = new Map<number, number>()
    changed.forEach((idx, i) => order.set(idx, i))
    setJustToggled(order)
    const t = setTimeout(() => setJustToggled(new Map()), FLIP_BASE_MS + changed.length * FLIP_STEP_MS)
    return () => clearTimeout(t)
  }, [lockers.open])

  // A roughly-square grid regardless of lockerCount, so a 100-locker board
  // reads as the classic 10x10 without hardcoding it.
  const columns = useMemo(() => {
    const c = Math.round(Math.sqrt(lockers.lockerCount))
    return Math.min(16, Math.max(6, c))
  }, [lockers.lockerCount])

  function runPass(count: number) {
    channel.send({ type: 'game-move', userId, move: { count } })
  }

  const openLockers = lockers.done
    ? lockers.open.map((o, i) => (o ? i + 1 : null)).filter((n): n is number => n !== null)
    : []

  return (
    <div className="lockers-game">
      {!lockers.done ? (
        <div className="lockers-banner">
          {isMyTurn ? (
            <span>Your turn — run student #{lockers.nextStudent}&rsquo;s pass.</span>
          ) : (
            <span>
              Watching — {currentName} is running student #{lockers.nextStudent}&rsquo;s pass.
            </span>
          )}
        </div>
      ) : (
        <div className="lockers-banner lockers-banner-done">
          All {lockers.lockerCount} students have gone.
          <div className="lockers-reveal">Open: {openLockers.join(', ')} — the perfect squares!</div>
        </div>
      )}

      {isMyTurn && (
        <div className="lockers-controls">
          <button className="dock-btn primary" onClick={() => runPass(1)}>
            ▶ Student #{lockers.nextStudent}
          </button>
          {remaining > 10 && (
            <button className="dock-btn" onClick={() => runPass(Math.min(10, remaining))}>
              Skip 10
            </button>
          )}
          {remaining > 1 && (
            <button className="dock-btn" onClick={() => runPass(remaining)}>
              Finish remaining ⏭
            </button>
          )}
        </div>
      )}

      {isHost && (
        <div className="lockers-tutor-controls">
          <button
            className={`dock-btn lockers-toggle-chip${fit ? ' active' : ''}`}
            onClick={() => pushView({ ...view, fit: !fit })}
          >
            {fit ? '⤢ Normal size' : '⤡ Fit to screen'}
          </button>
          <button
            className={`dock-btn lockers-toggle-chip${showCounts ? ' active' : ''}`}
            onClick={() => pushView({ ...view, showCounts: !showCounts })}
          >
            {showCounts ? '🔢 Hide visit counts' : '🔢 Show visit counts'}
          </button>
        </div>
      )}

      <div
        className={`lockers-grid${fit ? ' fit' : ''}${showCounts ? ' show-counts' : ''}`}
        // Fit mode fills the stage's actual width via CSS auto-fill instead
        // of this fixed sqrt-based column count — see lockers.css's ".fit".
        style={fit ? undefined : { gridTemplateColumns: `repeat(${columns}, 1fr)` }}
      >
        {lockers.open.map((open, i) => {
          const n = i + 1
          const order = justToggled.get(i)
          const flipping = order !== undefined
          const style: CSSProperties | undefined = flipping
            ? ({ '--locker-delay': `${order * FLIP_STEP_MS}ms` } as CSSProperties)
            : undefined
          return (
            <div
              key={n}
              className={`locker${open ? ' open' : ''}${flipping ? ' flipping' : ''}${
                lockers.done && isPerfectSquare(n) ? ' square' : ''
              }`}
              style={style}
              title={`Locker ${n} — visited ${lockers.touched[i]}×`}
            >
              <span className="locker-number">{n}</span>
              {showCounts && <span className="locker-count">×{lockers.touched[i]}</span>}
            </div>
          )
        })}
      </div>

      {lockers.done && isHost && (
        <button className="dock-btn primary lockers-rematch" onClick={() => channel.send({ type: 'game-reset' })}>
          ↺ Run again
        </button>
      )}
    </div>
  )
}
