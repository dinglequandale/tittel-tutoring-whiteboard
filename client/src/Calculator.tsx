import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { loadDesmos } from './desmos'
import type { ControlChannel } from './controlChannel'

// The floating panel's position/size, in CSS pixels (top-left anchored).
type Geom = { x: number; y: number; w: number; h: number }

// Default parking spot: bottom-right above the dock, matching the original CSS.
function defaultGeom(): Geom {
  const w = Math.min(440, window.innerWidth * 0.92)
  const h = Math.min(520, window.innerHeight - 120)
  return {
    x: Math.max(12, window.innerWidth - w - 12),
    y: Math.max(12, window.innerHeight - h - 60),
    w,
    h,
  }
}

// Keep at least a sliver on-screen so a panel can always be grabbed back.
function clampPos(g: Geom): Geom {
  const margin = 40
  return {
    ...g,
    x: Math.min(Math.max(g.x, margin - g.w), window.innerWidth - margin),
    y: Math.min(Math.max(g.y, 0), window.innerHeight - margin),
  }
}

// We only broadcast state changes that happen within this window after a real
// local interaction (pointer/keyboard) on our own calculator. Desmos mutates
// state on its own after setState (recomputed values, slider bounds, running
// animations) and keeps firing 'change'; those have no local interaction behind
// them, so a receiver never echoes them back — which is what breaks the
// two-editor feedback loop, regardless of whether getState/setState is stable.
const INTERACTION_WINDOW_MS = 1500

// A floating Desmos panel.
//  - Tutor (host): always an editor. Changes broadcast to everyone; a footer
//    switch toggles whether students may edit too.
//  - Student (guest): a live mirror, read-only by default (transparent shield).
//    When the tutor enables editing, the shield lifts and the student can drive
//    the shared calculator; their changes flow back to everyone.
//
// Echo suppression is content-based: we never broadcast a state equal to the one
// we last sent or applied. This is timing-independent, so two editors can't
// ping-pong updates at each other (the bug that caused the calculator to glitch).
export function Calculator({
  channel,
  isHost,
  initialState,
  initialGeom,
  canEdit = false,
  studentsCanEdit = false,
  onToggleAccess,
  personal = false,
}: {
  channel: ControlChannel
  isHost: boolean
  initialState?: unknown
  /** The shared panel's last-known position/size, for a late-joining student. */
  initialGeom?: unknown
  canEdit?: boolean
  studentsCanEdit?: boolean
  onToggleAccess?: (allow: boolean) => void
  /** A private, non-synced scratch calculator (free reign): full edit, no relay. */
  personal?: boolean
}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const calcRef = useRef<any>(null)
  const amEditorRef = useRef(isHost || personal)
  const lastInteractionRef = useRef(0)
  const [error, setError] = useState<string | null>(null)

  const amEditor = isHost || canEdit || personal

  // Who may move/resize this panel: the tutor (drives everyone) or the owner of a
  // private free-reign calculator (local only). A following student mirrors only.
  const geomEditable = isHost || personal
  const [geom, setGeom] = useState<Geom>(() => (initialGeom as Geom) ?? defaultGeom())
  const geomRef = useRef(geom)
  geomRef.current = geom

  // Tutor broadcasts position/size so students' shared panel tracks it. A private
  // free-reign calculator stays local; a following student only receives.
  useEffect(() => {
    if (isHost && !personal) channel.send({ type: 'calc', action: 'geom', geom })
  }, [geom, isHost, personal, channel])

  // Following student: mirror the tutor's moves/resizes of the shared panel.
  useEffect(() => {
    if (isHost || personal) return
    return channel.on('calc', (m) => {
      if (m.action === 'geom' && m.geom) setGeom(m.geom as Geom)
    })
  }, [channel, isHost, personal])

  // Capture native resize-handle drags (CSS `resize: both`) back into geom so the
  // new size is broadcast. border-box sizing makes offsetWidth equal the width we
  // set, so this can't drift or loop.
  useEffect(() => {
    if (!geomEditable) return
    const el = panelRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const w = el.offsetWidth
      const h = el.offsetHeight
      const g = geomRef.current
      if (w !== g.w || h !== g.h) setGeom({ ...g, w, h })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [geomEditable])

  // Drag the panel by its header. Pointer capture keeps the drag smooth even when
  // the cursor passes over the calculator's own surface.
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!geomEditable || e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startY = e.clientY
    const base = geomRef.current
    const onMove = (ev: PointerEvent) =>
      setGeom(clampPos({ ...base, x: base.x + (ev.clientX - startX), y: base.y + (ev.clientY - startY) }))
    const onUp = () => {
      el.releasePointerCapture?.(e.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }

  // Reflect edit access without recreating the calculator.
  useEffect(() => {
    amEditorRef.current = amEditor
    calcRef.current?.updateSettings?.({ lockViewport: !amEditor })
  }, [amEditor])

  useEffect(() => {
    let disposed = false
    const cleanups: Array<() => void> = []
    // The last state we sent OR applied. We never re-broadcast this exact state.
    let syncedJSON = ''
    let lastSent = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    loadDesmos()
      .then((Desmos) => {
        if (disposed || !mountRef.current) return
        const calc = Desmos.GraphingCalculator(mountRef.current, {
          autosize: true,
          expressions: true,
          settingsMenu: isHost,
          lockViewport: !amEditorRef.current,
        })
        calcRef.current = calc

        // Track genuine local interaction with this calculator. Only such
        // changes are allowed to broadcast (see INTERACTION_WINDOW_MS).
        const markInteraction = () => {
          lastInteractionRef.current = performance.now()
        }
        const el = mountRef.current!
        const interactionEvents = ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'wheel', 'input']
        interactionEvents.forEach((e) => el.addEventListener(e, markInteraction, true))
        cleanups.push(() => interactionEvents.forEach((e) => el.removeEventListener(e, markInteraction, true)))

        const applyRemote = (state: unknown) => {
          const json = JSON.stringify(state)
          if (json === syncedJSON) return // already showing this — no disruptive setState
          calc.setState(state, { allowUndo: false })
          // Record what's actually on screen now so the resulting 'change' event
          // doesn't bounce it straight back out.
          syncedJSON = JSON.stringify(calc.getState())
        }

        const broadcast = () => {
          timer = null
          if (!amEditorRef.current) return
          // Only emit changes driven by our own recent interaction — never the
          // churn from applying a remote update. This is the loop breaker.
          if (performance.now() - lastInteractionRef.current > INTERACTION_WINDOW_MS) return
          const json = JSON.stringify(calc.getState())
          if (json === syncedJSON) return // nothing genuinely new
          syncedJSON = json
          lastSent = performance.now()
          channel.send({ type: 'calc', action: 'state', state: JSON.parse(json) })
        }
        // Throttle change-driven broadcasts (trailing), so fast typing stays calm.
        const onChange = () => {
          if (!amEditorRef.current) return
          const elapsed = performance.now() - lastSent
          if (elapsed >= 80) broadcast()
          else if (!timer) timer = setTimeout(broadcast, 80 - elapsed)
        }

        // A personal scratch calculator is fully local — no relay in or out.
        if (!personal) {
          cleanups.push(channel.on('calc', (m) => m.action === 'state' && m.state && applyRemote(m.state)))
          calc.observeEvent('change', onChange)
          cleanups.push(() => {
            if (timer) clearTimeout(timer)
            calc.unobserveEvent('change')
          })

          if (isHost) {
            const pushOpen = () => {
              channel.send({ type: 'calc', action: 'open' })
              syncedJSON = JSON.stringify(calc.getState())
              channel.send({ type: 'calc', action: 'state', state: JSON.parse(syncedJSON) })
              // Re-assert position/size so students sync even if the first geom
              // broadcast raced the socket opening (or after a reconnect).
              channel.send({ type: 'calc', action: 'geom', geom: geomRef.current })
            }
            pushOpen()
            cleanups.push(channel.on('open', pushOpen))
            cleanups.push(() => channel.send({ type: 'calc', action: 'close' }))
          } else if (initialState) {
            applyRemote(initialState)
          }
        }
      })
      .catch((e) => setError(e?.message ?? String(e)))

    return () => {
      disposed = true
      cleanups.forEach((fn) => fn())
      if (calcRef.current) {
        calcRef.current.destroy()
        calcRef.current = null
      }
    }
    // channel/isHost stable per mount; initialState read once; canEdit handled above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, isHost])

  return (
    <div
      ref={panelRef}
      className="calc-panel"
      style={{
        left: geom.x,
        top: geom.y,
        width: geom.w,
        height: geom.h,
        right: 'auto',
        bottom: 'auto',
        resize: geomEditable ? 'both' : 'none',
      }}
    >
      <div
        className={`calc-header${geomEditable ? ' draggable' : ''}`}
        onPointerDown={geomEditable ? startDrag : undefined}
      >
        <span className="calc-title">
          {personal ? 'My calculator' : `Desmos${!isHost && !canEdit ? ' · live' : ''}`}
        </span>
        {!isHost && canEdit && !personal && <span className="calc-badge">you can edit</span>}
      </div>
      <div className="calc-body">
        {error ? (
          <div className="calc-error">{error}</div>
        ) : (
          <>
            <div ref={mountRef} className="calc-desmos" />
            {!amEditor && <div className="calc-shield" />}
          </>
        )}
      </div>
      {isHost && (
        <div className="calc-access">
          <span className="calc-access-label">Students can edit</span>
          <button
            type="button"
            role="switch"
            aria-checked={studentsCanEdit}
            className={`calc-switch ${studentsCanEdit ? 'on' : ''}`}
            onClick={() => onToggleAccess?.(!studentsCanEdit)}
          >
            <span className="calc-switch-knob" />
          </button>
          <span className="calc-access-state">{studentsCanEdit ? 'On' : 'Off'}</span>
        </div>
      )}
    </div>
  )
}
