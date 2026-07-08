import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ControlChannel } from './controlChannel'

type Pos = { x: number; y: number }
type Phase = 'idle' | 'running' | 'paused' | 'finished'

export type TimerWireState = {
  remainingMs: number
  sentAt: number
  running: boolean
}

function defaultPos(): Pos {
  return { x: Math.max(8, Math.round(window.innerWidth / 2) - 90), y: 70 }
}

function clampPos(p: Pos): Pos {
  return {
    x: Math.min(Math.max(p.x, 0), window.innerWidth - 200),
    y: Math.min(Math.max(p.y, 0), window.innerHeight - 60),
  }
}

function fmt(ms: number): string {
  const totalSecs = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(totalSecs / 60)
  const s = totalSecs % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function wirePhase(s: TimerWireState): Phase {
  if (s.running) return 'running'
  if (s.remainingMs === 0) return 'finished'
  return 'paused'
}

function wireRemaining(s: TimerWireState): number {
  if (s.running) return Math.max(0, s.remainingMs - (Date.now() - s.sentAt))
  return s.remainingMs
}

export function Timer({
  channel,
  isHost,
  initialState,
  initialPos,
  onHide,
}: {
  channel: ControlChannel
  isHost: boolean
  initialState?: TimerWireState | null
  initialPos?: Pos | null
  onHide: () => void
}) {
  const [pos, setPos] = useState<Pos>(() => initialPos ?? defaultPos())
  const posRef = useRef(pos)
  posRef.current = pos

  const [phase, setPhase] = useState<Phase>(() =>
    initialState ? wirePhase(initialState) : 'idle'
  )
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  const [remainingMs, setRemainingMs] = useState<number>(() =>
    initialState ? wireRemaining(initialState) : 5 * 60 * 1000
  )
  const remainingRef = useRef(remainingMs)
  remainingRef.current = remainingMs

  // Host input fields — initialized from the initial remaining (or default)
  const [inputMins, setInputMins] = useState(() => {
    const r = initialState?.remainingMs ?? 5 * 60 * 1000
    return String(Math.floor(r / 60000))
  })
  const [inputSecs, setInputSecs] = useState(() => {
    const r = initialState?.remainingMs ?? 5 * 60 * 1000
    return String(Math.floor((r % 60000) / 1000))
  })

  function inputMs() {
    return ((parseInt(inputMins) || 0) * 60 + (parseInt(inputSecs) || 0)) * 1000
  }

  // Local countdown tick — runs only while phase === 'running'
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastAtRef = useRef(Date.now())

  useEffect(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
    if (phase !== 'running') return
    lastAtRef.current = Date.now()
    tickRef.current = setInterval(() => {
      const now = Date.now()
      const dt = now - lastAtRef.current
      lastAtRef.current = now
      setRemainingMs((prev) => {
        const next = Math.max(0, prev - dt)
        if (next === 0 && phaseRef.current === 'running') {
          // Synchronously guard so concurrent interval callbacks don't double-fire
          phaseRef.current = 'finished'
          setPhase('finished')
          if (isHost) {
            channel.send({ type: 'timer', action: 'state', remainingMs: 0, sentAt: Date.now(), running: false })
          }
        }
        return next
      })
    }, 100)
    return () => { if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null } }
  }, [phase, isHost, channel])

  // Host: broadcast initial state + re-assert on every (re)connect
  useEffect(() => {
    if (!isHost) return
    channel.send({ type: 'timer', action: 'state', remainingMs: remainingRef.current, sentAt: Date.now(), running: false })
    return channel.on('open', () => {
      channel.send({ type: 'timer', action: 'show' })
      channel.send({ type: 'timer', action: 'state', remainingMs: remainingRef.current, sentAt: Date.now(), running: phaseRef.current === 'running' })
      channel.send({ type: 'timer', action: 'geom', geom: posRef.current })
    })
    // channel/isHost are stable per mount — intentionally exclude remainingMs/phase from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, channel])

  // Host: broadcast position whenever it changes
  useEffect(() => {
    if (!isHost) return
    channel.send({ type: 'timer', action: 'geom', geom: pos })
  }, [pos, isHost, channel])

  // Student: receive timer state and position updates
  useEffect(() => {
    if (isHost) return
    return channel.on('timer', (m) => {
      if (m.action === 'state') {
        setRemainingMs(wireRemaining(m as TimerWireState))
        setPhase(wirePhase(m as TimerWireState))
      } else if (m.action === 'geom' && m.geom) {
        setPos(m.geom as Pos)
      }
    })
  }, [channel, isHost])

  // Drag (host only)
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isHost || e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const sx = e.clientX, sy = e.clientY
    const base = posRef.current
    const onMove = (ev: PointerEvent) =>
      setPos(clampPos({ x: base.x + (ev.clientX - sx), y: base.y + (ev.clientY - sy) }))
    const onUp = () => {
      el.releasePointerCapture?.(e.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }

  function sendState(remaining: number, running: boolean) {
    channel.send({ type: 'timer', action: 'state', remainingMs: remaining, sentAt: Date.now(), running })
  }

  function handleStart() {
    const ms = inputMs()
    if (ms <= 0) return
    setRemainingMs(ms)
    setPhase('running')
    sendState(ms, true)
  }

  function handlePause() {
    setPhase('paused')
    sendState(remainingRef.current, false)
  }

  function handleResume() {
    if (remainingRef.current <= 0) return
    setPhase('running')
    sendState(remainingRef.current, true)
  }

  function handleReset() {
    const ms = inputMs()
    setRemainingMs(ms)
    setPhase('idle')
    sendState(ms, false)
  }

  return (
    <div className="timer-panel" style={{ left: pos.x, top: pos.y }}>
      <div
        className={`timer-header${isHost ? ' draggable' : ''}`}
        onPointerDown={isHost ? startDrag : undefined}
      >
        <span className="timer-label">⏱ Timer</span>
        {isHost && (
          <button className="timer-close-btn" onClick={onHide} title="Hide timer">✕</button>
        )}
      </div>

      <div className={`timer-display${phase === 'finished' ? ' finished' : ''}`}>
        {fmt(remainingMs)}
      </div>

      {isHost && (
        <div className="timer-controls">
          <div className="timer-set-row">
            <input
              className="timer-input"
              type="number"
              min={0}
              max={99}
              value={inputMins}
              onChange={(e) => setInputMins(e.target.value)}
              disabled={phase === 'running'}
            />
            <span className="timer-unit">m</span>
            <input
              className="timer-input"
              type="number"
              min={0}
              max={59}
              value={inputSecs}
              onChange={(e) => setInputSecs(e.target.value)}
              disabled={phase === 'running'}
            />
            <span className="timer-unit">s</span>
          </div>
          <div className="timer-btn-row">
            {phase === 'idle' && (
              <button className="timer-btn primary" onClick={handleStart} disabled={inputMs() <= 0}>
                ▶ Start
              </button>
            )}
            {phase === 'running' && (
              <>
                <button className="timer-btn" onClick={handlePause}>⏸ Pause</button>
                <button className="timer-btn" onClick={handleReset}>↺ Reset</button>
              </>
            )}
            {phase === 'paused' && (
              <>
                <button className="timer-btn primary" onClick={handleResume}>▶ Resume</button>
                <button className="timer-btn" onClick={handleReset}>↺ Reset</button>
              </>
            )}
            {phase === 'finished' && (
              <button className="timer-btn" onClick={handleReset}>↺ Reset</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
