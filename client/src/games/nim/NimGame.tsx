// Nim ("the 21 game") board, Phase 3: adds live drag ON TOP of Phase 2's plain
// click-to-toggle — click must keep working exactly as before (it's the
// reliable path on a trackpad, per games-spec.md), drag is additive delight.
// Both paths funnel through the same `picked` set and the same `sendDrag`
// broadcast, so a spectator sees identical live state regardless of which
// input method the current player used.
//
// Its own lazy chunk (see registry.ts's per-game lazy()), so importing
// shared/games/nim.ts here — for the tutor-only hint's `optimalNimMove` — and
// this module's own CSS never reach the entry bundle. test/build-split.mjs
// enforces that split.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { optimalNimMove, type NimState } from '../../../../shared/games/nim.ts'
import type { GameComponentProps } from '../registry'
import './nim.css'

/** Wire shape for `game-drag`'s payload — locked by games-spec.md, do not change. */
type DragPayload = { picked: string[]; ghost: { id: string; x: number; y: number } | null }

// Px moved (or crossing into the tray) before a drag counts as "for real" and
// (a) toggles `picked` and (b) suppresses the click event that follows the
// eventual pointerup — see startDrag's comment for why a click still fires.
const DRAG_THRESHOLD_PX = 28
// games-spec.md: throttle ghost-only updates to ~20/s, comfortably under
// shared/games/index.ts's GAME_MSG_RATE = 60. Discrete `picked` changes skip
// this and send immediately regardless of source (click or drag).
const GHOST_THROTTLE_MS = 50
// Defensive only: game-drag is advisory and non-sticky, so a dropped final
// "ghost: null" frame (rate limit, reconnect blip) could otherwise strand a
// ghost on spectators' screens forever. A fresh game-state already clears it
// immediately; this just bounds the damage if that message is somehow also
// missed. Not spec-mandated — noted per games-spec.md's "use your judgment".
const REMOTE_DRAG_STALE_MS = 4000

const CONFETTI_PIECES = Array.from({ length: 10 }, (_, i) => i)

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function pointInRect(x: number, y: number, el: HTMLElement | null): boolean {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

export default function NimGame({ channel, isHost, userId, state, players }: GameComponentProps) {
  const nim = state as NimState

  // The element live-drag coordinates are normalized against (0..1), per
  // games-spec.md's "Live dragging" section — never raw pixels, since
  // students' windows are different sizes. Also the position:relative anchor
  // the remote ghost is placed inside (see nim.css).
  const stageRef = useRef<HTMLDivElement>(null)
  const trayRef = useRef<HTMLDivElement>(null)

  // Tokens the local player has picked but not yet committed with "End
  // turn". Purely local UI state — cleared whenever a fresh authoritative
  // state arrives (our own move's echo, the opponent's move, or a rematch),
  // so a stale selection never survives past the turn it was made for.
  // Mirrored into a ref so pointer-event callbacks (which don't re-render)
  // always read the latest value, same discipline as Timer.tsx's posRef etc.
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const pickedRef = useRef(picked)
  pickedRef.current = picked

  // The current player's live picks + in-flight ghost, as broadcast by THEM —
  // never our own (the server's broadcastToOthers excludes the sender), so
  // this is only ever populated on a spectator's or the other player's
  // screen. Cleared on a fresh game-state and (defensively) after a staleness
  // timeout — see REMOTE_DRAG_STALE_MS above.
  const [remoteDrag, setRemoteDrag] = useState<DragPayload | null>(null)
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Our own in-flight drag, for the local floating ghost that follows the
  // cursor while dragging. Viewport (client) coordinates — no normalization
  // needed since this never leaves the local screen.
  const [localGhost, setLocalGhost] = useState<{ id: string; clientX: number; clientY: number } | null>(null)

  // Active drag session (this pointer only — see startDrag's comment on the
  // single-pointer assumption) plus whether it moved far enough to count as
  // a real drag rather than a click with a little jitter.
  const dragRef = useRef<{ id: string; pointerId: number; startX: number; startY: number; startPicked: boolean } | null>(
    null,
  )
  const movedRef = useRef(false)

  // Trailing-edge throttle bucket for ghost-only sends. Discrete picked-set
  // changes bypass this entirely (sendDrag's `immediate` flag).
  const ghostThrottle = useRef<{ timer: ReturnType<typeof setTimeout> | null; pending: DragPayload | null }>({
    timer: null,
    pending: null,
  })

  useEffect(() => {
    // A fresh authoritative state means our own picks and any in-flight drag
    // are stale — belt-and-suspenders alongside End Turn already clearing
    // `picked` on send, in case a pointerup was ever missed.
    setPicked(new Set())
    pickedRef.current = new Set()
    dragRef.current = null
    setLocalGhost(null)
    // The opponent's live drag is equally stale the moment a real move lands.
    setRemoteDrag(null)
    if (staleTimerRef.current) {
      clearTimeout(staleTimerRef.current)
      staleTimerRef.current = null
    }
  }, [nim])

  useEffect(() => {
    return channel.on('game-drag', (m) => {
      const payload = m?.payload
      if (!payload || !Array.isArray(payload.picked)) return // malformed/foreign frame — advisory only, drop it
      setRemoteDrag(payload as DragPayload)
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      staleTimerRef.current = setTimeout(() => setRemoteDrag(null), REMOTE_DRAG_STALE_MS)
    })
  }, [channel])

  // Cleanup on unmount (game-end, or the stage swapping games) so a timer
  // never fires setState after this component is gone.
  useEffect(
    () => () => {
      if (ghostThrottle.current.timer) clearTimeout(ghostThrottle.current.timer)
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
    },
    [],
  )

  // Tutor-only "rows of 4" toggle that re-lays the pile to telegraph the
  // winning strategy (leave a multiple of maxTake+1). Local visual only — no
  // wire message, so it never affects what a student sees on their screen.
  const [rowSize, setRowSize] = useState<4 | 5>(5)

  // A real move landing (nim.log growing) briefly bounces the pile so a token
  // leaving/the pile reflowing reads as a deliberate "settle", not a silent
  // snap. Gated by prefers-reduced-motion entirely in CSS.
  const prevLogLenRef = useRef(nim.log.length)
  const [settling, setSettling] = useState(false)
  useEffect(() => {
    if (nim.log.length > prevLogLenRef.current) {
      setSettling(true)
      const t = setTimeout(() => setSettling(false), 380)
      prevLogLenRef.current = nim.log.length
      return () => clearTimeout(t)
    }
    prevLogLenRef.current = nim.log.length
  }, [nim.log.length])

  const currentPlayer = players[nim.turn]
  const isMyTurn = currentPlayer?.userId === userId
  const currentName = currentPlayer?.name ?? 'Player'
  const winnerName = nim.winner !== null ? players[nim.winner]?.name ?? 'Player' : null

  // Computed unconditionally (guests get the same game-state as the host, so
  // this must never be a data guard) — only the JSX render below is gated on
  // `isHost`. See games-spec.md's "must be a render-time guard" note.
  const hint = nim.winner === null ? optimalNimMove(nim) : null

  // What to actually render as "picked": our own set when it's our turn,
  // otherwise the current player's live broadcast — spectators (and the
  // other player) never mutate `picked` themselves (toggleToken/startDrag
  // both gate on isMyTurn), so this is never ambiguous.
  const displayPicked = isMyTurn ? [...picked] : remoteDrag?.picked ?? []
  const displayPickedSet = new Set(displayPicked)

  function normalize(clientX: number, clientY: number): { x: number; y: number } {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0.5, y: 0.5 }
    return { x: clamp01((clientX - rect.left) / rect.width), y: clamp01((clientY - rect.top) / rect.height) }
  }

  /** Sends a `game-drag` frame. Discrete picked-set changes go out immediately
   *  and cancel any stale throttled send in flight; pure ghost-position
   *  movement is throttled to GHOST_THROTTLE_MS via a trailing-edge bucket
   *  (a ref + setTimeout, not a send on every pointermove tick). */
  function sendDrag(payload: DragPayload, immediate: boolean) {
    const bucket = ghostThrottle.current
    if (immediate) {
      if (bucket.timer) {
        clearTimeout(bucket.timer)
        bucket.timer = null
        bucket.pending = null
      }
      channel.send({ type: 'game-drag', userId, payload })
      return
    }
    bucket.pending = payload
    if (bucket.timer) return // a send is already scheduled within the next GHOST_THROTTLE_MS
    bucket.timer = setTimeout(() => {
      bucket.timer = null
      const p = bucket.pending
      bucket.pending = null
      if (p) channel.send({ type: 'game-drag', userId, payload: p })
    }, GHOST_THROTTLE_MS)
  }

  function toggleToken(id: string) {
    if (!isMyTurn) return
    // The tail end of a drag gesture also delivers a click (pointer capture
    // routes it to this element regardless of where the pointer physically
    // ended up) — the drag already applied the toggle, so consume and ignore
    // this one click rather than flipping the token straight back.
    if (movedRef.current) {
      movedRef.current = false
      return
    }
    const current = pickedRef.current
    const has = current.has(id)
    if (!has && current.size >= nim.maxTake) return // at the cap — ignore the extra click
    const next = new Set(current)
    if (has) next.delete(id)
    else next.add(id)
    pickedRef.current = next
    setPicked(next)
    sendDrag({ picked: [...next], ghost: null }, true)
  }

  /** Native-pointer-event drag, mirroring Timer.tsx's setPointerCapture
   *  discipline: capture on the element itself, listen on it (not
   *  window/document), tear down on pointerup/cancel. Works for both a pile
   *  token (id currently unpicked or picked) and a tray chip (id currently
   *  picked) — `startPicked` is read fresh at pointerdown, so the same
   *  handler serves "pick up from the pile" and "pull back out of the tray".
   *  Assumes one drag at a time (fine for a mouse/trackpad-driven tutoring
   *  session; a second simultaneous touch would clobber dragRef, same
   *  simplification Timer.tsx makes for its own drag). */
  function startDrag(e: ReactPointerEvent<HTMLElement>, id: string) {
    if (!isMyTurn) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)

    const drag = { id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, startPicked: pickedRef.current.has(id) }
    dragRef.current = drag
    movedRef.current = false
    setLocalGhost({ id, clientX: e.clientX, clientY: e.clientY })

    const onMove = (ev: PointerEvent) => {
      if (dragRef.current !== drag) return // a stale listener from a torn-down drag — ignore
      setLocalGhost({ id, clientX: ev.clientX, clientY: ev.clientY })

      const overTray = pointInRect(ev.clientX, ev.clientY, trayRef.current)
      const dist = Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY)
      if (overTray || dist > DRAG_THRESHOLD_PX) movedRef.current = true

      // A token that started unpicked gets picked once it's dragged far
      // enough OR reaches the tray; one that started picked (dragged from
      // the tray) stays picked until it's pulled far away without being
      // over the tray — see games-spec.md: "dropping onto the tray (or
      // anywhere past a drag threshold)" / "dragging back out ... removes it".
      const desiredPicked = drag.startPicked ? overTray || dist <= DRAG_THRESHOLD_PX : overTray || dist > DRAG_THRESHOLD_PX

      const current = pickedRef.current
      let next = current
      if (current.has(id) !== desiredPicked) {
        if (desiredPicked && current.size >= nim.maxTake) {
          // At the cap — behave like the click handler and ignore the extra pick.
        } else {
          next = new Set(current)
          if (desiredPicked) next.add(id)
          else next.delete(id)
          pickedRef.current = next
          setPicked(next)
        }
      }

      const { x, y } = normalize(ev.clientX, ev.clientY)
      sendDrag({ picked: [...next], ghost: { id, x, y } }, next !== current)
    }

    const onUp = () => {
      cleanup()
      dragRef.current = null
      setLocalGhost(null)
      // Tell everyone the drag ended right away — don't make spectators wait
      // out the ghost throttle or the staleness timeout to see it disappear.
      sendDrag({ picked: [...pickedRef.current], ghost: null }, true)
    }

    function cleanup() {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.releasePointerCapture?.(e.pointerId)
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  function endTurn() {
    if (picked.size < 1 || picked.size > nim.maxTake) return
    channel.send({ type: 'game-move', userId, move: { tokenIds: [...picked] } })
    setPicked(new Set()) // snappy — the state-reset effect above will also clear it
  }

  return (
    <div className="nim-game" ref={stageRef}>
      {nim.winner === null ? (
        <div className="nim-banner">
          {isMyTurn ? (
            <span>Your turn — take 1–{nim.maxTake}.</span>
          ) : (
            <span>Watching — {currentName} is choosing.</span>
          )}
        </div>
      ) : (
        <div className="nim-banner nim-banner-win">
          {winnerName} wins!
          <div className="nim-confetti" aria-hidden="true">
            {CONFETTI_PIECES.map((i) => (
              <span key={i} className="nim-confetti-piece" />
            ))}
          </div>
        </div>
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

      <div className={`nim-pile rows-of-${rowSize}${settling ? ' pile-settle' : ''}`}>
        {nim.tokens.map((id) => {
          const isPicked = displayPickedSet.has(id)
          const isDragging = (isMyTurn && localGhost?.id === id) || (!isMyTurn && remoteDrag?.ghost?.id === id)
          return (
            <button
              key={id}
              type="button"
              className={`nim-token${isPicked ? ' picked' : ''}${!isMyTurn ? ' disabled' : ''}${isDragging ? ' dragging' : ''}`}
              disabled={!isMyTurn}
              onClick={() => toggleToken(id)}
              onPointerDown={(e) => startDrag(e, id)}
              aria-pressed={isPicked}
              aria-label={`Token ${id}`}
            />
          )
        })}
      </div>

      <div className="nim-tray" ref={trayRef}>
        <span className="nim-tray-label">Taking:</span>
        {displayPicked.length === 0 ? (
          <span className="nim-tray-empty">
            {isMyTurn ? `Click 1–${nim.maxTake} tokens` : 'Nothing taken yet'}
          </span>
        ) : (
          displayPicked.map((id) => (
            <span
              key={id}
              className="nim-tray-token"
              onClick={isMyTurn ? () => toggleToken(id) : undefined}
              onPointerDown={isMyTurn ? (e) => startDrag(e, id) : undefined}
            />
          ))
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

      {/* Local drag preview: viewport-fixed, follows the raw pointer — never
          normalized, since it never leaves this screen. */}
      {isMyTurn && localGhost && (
        <div
          className="nim-ghost nim-ghost-local"
          style={{ left: localGhost.clientX, top: localGhost.clientY }}
          aria-hidden="true"
        />
      )}
      {/* Remote drag preview: percentage-positioned inside this stage's own
          box (position:relative on .nim-game), so the sender's normalized
          0..1 coordinate scales correctly into OUR bounding box without any
          getBoundingClientRect math on this side. */}
      {!isMyTurn && remoteDrag?.ghost && (
        <div
          className="nim-ghost nim-ghost-remote"
          style={{ left: `${remoteDrag.ghost.x * 100}%`, top: `${remoteDrag.ghost.y * 100}%` }}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
