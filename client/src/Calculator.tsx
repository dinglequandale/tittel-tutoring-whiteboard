import { useEffect, useRef, useState } from 'react'
import { loadDesmos } from './desmos'
import type { ControlChannel } from './controlChannel'

export type Student = { id: string; name: string; canEdit: boolean }

// A floating Desmos panel.
//  - Tutor (host): always an editor. Changes are serialized with getState() and
//    broadcast; it also announces open/close. A footer lets the tutor grant or
//    revoke each connected student's edit access.
//  - Student (guest): a live mirror. By default a transparent shield keeps it
//    read-only. When the tutor grants access, the shield lifts and the student's
//    own edits broadcast back to everyone.
//
// Sync is symmetric: everyone applies incoming states, and every authorized
// editor broadcasts changes. Applied remote states are not re-broadcast (echo
// suppression), so concurrent edits settle last-writer-wins.
export function Calculator({
  channel,
  isHost,
  initialState,
  onClose,
  canEdit = false,
  students = [],
  onToggleGrant,
}: {
  channel: ControlChannel
  isHost: boolean
  initialState?: unknown
  onClose: () => void
  canEdit?: boolean
  students?: Student[]
  onToggleGrant?: (studentId: string, canEdit: boolean) => void
}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const calcRef = useRef<any>(null)
  const amEditorRef = useRef(isHost)
  const applyingRemoteRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const amEditor = isHost || canEdit

  // Reflect edit access without recreating the calculator: gate broadcasting and
  // lock/unlock the graph viewport for students.
  useEffect(() => {
    amEditorRef.current = amEditor
    calcRef.current?.updateSettings?.({ lockViewport: !amEditor })
  }, [amEditor])

  useEffect(() => {
    let disposed = false
    const cleanups: Array<() => void> = []
    let lastSentJSON = ''
    let lastSentTime = 0
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
          applyingRemoteRef.current = true
          calc.setState(state, { allowUndo: false })
          lastSentJSON = JSON.stringify(state) // don't echo what we just applied
          setTimeout(() => {
            applyingRemoteRef.current = false
          }, 0)
        }

        // Broadcast on change if we're an authorized editor. A 250ms safety-net
        // poll also catches graph pan/zoom (which doesn't fire 'change'). A JSON
        // diff prevents redundant sends; an 80ms throttle keeps the wire calm.
        const tryBroadcast = () => {
          if (!amEditorRef.current || applyingRemoteRef.current) return
          const state = calc.getState()
          const json = JSON.stringify(state)
          if (json === lastSentJSON) return
          const elapsed = performance.now() - lastSentTime
          if (elapsed >= 80) {
            lastSentJSON = json
            lastSentTime = performance.now()
            channel.send({ type: 'calc', action: 'state', state })
          } else if (!timer) {
            timer = setTimeout(() => {
              timer = null
              tryBroadcast()
            }, 80 - elapsed)
          }
        }

        // Everyone applies incoming states.
        cleanups.push(channel.on('calc', (m) => m.action === 'state' && m.state && applyRemote(m.state)))
        calc.observeEvent('change', tryBroadcast)
        const poll = setInterval(tryBroadcast, 250)
        cleanups.push(() => {
          clearInterval(poll)
          if (timer) clearTimeout(timer)
          calc.unobserveEvent('change')
        })

        if (isHost) {
          const pushOpen = () => {
            channel.send({ type: 'calc', action: 'open' })
            const state = calc.getState()
            lastSentJSON = JSON.stringify(state)
            channel.send({ type: 'calc', action: 'state', state })
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
    // channel/isHost are stable per mount; initialState read once; canEdit handled above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, isHost])

  return (
    <div className="calc-panel">
      <div className="calc-header">
        <span className="calc-title">Desmos{!isHost && !canEdit ? ' · live' : ''}</span>
        {isHost && (
          <button className="calc-close" onClick={onClose} aria-label="Close calculator">
            ✕
          </button>
        )}
      </div>
      <div className="calc-body">
        {error ? (
          <div className="calc-error">{error}</div>
        ) : (
          <>
            <div ref={mountRef} className="calc-desmos" />
            {/* Students without edit access get a transparent read-only shield. */}
            {!amEditor && <div className="calc-shield" />}
          </>
        )}
      </div>
      {isHost && (
        <div className="calc-roster">
          <span className="calc-roster-title">Calculator access</span>
          {students.length === 0 ? (
            <span className="calc-roster-empty">No students connected</span>
          ) : (
            <div className="calc-roster-list">
              {students.map((s) => (
                <button
                  key={s.id}
                  className={`calc-grant ${s.canEdit ? 'on' : ''}`}
                  onClick={() => onToggleGrant?.(s.id, !s.canEdit)}
                  title={s.canEdit ? 'Click to revoke editing' : 'Click to let this student edit'}
                >
                  <span className="calc-grant-dot" />
                  <span className="calc-grant-name">{s.name}</span>
                  <span className="calc-grant-state">{s.canEdit ? 'can edit' : 'view only'}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
