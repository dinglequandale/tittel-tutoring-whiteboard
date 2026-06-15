import { useEffect, useRef, useState } from 'react'
import { loadDesmos } from './desmos'
import type { ControlChannel } from './controlChannel'

// A floating Desmos panel.
//  - Tutor (host): a fully interactive calculator. Every change is serialized
//    with getState() and broadcast (throttled) over the control channel; it also
//    announces open/close so students' panels appear and disappear in sync.
//  - Student (guest): a live, read-only mirror — incoming states are applied with
//    setState(), and a transparent overlay blocks any local interaction.
export function Calculator({
  channel,
  isHost,
  initialState,
  onClose,
}: {
  channel: ControlChannel
  isHost: boolean
  initialState?: unknown
  onClose: () => void
}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let calc: any = null
    let disposed = false
    const cleanups: Array<() => void> = []

    loadDesmos()
      .then((Desmos) => {
        if (disposed || !mountRef.current) return
        calc = Desmos.GraphingCalculator(mountRef.current, {
          autosize: true,
          expressions: true,
          settingsMenu: isHost,
          // Students follow the tutor's view; the tutor can move freely.
          lockViewport: !isHost,
        })

        if (isHost) {
          // Announce the calculator is open + push current state right away.
          const pushOpen = () => {
            channel.send({ type: 'calc', action: 'open' })
            channel.send({ type: 'calc', action: 'state', state: calc.getState() })
          }
          pushOpen()
          // Re-announce on reconnect so late joiners and reconnects stay in sync.
          cleanups.push(channel.on('open', pushOpen))

          // Broadcast state on every change, throttled with a trailing send.
          let lastSent = 0
          let timer: ReturnType<typeof setTimeout> | null = null
          const flush = () => {
            timer = null
            lastSent = performance.now()
            channel.send({ type: 'calc', action: 'state', state: calc.getState() })
          }
          calc.observeEvent('change', () => {
            const elapsed = performance.now() - lastSent
            if (elapsed >= 80) flush()
            else if (!timer) timer = setTimeout(flush, 80 - elapsed)
          })
          cleanups.push(() => {
            if (timer) clearTimeout(timer)
            // Tell everyone the calculator closed when the tutor dismisses it.
            channel.send({ type: 'calc', action: 'close' })
          })
        } else {
          // Guest: apply the tutor's last-known state, then every live update.
          if (initialState) calc.setState(initialState, { allowUndo: false })
          cleanups.push(
            channel.on('calc', (m) => {
              if (m.action === 'state' && m.state && calc) {
                calc.setState(m.state, { allowUndo: false })
              }
            }),
          )
        }
      })
      .catch((e) => setError(e?.message ?? String(e)))

    return () => {
      disposed = true
      cleanups.forEach((fn) => fn())
      if (calc) calc.destroy()
    }
    // initialState is only read once on load; channel/isHost are stable per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, isHost])

  return (
    <div className="calc-panel">
      <div className="calc-header">
        <span className="calc-title">Desmos{isHost ? '' : ' · live'}</span>
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
            {/* Students get a transparent shield so the mirror stays read-only. */}
            {!isHost && <div className="calc-shield" />}
          </>
        )}
      </div>
    </div>
  )
}
