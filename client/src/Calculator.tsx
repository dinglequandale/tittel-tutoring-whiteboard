import { useEffect, useRef, useState } from 'react'
import { loadDesmos } from './desmos'
import type { ControlChannel } from './controlChannel'

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
  canEdit = false,
  studentsCanEdit = false,
  onToggleAccess,
}: {
  channel: ControlChannel
  isHost: boolean
  initialState?: unknown
  canEdit?: boolean
  studentsCanEdit?: boolean
  onToggleAccess?: (allow: boolean) => void
}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const calcRef = useRef<any>(null)
  const amEditorRef = useRef(isHost)
  const [error, setError] = useState<string | null>(null)

  const amEditor = isHost || canEdit

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
          }
          pushOpen()
          cleanups.push(channel.on('open', pushOpen))
          cleanups.push(() => channel.send({ type: 'calc', action: 'close' }))
        } else if (initialState) {
          applyRemote(initialState)
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
    <div className="calc-panel">
      <div className="calc-header">
        <span className="calc-title">Desmos{!isHost && !canEdit ? ' · live' : ''}</span>
        {!isHost && canEdit && <span className="calc-badge">you can edit</span>}
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
